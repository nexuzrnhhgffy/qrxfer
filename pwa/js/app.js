const $ = (id) => document.getElementById(id);

const deflateFn = (data) => pako.deflate(data, { level: 9 });
const inflateFn = (data) => pako.inflate(data);

let sendFile = null;
let playTimer = null;
let playSeq = 0;
let encoder = null;
let playVersion = 18;
let playFps = 5;

let stream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recording = false;
let lockLoopOn = false;
let decoder = null;
let recovered = null;
let torchOn = false;

function setTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
  });
  $("sendPanel").hidden = name !== "send";
  $("receivePanel").hidden = name !== "receive";
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setTab(tab.dataset.tab));
});

$("sendFile").addEventListener("change", async (e) => {
  sendFile = e.target.files[0] || null;
  $("playBtn").disabled = !sendFile;
  if (!sendFile) {
    $("sendFileLabel").textContent = "انتخاب فایل";
    $("sendMeta").textContent = "فایل را انتخاب کنید.";
    return;
  }
  $("sendFileLabel").textContent = sendFile.name;
  const preset = Qxfer.PRESETS[$("preset").value];
  const block = Qxfer.blockSizeForVersion(preset.qrVersion);
  const k = Math.max(1, Math.ceil(sendFile.size / block));
  const seconds = Math.ceil((k * 1.7) / preset.fps);
  $("sendMeta").textContent =
    `${(sendFile.size / 1024).toFixed(1)} کیلوبایت ≈ ${k} بلوک — حدود ${seconds} ثانیه پخش با تکرار.`;
});

$("playBtn").addEventListener("click", startPlayback);
$("stopPlayBtn").addEventListener("click", stopPlayback);
$("exitPlay").addEventListener("click", stopPlayback);

async function startPlayback() {
  if (!sendFile) return;
  const presetName = $("preset").value;
  const preset = Qxfer.PRESETS[presetName];
  playVersion = preset.qrVersion;
  playFps = preset.fps;
  const buf = new Uint8Array(await sendFile.arrayBuffer());
  const sessionId = (Math.random() * 0xffffffff) >>> 0 || 1;
  const blockSize = Qxfer.blockSizeForVersion(playVersion);
  encoder = new Qxfer.TransferEncoder(sendFile.name, buf, blockSize, sessionId, deflateFn);
  playSeq = 0;
  $("playOverlay").hidden = false;
  $("stopPlayBtn").hidden = false;
  try {
    await document.documentElement.requestFullscreen?.();
  } catch (e) {}
  const canvas = $("qrCanvas");
  const hud = $("playHud");
  for (let n = 3; n >= 1; n--) {
    drawSolid(canvas, String(n));
    hud.textContent = "دوربین را قفل کنید";
    await sleep(800);
  }
  const tick = async () => {
    if (!encoder) return;
    try {
      const packet = encoder.packet(playSeq);
      await drawQrFrame(canvas, packet, playVersion);
      hud.textContent = `${sendFile.name}  ·  ${playSeq + 1}  ·  k=${encoder.k}`;
      playSeq += 1;
    } catch (err) {
      hud.textContent = "خطا در ساخت QR: " + err.message;
      console.error(err);
    }
    playTimer = setTimeout(tick, 1000 / playFps);
  };
  tick();
}

function stopPlayback() {
  if (playTimer) clearTimeout(playTimer);
  playTimer = null;
  encoder = null;
  $("playOverlay").hidden = true;
  $("stopPlayBtn").hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function drawSolid(canvas, text) {
  const size = Math.min(window.innerWidth, window.innerHeight) - 16;
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

async function drawQrFrame(canvas, packet, version) {
  const qrCanvas = document.createElement("canvas");
  await QRCode.toCanvas(
    qrCanvas,
    [{ data: new Uint8ClampedArray(packet), mode: "byte" }],
    {
      errorCorrectionLevel: "L",
      version: version,
      margin: 4,
      width: 720,
      color: { dark: "#000000", light: "#ffffff" },
    }
  );
  const size = Math.min(window.innerWidth, window.innerHeight) - 16;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#00e676";
  ctx.fillRect(0, 0, size, size);
  const border = Math.max(24, Math.floor(size * 0.045));
  const inner = size - border * 2;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(border, border, inner, inner);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qrCanvas, border, border, inner, inner);
}

$("camBtn").addEventListener("click", async () => {
  if (stream) {
    stopCamera();
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
    });
    const track = stream.getVideoTracks()[0];
    try {
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    } catch (e) {}
    $("liveVideo").srcObject = stream;
    await $("liveVideo").play();
    $("camBtn").textContent = "خاموش کردن دوربین";
    $("recordBtn").disabled = false;
    $("torchBtn").disabled = !track.getCapabilities || !track.getCapabilities().torch;
    lockLoopOn = true;
    lockLoop();
    setRecvStatus("کادر را روی حاشیه سبز QR منطبق کنید تا قفل شود.");
  } catch (err) {
    setRecvStatus("دسترسی دوربین ممکن نشد: " + err.message, "error");
  }
});

$("torchBtn").addEventListener("click", async () => {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  torchOn = !torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
  } catch (e) {
    setRecvStatus("چراغ در این دستگاه در دسترس نیست");
  }
});

$("recordBtn").addEventListener("click", () => {
  if (recording) stopRecording();
  else startRecording();
});

$("videoFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) analyzeBlob(file);
});

$("downloadBtn").addEventListener("click", () => {
  if (!recovered) return;
  const url = URL.createObjectURL(new Blob([recovered.data]));
  const a = document.createElement("a");
  a.href = url;
  a.download = recovered.name;
  a.click();
  URL.revokeObjectURL(url);
});

function stopCamera() {
  lockLoopOn = false;
  if (recording) stopRecording();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $("liveVideo").srcObject = null;
  $("camBtn").textContent = "روشن کردن دوربین";
  $("recordBtn").disabled = true;
  $("torchBtn").disabled = true;
  $("lockBadge").textContent = "در انتظار قفل";
  $("lockBadge").classList.remove("locked");
}

function pickMime() {
  const types = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
}

function startRecording() {
  recordedChunks = [];
  const opts = { videoBitsPerSecond: 12000000 };
  const mime = pickMime();
  if (mime) opts.mimeType = mime;
  mediaRecorder = new MediaRecorder(stream, opts);
  mediaRecorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size) recordedChunks.push(ev.data);
  };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "video/webm" });
    analyzeBlob(blob);
  };
  mediaRecorder.start(200);
  recording = true;
  $("recordBtn").textContent = "توقف و تحلیل";
  $("recordBtn").classList.add("hot");
  setRecvStatus("در حال ضبط... وقتی چند دور از QR پخش شد، توقف را بزنید.");
}

function stopRecording() {
  recording = false;
  $("recordBtn").textContent = "شروع ضبط";
  $("recordBtn").classList.remove("hot");
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}

function lockLoop() {
  if (!lockLoopOn) return;
  const video = $("liveVideo");
  const overlay = $("overlay");
  if (video.readyState >= 2) {
    const w = 320;
    const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
    overlay.width = w;
    overlay.height = h;
    const ctx = overlay.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const region = detectGreenLock(imageData);
    const badge = $("lockBadge");
    if (region) {
      badge.textContent = "قفل شد";
      badge.classList.add("locked");
      document.querySelector(".scan-guide").classList.add("locked");
    } else {
      badge.textContent = recording ? "ضبط بدون قفل" : "در انتظار قفل";
      badge.classList.remove("locked");
      document.querySelector(".scan-guide").classList.remove("locked");
    }
  }
  const videoEl = $("liveVideo");
  if (videoEl.requestVideoFrameCallback) {
    videoEl.requestVideoFrameCallback(() => lockLoop());
  } else {
    requestAnimationFrame(lockLoop);
  }
}

function detectGreenLock(imageData) {
  const { width, height, data } = imageData;
  let minX = width, minY = height, maxX = 0, maxY = 0, count = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (g > 90 && g > r + 28 && g > b + 28) {
        count++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bw = maxX - minX, bh = maxY - minY;
  const ratio = bw / Math.max(1, bh);
  const area = bw * bh;
  if (count < 60 || ratio < 0.68 || ratio > 1.45 || area < width * height * 0.06) {
    return null;
  }
  return { x: minX, y: minY, w: bw, h: bh };
}

async function analyzeBlob(blob) {
  decoder = new Qxfer.TransferDecoder(inflateFn);
  recovered = null;
  $("resultBox").hidden = true;
  setRecvStatus("ضبط تمام شد. در حال تحلیل فریم‌ها...");
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error("ویدیو قابل خواندن نیست"));
  });
  if (!isFinite(video.duration) || video.duration === Infinity) {
    video.currentTime = 1e9;
    await sleep(200);
  }
  const duration = video.duration;
  if (!isFinite(duration) || duration <= 0) {
    setRecvStatus("مدت ویدیو نامشخص است. دوباره ضبط کنید.", "error");
    URL.revokeObjectURL(url);
    return;
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const step = 1 / 24;
  let t = 0;
  let lastUi = 0;
  while (t <= duration + 0.001) {
    await seek(video, Math.min(t, duration));
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = Math.min(1, 1280 / Math.max(vw, vh));
    canvas.width = Math.max(1, Math.round(vw * scale));
    canvas.height = Math.max(1, Math.round(vh * scale));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ingestCanvas(ctx, canvas);
    if (decoder.ready()) break;
    if (performance.now() - lastUi > 80) {
      updateProgress(`تحلیل ${Math.min(100, (t / duration) * 100).toFixed(0)}٪`);
      lastUi = performance.now();
      await sleep(0);
    }
    t += step;
  }
  decoder.lt.finish();
  URL.revokeObjectURL(url);
  if (!decoder.ready()) {
    const k = decoder.lt.k || 0;
    updateProgress("ناکافی");
    setRecvStatus(
      `فایل کامل نشد. بلوک ${decoder.lt.recoveredCount}/${k || "؟"} — بسته یکتا ${decoder.lt.packetsAccepted}. دوباره ضبط کنید یا ویدیوی طولانی‌تری بدهید.`,
      "error"
    );
    return;
  }
  try {
    recovered = decoder.result();
    $("fileInfo").textContent = `${recovered.name} — ${(recovered.data.length / 1024).toFixed(2)} کیلوبایت`;
    $("resultBox").hidden = false;
    updateProgress("کامل");
    setRecvStatus("فایل بازسازی شد.", "success");
  } catch (err) {
    setRecvStatus("خطا در بازسازی: " + err.message, "error");
  }
}

function ingestCanvas(ctx, canvas) {
  const attempts = [
    [0, 0, canvas.width, canvas.height],
    cropRect(canvas, 0.12),
    cropRect(canvas, 0.22),
  ];
  for (let a = 0; a < attempts.length; a++) {
    const [x, y, w, h] = attempts[a];
    if (w < 16 || h < 16) continue;
    const imageData = ctx.getImageData(x, y, w, h);
    const payloads = decodeImageData(imageData);
    for (let i = 0; i < payloads.length; i++) decoder.ingest(payloads[i]);
    if (decoder.ready()) return;
  }
}

function cropRect(canvas, insetRatio) {
  const insetX = Math.floor(canvas.width * insetRatio);
  const insetY = Math.floor(canvas.height * insetRatio);
  return [insetX, insetY, canvas.width - insetX * 2, canvas.height - insetY * 2];
}

function decodeImageData(imageData) {
  const out = [];
  try {
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "attemptBoth",
    });
    if (code) {
      const bytes = bytesFromJsQR(code);
      if (bytes) out.push(bytes);
    }
  } catch (e) {}
  const zx = decodeWithZXing(imageData);
  if (zx) out.push(zx);
  return out;
}

function bytesFromJsQR(code) {
  if (code.binaryData && code.binaryData.length) {
    return Uint8Array.from(code.binaryData);
  }
  if (typeof code.data === "string") {
    const b = new Uint8Array(code.data.length);
    for (let i = 0; i < code.data.length; i++) b[i] = code.data.charCodeAt(i) & 0xff;
    return b;
  }
  return null;
}

function decodeWithZXing(imageData) {
  if (typeof ZXing === "undefined") return null;
  try {
    const luminances = new Uint8ClampedArray(imageData.width * imageData.height);
    const src = imageData.data;
    for (let i = 0, j = 0; i < src.length; i += 4, j++) {
      luminances[j] = (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) | 0;
    }
    const source = new ZXing.RGBLuminanceSource(luminances, imageData.width, imageData.height);
    const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.QR_CODE]);
    hints.set(ZXing.DecodeHintType.CHARACTER_SET, "ISO-8859-1");
    const reader = new ZXing.QRCodeReader();
    const result = reader.decode(bitmap, hints);
    const raw = result.getRawBytes && result.getRawBytes();
    if (raw && raw.length) return raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
    const text = result.getText();
    const b = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xff;
    return b;
  } catch (e) {
    return null;
  }
}

function updateProgress(label) {
  const k = decoder && decoder.lt.k;
  const rec = decoder ? decoder.lt.recoveredCount : 0;
  const pkts = decoder ? decoder.lt.packetsAccepted : 0;
  $("pktCount").textContent = pkts;
  $("blockCount").textContent = k ? `${rec} / ${k}` : `${rec} / —`;
  const pct = k ? Math.min(100, (rec / k) * 100) : 0;
  $("progressFill").style.width = pct + "%";
  if (label) setRecvStatus(label);
}

function setRecvStatus(msg, kind) {
  const el = $("recvStatus");
  el.textContent = msg;
  el.className = kind || "";
}

function seek(video, time) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = time;
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
