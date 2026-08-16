const $ = (id) => document.getElementById(id);

const SUGGESTED_GRID = Beacon.SUGGESTED_GRID;
const SUGGESTED_FPS = 4;
const MAX_FILE_BYTES = Qxfer.MAX_FILE_BYTES;

let running = false;
let stream = null;
let playTimer = null;
let scanLoop = 0;
let encoder = null;
let decoder = null;
let recoveredUrl = null;

const LZMA_API = window.LZMA || window.LZMA_WORKER;

function lzmaCompress(bytes) {
  return new Promise((resolve, reject) => {
    if (!LZMA_API || !LZMA_API.compress) {
      reject(new Error("LZMA در دسترس نیست"));
      return;
    }
    LZMA_API.compress(bytes, 9, (res, err) => {
      if (err) reject(err);
      else resolve(res instanceof Uint8Array ? res : Uint8Array.from(res));
    });
  });
}

function lzmaDecompress(bytes) {
  return new Promise((resolve, reject) => {
    LZMA_API.decompress(bytes, (res, err) => {
      if (err) reject(err);
      else if (typeof res === "string") resolve(new TextEncoder().encode(res));
      else resolve(res instanceof Uint8Array ? res : Uint8Array.from(res));
    });
  });
}

function inflateSource(compressed, version) {
  return lzmaDecompress(compressed);
}

function hud(text) {
  $("hud").textContent = text || "";
}

function homeError(text) {
  const el = $("homeError");
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = text;
}

function showHome() {
  running = false;
  stopCamera();
  stopPlay();
  $("stage").hidden = true;
  $("home").hidden = false;
  $("guide").hidden = true;
  $("downloadLink").hidden = true;
  if (recoveredUrl) {
    URL.revokeObjectURL(recoveredUrl);
    recoveredUrl = null;
  }
}

function showStage(mode) {
  $("home").hidden = true;
  $("stage").hidden = false;
  $("stage").classList.remove("full", "scan", "split");
  $("stage").classList.add(mode);
  $("guide").hidden = mode !== "scan";
  $("cam").style.display = mode === "full" ? "none" : "block";
  $("qrCanvas").style.display = mode === "scan" ? "none" : "block";
}

async function startCamera() {
  if (stream) return stream;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
  });
  $("cam").srcObject = stream;
  await $("cam").play();
  const track = stream.getVideoTracks()[0];
  try {
    await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
  } catch (e) {}
  return stream;
}

function stopCamera() {
  scanLoop += 1;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $("cam").srcObject = null;
}

function stopPlay() {
  if (playTimer) clearTimeout(playTimer);
  playTimer = null;
  encoder = null;
}

$("btnSend").addEventListener("click", () => $("fileInput").click());
$("btnRecv").addEventListener("click", () => startReceive().catch(fail));
$("btnClose").addEventListener("click", showHome);
$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    homeError("فایل بزرگ‌تر از ۱ گیگابایت مجاز نیست");
    return;
  }
  homeError("");
  startSend(file).catch(fail);
});

function fail(err) {
  console.error(err);
  const msg = err && err.message ? err.message : String(err);
  hud(msg);
  homeError(msg);
}

function fitCanvas(split) {
  const canvas = $("qrCanvas");
  const size = Beacon.canvasSize(split);
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function drawControl(text, gridN) {
  const canvas = fitCanvas($("stage").classList.contains("split"));
  Beacon.drawGrid(canvas, Beacon.encodeControl(text, gridN || Beacon.HANDSHAKE_GRID));
}

function drawData(packet, gridN) {
  const canvas = fitCanvas(false);
  Beacon.drawGrid(canvas, Beacon.encodeData(packet, gridN));
}

async function startSend(file) {
  running = true;
  showStage("full");
  hud("در حال بیشترین فشرده‌سازی بدون‌اتلاف…");
  const data = new Uint8Array(await file.arrayBuffer());
  const compressed = await lzmaCompress(data);
  const sessionId = (Math.random() * 0xffffffff) >>> 0 || 1;
  const ratio = ((1 - compressed.length / Math.max(1, data.length)) * 100).toFixed(0);
  const sourceProbe = Qxfer.buildSource(file.name, data, () => compressed);
  const grid = SUGGESTED_GRID;
  const fps = SUGGESTED_FPS;
  const blockSize = Beacon.blockSizeForGrid(grid);
  encoder = new Qxfer.TransferEncoder(file.name, data, blockSize, sessionId, () => compressed);

  hud(`فشرده شد ${ratio}٪ — این کد را به گیرنده نشان بده`);
  drawControl(Qxfer.encodeHello({
    s: sessionId,
    t: sourceProbe.length,
    o: data.length,
    c: compressed.length,
    n: file.name,
    v: grid,
    g: grid,
    f: fps,
    k: encoder.k,
  }), Beacon.HANDSHAKE_GRID);
  await sleep(2500);
  if (!running) return;

  hud("آماده ارسال");
  drawControl(Qxfer.encodeGo({ s: sessionId, v: grid, g: grid, f: fps, k: encoder.k }), Beacon.HANDSHAKE_GRID);
  await sleep(1200);
  if (!running) return;
  for (let n = 3; n >= 1; n--) {
    drawSolid(String(n));
    hud(`شروع با ${fps} فریم در ثانیه · شبکه ${grid}`);
    await sleep(700);
    if (!running) return;
  }
  playData(grid, fps);
}

function playData(grid, fps) {
  let seq = 0;
  const tick = () => {
    if (!running || !encoder) return;
    try {
      drawData(encoder.packet(seq), grid);
      hud(`${encoder.filename}  ·  ${seq + 1}  ·  ${fps} fps`);
      seq += 1;
    } catch (err) {
      fail(err);
      return;
    }
    playTimer = setTimeout(tick, 1000 / fps);
  };
  tick();
}

async function startReceive() {
  running = true;
  decoder = new Qxfer.TransferDecoder(inflateSource);
  showStage("scan");
  hud("دوربین را روی کد سبز فرستنده بگیر");
  await startCamera();
  await collectData();
}

async function collectData() {
  let fpsHint = SUGGESTED_FPS;
  await scanUntil((msg) => {
    if (!running) return true;
    if (msg && msg.type === "H") {
      fpsHint = msg.f || fpsHint;
      hud(`قفل شد${msg.n ? " · " + msg.n : ""} — در حال خواندن داده…`);
    }
    if (msg && msg.type === "G") {
      fpsHint = msg.f || fpsHint;
    }
    if (decoder.ready()) return true;
    const k = decoder.lt.k;
    const rec = decoder.lt.recoveredCount;
    if (k) hud(`دریافت ${rec}/${k}  ·  ${fpsHint} fps`);
    return false;
  }, 300000, {
    ingestData: true,
    grids: [32, 40, 36, 28, 24, 48, 56],
  });

  if (!running) return;
  if (!decoder.ready()) decoder.lt.finish();
  if (!decoder.ready()) {
    throw new Error("فایل کامل نشد. نزدیک‌تر بایستید و تکرار کنید.");
  }
  hud("در حال باز کردن فایل…");
  const file = await decoder.result();
  const blob = new Blob([file.data]);
  recoveredUrl = URL.createObjectURL(blob);
  const link = $("downloadLink");
  link.href = recoveredUrl;
  link.download = file.name;
  link.hidden = false;
  showStage("full");
  stopCamera();
  drawSolid("✓");
  hud(`${file.name} — ${(file.data.length / 1024).toFixed(1)} کیلوبایت`);
}

function scanUntil(predicate, timeoutMs, opts) {
  const myLoop = ++scanLoop;
  const ingestData = opts && opts.ingestData;
  const grids = opts && opts.grids;
  const deadline = Date.now() + timeoutMs;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const video = $("cam");

  return new Promise((resolve, reject) => {
    const step = () => {
      if (!running || myLoop !== scanLoop) return;
      if (Date.now() > deadline) {
        reject(new Error("زمان هماهنگی تمام شد"));
        return;
      }
      if (video.readyState >= 2) {
        const scale = Math.min(1, 960 / Math.max(video.videoWidth, 1));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const got = Beacon.decodeImageData(imageData, grids);
        let control = null;
        if (got) {
          if (got.kind === Beacon.TYPE_CONTROL) {
            const text = new TextDecoder("utf-8").decode(got.data);
            control = Qxfer.parseControl(text);
          } else if (ingestData && got.kind === Beacon.TYPE_DATA) {
            decoder.ingest(got.data);
          }
        }
        if (predicate(control)) {
          resolve(control);
          return;
        }
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(step);
      else requestAnimationFrame(step);
    };
    step();
  });
}

function drawSolid(text) {
  const canvas = fitCanvas(false);
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  ctx.fillStyle = "#00e676";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  ctx.font = `bold ${Math.floor(size / 3)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, size / 2);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
