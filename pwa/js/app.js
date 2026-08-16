const $ = (id) => document.getElementById(id);

const SUGGESTED_VERSION = 18;
const SUGGESTED_FPS = 5;

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
    LZMA_API.compress(Array.from(bytes), 9, (res, err) => {
      if (err) reject(err);
      else resolve(res instanceof Uint8Array ? res : Uint8Array.from(res));
    });
  });
}

function lzmaDecompress(bytes) {
  return new Promise((resolve, reject) => {
    LZMA_API.decompress(Array.from(bytes), (res, err) => {
      if (err) reject(err);
      else if (typeof res === "string") resolve(new TextEncoder().encode(res));
      else resolve(res instanceof Uint8Array ? res : Uint8Array.from(res));
    });
  });
}

function inflateSource(compressed, version) {
  if (version >= 2) return lzmaDecompress(compressed);
  return Promise.resolve(pako.inflate(compressed));
}

function hud(text) {
  $("hud").textContent = text || "";
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

function cameraInfo() {
  const track = stream && stream.getVideoTracks()[0];
  const s = track ? track.getSettings() : {};
  return {
    camFps: s.frameRate || 30,
    width: s.width || $("cam").videoWidth || 1280,
  };
}

$("btnSend").addEventListener("click", () => $("fileInput").click());
$("btnRecv").addEventListener("click", () => startReceive().catch(fail));
$("btnClose").addEventListener("click", showHome);
$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (file) startSend(file).catch(fail);
});

function fail(err) {
  console.error(err);
  hud(err && err.message ? err.message : String(err));
}

async function startSend(file) {
  running = true;
  showStage("full");
  hud("در حال بیشترین فشرده‌سازی بدون‌اتلاف…");
  const data = new Uint8Array(await file.arrayBuffer());
  const compressed = await lzmaCompress(data);
  const sessionId = (Math.random() * 0xffffffff) >>> 0 || 1;
  const ratio = ((1 - compressed.length / Math.max(1, data.length)) * 100).toFixed(0);
  const hello = {
    s: sessionId,
    t: 0,
    o: data.length,
    c: compressed.length,
    n: file.name,
    v: SUGGESTED_VERSION,
    f: SUGGESTED_FPS,
  };
  // t (source length) is filled after wrapping header+payload
  const sourceProbe = Qxfer.buildSource(file.name, data, () => compressed);
  hello.t = sourceProbe.length;

  showStage("split");
  await startCamera();
  hud(`فشرده شد ${ratio}٪ — کد مشخصات را به گیرنده نشان بده`);
  await drawTextQr(Qxfer.encodeHello(hello));

  const ack = await scanUntil((msg) => msg && msg.type === "A" && msg.s === sessionId, 120000);
  if (!running) return;
  const agreed = Qxfer.agreeParams(hello.v, hello.f, ack.cf, ack.w);
  const blockSize = Qxfer.blockSizeForVersion(agreed.qrVersion);
  encoder = new Qxfer.TransferEncoder(file.name, data, blockSize, sessionId, () => compressed);

  showStage("full");
  stopCamera();
  hud("هماهنگ شد — آماده ارسال");
  await drawTextQr(Qxfer.encodeGo({ s: sessionId, v: agreed.qrVersion, f: agreed.fps, k: encoder.k }));
  await sleep(1200);
  for (let n = 3; n >= 1; n--) {
    drawSolid(String(n));
    hud(`شروع با ${agreed.fps} فریم در ثانیه`);
    await sleep(700);
  }
  await playData(agreed.qrVersion, agreed.fps);
}

async function playData(version, fps) {
  let seq = 0;
  const tick = async () => {
    if (!running || !encoder) return;
    try {
      await drawDataQr(encoder.packet(seq), version);
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
  hud("دوربین را روی کد مشخصات فرستنده بگیر");
  await startCamera();
  const hello = await scanUntil((msg) => msg && msg.type === "H", 120000);
  if (!running) return;

  const cam = cameraInfo();
  const agreed = Qxfer.agreeParams(hello.v, hello.f, cam.camFps, cam.width);
  const ack = {
    s: hello.s,
    cf: cam.camFps,
    w: cam.width,
    v: agreed.qrVersion,
    f: agreed.fps,
  };
  showStage("split");
  hud("این کد را به فرستنده نشان بده تا سرعت‌ها یکی شود");
  await drawTextQr(Qxfer.encodeAck(ack));
  await sleep(2500);
  showStage("scan");
  hud("قفل شد. در حال خواندن داده…");
  await collectData(hello.s, agreed);
}

async function collectData(sessionId, agreed) {
  const started = Date.now();
  await scanUntil(() => {
    if (!running) return true;
    if (decoder.ready()) return true;
    const k = decoder.lt.k;
    const rec = decoder.lt.recoveredCount;
    if (k) hud(`دریافت ${rec}/${k}  ·  ${agreed.fps} fps`);
    return false;
  }, 300000, { ingestData: true, sessionId: sessionId });

  if (!running) return;
  if (!decoder.ready()) {
    decoder.lt.finish();
  }
  if (!decoder.ready()) {
    throw new Error("فایل کامل نشد. دوباره روبروی صفحه بایستید و تکرار کنید.");
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
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log("received in", elapsed, "s");
}

function scanUntil(predicate, timeoutMs, opts) {
  const myLoop = ++scanLoop;
  const ingestData = opts && opts.ingestData;
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
        const payloads = decodeFrame(ctx, canvas);
        for (let i = 0; i < payloads.length; i++) {
          const item = payloads[i];
          const control = Qxfer.parseControl(item.text);
          if (control && predicate(control)) {
            resolve(control);
            return;
          }
          if (ingestData && item.bytes) decoder.ingest(item.bytes);
        }
        if (predicate(null)) {
          resolve(null);
          return;
        }
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(step);
      else requestAnimationFrame(step);
    };
    step();
  });
}

function decodeFrame(ctx, canvas) {
  const crops = [
    [0, 0, canvas.width, canvas.height],
    crop(canvas, 0.12),
    crop(canvas, 0.2),
  ];
  const out = [];
  for (let c = 0; c < crops.length; c++) {
    const [x, y, w, h] = crops[c];
    if (w < 16 || h < 16) continue;
    const imageData = ctx.getImageData(x, y, w, h);
    try {
      const code = jsQR(imageData.data, w, h, { inversionAttempts: "attemptBoth" });
      if (code) out.push({ text: code.data, bytes: bytesFromJsQR(code) });
    } catch (e) {}
    const zx = decodeZxing(imageData);
    if (zx) out.push(zx);
  }
  return out;
}

function crop(canvas, inset) {
  const x = Math.floor(canvas.width * inset);
  const y = Math.floor(canvas.height * inset);
  return [x, y, canvas.width - 2 * x, canvas.height - 2 * y];
}

function bytesFromJsQR(code) {
  if (code.binaryData && code.binaryData.length) return Uint8Array.from(code.binaryData);
  if (typeof code.data === "string") {
    const b = new Uint8Array(code.data.length);
    for (let i = 0; i < code.data.length; i++) b[i] = code.data.charCodeAt(i) & 0xff;
    return b;
  }
  return null;
}

function decodeZxing(imageData) {
  if (typeof ZXing === "undefined") return null;
  try {
    const lum = new Uint8ClampedArray(imageData.width * imageData.height);
    const src = imageData.data;
    for (let i = 0, j = 0; i < src.length; i += 4, j++) {
      lum[j] = (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) | 0;
    }
    const source = new ZXing.RGBLuminanceSource(lum, imageData.width, imageData.height);
    const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.QR_CODE]);
    hints.set(ZXing.DecodeHintType.CHARACTER_SET, "ISO-8859-1");
    const result = new ZXing.QRCodeReader().decode(bitmap, hints);
    const raw = result.getRawBytes && result.getRawBytes();
    const text = result.getText && result.getText();
    const bytes = raw && raw.length ? (raw instanceof Uint8Array ? raw : Uint8Array.from(raw)) : null;
    return { text: text, bytes: bytes };
  } catch (e) {
    return null;
  }
}

async function drawTextQr(text) {
  const canvas = $("qrCanvas");
  const size = Math.min(window.innerWidth, window.innerHeight / ($("stage").classList.contains("split") ? 2 : 1)) - 8;
  canvas.width = size;
  canvas.height = size;
  const tmp = document.createElement("canvas");
  await QRCode.toCanvas(tmp, text, {
    errorCorrectionLevel: "M",
    margin: 3,
    width: 640,
    color: { dark: "#000000", light: "#ffffff" },
  });
  paintFramed(canvas, tmp);
}

async function drawDataQr(packet, version) {
  const canvas = $("qrCanvas");
  const size = Math.min(window.innerWidth, window.innerHeight) - 8;
  canvas.width = size;
  canvas.height = size;
  const tmp = document.createElement("canvas");
  await QRCode.toCanvas(
    tmp,
    [{ data: new Uint8ClampedArray(packet), mode: "byte" }],
    {
      errorCorrectionLevel: "L",
      version: version,
      margin: 4,
      width: 720,
      color: { dark: "#000000", light: "#ffffff" },
    }
  );
  paintFramed(canvas, tmp);
}

function paintFramed(dest, qrCanvas) {
  const ctx = dest.getContext("2d");
  const size = dest.width;
  ctx.fillStyle = "#00e676";
  ctx.fillRect(0, 0, size, size);
  const border = Math.max(22, Math.floor(size * 0.05));
  const inner = size - border * 2;
  ctx.fillStyle = "#fff";
  ctx.fillRect(border, border, inner, inner);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qrCanvas, border, border, inner, inner);
}

function drawSolid(text) {
  const canvas = $("qrCanvas");
  const size = Math.min(window.innerWidth, window.innerHeight) - 8;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
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
