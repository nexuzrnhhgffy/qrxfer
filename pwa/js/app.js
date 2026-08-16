const $ = (id) => document.getElementById(id);

const SUGGESTED_GRID = Beacon.SUGGESTED_GRID;
const SUGGESTED_FPS = 4;
const MAX_FILE_BYTES = Qxfer.MAX_FILE_BYTES;

let running = false;
let stream = null;
let playTimer = null;
let scanLoop = 0;
let meetLoop = 0;
let encoder = null;
let decoder = null;
let recoveredUrl = null;
let activeCode = null;
let lastPaint = null;

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

function setMeetCode(code) {
  const el = $("meetCode");
  if (!code) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = code;
}

function showHome() {
  running = false;
  lastPaint = null;
  meetLoop += 1;
  const code = activeCode;
  activeCode = null;
  if (code) {
    fetch("/api/sessions/" + code + "/cancel", { method: "POST" }).catch(() => {});
  }
  stopCamera();
  stopPlay();
  $("stage").hidden = true;
  $("home").hidden = false;
  $("guide").hidden = true;
  $("downloadLink").hidden = true;
  $("btnStart").hidden = true;
  setMeetCode("");
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

function cameraInfo() {
  const track = stream && stream.getVideoTracks()[0];
  const s = track ? track.getSettings() : {};
  return {
    camFps: s.frameRate || 30,
    width: s.width || $("cam").videoWidth || 1280,
  };
}

async function api(path, body) {
  const opts = { headers: { "Content-Type": "application/json" } };
  if (body !== undefined) {
    opts.method = "POST";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("API " + res.status));
  return data;
}

async function waitSession(code, pred, timeoutMs) {
  const my = ++meetLoop;
  const deadline = Date.now() + timeoutMs;
  while (running && my === meetLoop) {
    const sess = await api("/api/sessions/" + code);
    if (sess.status === "error") throw new Error(sess.error || "نشست قطع شد");
    if (pred(sess)) return sess;
    if (Date.now() > deadline) throw new Error("زمان نشست تمام شد");
    await sleep(400);
  }
  throw new Error("stopped");
}

$("btnSend").addEventListener("click", () => $("fileInput").click());
$("btnRecv").addEventListener("click", () => {
  const code = ($("joinCode").value || "").trim();
  startReceive(code).catch(fail);
});
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
  if (msg === "stopped") return;
  hud(msg);
  homeError(msg);
}

function fitCanvas(split) {
  const canvas = $("qrCanvas");
  const css = Beacon.canvasSize(!!split);
  const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
  canvas.style.width = css + "px";
  canvas.style.height = css + "px";
  canvas.width = Math.round(css * dpr);
  canvas.height = Math.round(css * dpr);
  return canvas;
}

function drawControl(text, gridN) {
  lastPaint = function () { drawControl(text, gridN); };
  const canvas = fitCanvas($("stage").classList.contains("split"));
  Beacon.drawGrid(canvas, Beacon.encodeControl(text, gridN || Beacon.HANDSHAKE_GRID));
}

function drawData(packet, gridN) {
  lastPaint = function () { drawData(packet, gridN); };
  const canvas = fitCanvas(false);
  Beacon.drawGrid(canvas, Beacon.encodeData(packet, gridN));
}

function helloPayload(sess, extra) {
  return Object.assign({
    j: sess.code,
    s: sess.optical,
    t: sess.compressed,
    o: sess.orig,
    n: sess.name,
    v: sess.grid || sess.suggest_grid,
    g: sess.grid || sess.suggest_grid,
    f: sess.fps || sess.suggest_fps,
    k: sess.k || 0,
  }, extra || {});
}

async function startSend(file) {
  running = true;
  showStage("full");
  hud("در حال بیشترین فشرده‌سازی بدون‌اتلاف…");
  const data = new Uint8Array(await file.arrayBuffer());
  const compressed = await lzmaCompress(data);
  const optical = (Math.random() * 0xffffffff) >>> 0 || 1;
  const ratio = ((1 - compressed.length / Math.max(1, data.length)) * 100).toFixed(0);
  let sess = await api("/api/sessions", {
    name: file.name,
    orig: data.length,
    compressed: compressed.length,
    grid: SUGGESTED_GRID,
    fps: SUGGESTED_FPS,
    optical: optical,
  });
  activeCode = sess.code;
  setMeetCode(sess.code);
  hud(`فشرده شد ${ratio}٪ — کد را به گیرنده بده و صبر کن`);
  drawControl(Qxfer.encodeHello(helloPayload(sess)), Beacon.HANDSHAKE_GRID);

  sess = await waitSession(sess.code, (s) => s.status === "joined" || s.status === "sending", 180000);
  if (!running) return;
  const grid = sess.grid || SUGGESTED_GRID;
  const fps = sess.fps || SUGGESTED_FPS;
  const blockSize = Beacon.blockSizeForGrid(grid);
  encoder = new Qxfer.TransferEncoder(file.name, data, blockSize, optical, () => compressed);
  sess = await api("/api/sessions/" + sess.code + "/offer", { k: encoder.k, optical: optical });
  hud("گیرنده وصل شد — منتظر «شروع کن»");
  drawControl(Qxfer.encodeHello(helloPayload(sess)), Beacon.HANDSHAKE_GRID);

  sess = await waitSession(sess.code, (s) => s.status === "sending" || s.status === "done", 180000);
  if (!running) return;
  if (sess.status === "done") return;
  setMeetCode("");
  hud("هماهنگ شد — شروع ارسال");
  drawControl(Qxfer.encodeGo(helloPayload(sess, { type: "G" })), Beacon.HANDSHAKE_GRID);
  await sleep(900);
  if (!running) return;
  for (let n = 3; n >= 1; n--) {
    drawSolid(String(n));
    hud(`شروع با ${fps} فریم در ثانیه · شبکه ${grid}`);
    await sleep(650);
    if (!running) return;
  }
  playData(grid, fps, sess.code);
}

function playData(grid, fps, code) {
  let seq = 0;
  const my = meetLoop;
  const tick = async () => {
    if (!running || !encoder || my !== meetLoop) return;
    try {
      const sess = await api("/api/sessions/" + code);
      if (sess.status === "done") {
        drawSolid("✓");
        hud("گیرنده فایل را کامل گرفت");
        stopPlay();
        return;
      }
      if (sess.status === "error") throw new Error(sess.error || "نشست قطع شد");
      drawData(encoder.packet(seq), grid);
      const rec = (sess.progress && sess.progress.recovered) || 0;
      const kk = (sess.progress && sess.progress.k) || encoder.k;
      hud(`${encoder.filename}  ·  ${seq + 1}  ·  دریافت ${rec}/${kk}`);
      seq += 1;
    } catch (err) {
      fail(err);
      return;
    }
    playTimer = setTimeout(tick, 1000 / fps);
  };
  tick();
}

async function startReceive(typedCode) {
  running = true;
  decoder = new Qxfer.TransferDecoder(inflateSource);
  $("btnStart").hidden = true;
  showStage("scan");
  hud("دوربین را باز می‌کنم…");
  try {
    await startCamera();
  } catch (err) {
    throw new Error("دوربین روی این آدرس باز نشد. از گوشی آدرس USB لپ‌تاپ را بزنید، یا USB debugging را روشن کنید تا http://127.0.0.1:8080 کار کند.");
  }
  const cam = cameraInfo();
  let code = (typedCode || "").trim().toUpperCase();
  if (!code) {
    hud("کد سبز فرستنده را اسکن کن یا کد نشست را وارد کن");
    const hello = await scanUntil((msg) => msg && msg.type === "H" && (msg.j || msg.s), 120000, {
      grids: [32, 28, 36, 24],
    });
    if (!running) return;
    code = hello.j || "";
    if (!code) throw new Error("کد نشست در تصویر نبود");
  }
  let sess = await api("/api/sessions/" + code + "/join", cam);
  activeCode = sess.code;
  $("joinCode").value = sess.code;
  hud(`${sess.name || "فایل"} — وقتی آماده بودی شروع کن`);
  await waitSession(sess.code, (s) => s.k, 120000);
  if (!running) return;
  $("btnStart").hidden = false;
  await new Promise((resolve, reject) => {
    const my = meetLoop;
    const btn = $("btnStart");
    const onClick = () => {
      btn.removeEventListener("click", onClick);
      resolve();
    };
    btn.addEventListener("click", onClick);
    const watch = async () => {
      try {
        while (running && my === meetLoop) {
          const s = await api("/api/sessions/" + sess.code);
          if (s.status === "sending" || s.status === "done") {
            btn.removeEventListener("click", onClick);
            resolve();
            return;
          }
          if (s.status === "error") throw new Error(s.error || "نشست قطع شد");
          await sleep(400);
        }
        reject(new Error("stopped"));
      } catch (err) {
        btn.removeEventListener("click", onClick);
        reject(err);
      }
    };
    watch();
  });
  if (!running) return;
  $("btnStart").hidden = true;
  sess = await api("/api/sessions/" + sess.code + "/start", {});
  hud("قفل شد. در حال خواندن داده…");
  await collectData(sess);
}

async function collectData(sess) {
  const fpsHint = sess.fps || SUGGESTED_FPS;
  let lastPost = 0;
  await scanUntil((msg) => {
    if (!running) return true;
    if (decoder.ready()) return true;
    const k = decoder.lt.k;
    const rec = decoder.lt.recoveredCount;
    if (k) hud(`دریافت ${rec}/${k}  ·  ${fpsHint} fps`);
    const now = Date.now();
    if (k && now - lastPost > 700) {
      lastPost = now;
      api("/api/sessions/" + sess.code + "/progress", {
        recovered: rec,
        k: k,
      }).catch(() => {});
    }
    return false;
  }, 300000, {
    ingestData: true,
    grids: [sess.grid, 32, 40, 36, 28, 24, 48, 56].filter((n, i, arr) => n && n >= 24 && arr.indexOf(n) === i),
  });

  if (!running) return;
  if (!decoder.ready()) decoder.lt.finish();
  if (!decoder.ready()) {
    await api("/api/sessions/" + sess.code + "/done", { ok: false, error: "incomplete" });
    throw new Error("فایل کامل نشد. نزدیک‌تر بایستید و تکرار کنید.");
  }
  hud("در حال باز کردن فایل…");
  const file = await decoder.result();
  await api("/api/sessions/" + sess.code + "/done", { ok: true });
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
  lastPaint = function () { drawSolid(text); };
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

function onViewportChange() {
  if (!running || $("stage").hidden) return;
  if ($("qrCanvas").style.display === "none") return;
  if (typeof lastPaint === "function") lastPaint();
}

window.addEventListener("resize", onViewportChange);
window.addEventListener("orientationchange", onViewportChange);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", onViewportChange);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

fetch("/api/info")
  .then((r) => r.json())
  .then((info) => {
    const el = $("lanHint");
    if (!el) return;
    const urls = (info.phone || []).concat(info.adb ? ["http://127.0.0.1:" + info.port + "/"] : []);
    if (info.phone && info.phone.length) {
      el.textContent = "از گوشی این آدرس را باز کنید:\n" + info.phone.join("\n");
      el.style.whiteSpace = "pre-line";
    } else {
      el.textContent = "از گوشی آدرس IP لپ‌تاپ روی USB را بزنید، نه 127.0.0.1";
    }
  })
  .catch(() => {});
