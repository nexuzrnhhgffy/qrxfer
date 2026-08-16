/**
 * Beacon Grid — fat black/white cells, green lock frame, bullseye finders.
 * Must match qrxfer/blockcode.py. No QR libraries.
 */
(function (root) {
  const FINDER = 5;
  const TYPE_CONTROL = 1;
  const TYPE_DATA = 2;
  const HANDSHAKE_GRID = 32;
  const SUGGESTED_GRID = 40;
  const PACKET_OVERHEAD = 26;

  const FINDER_TL = [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 1, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
  ];
  const FINDER_BR = [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
  ];

  function finderAt(r, c, n) {
    if (r < FINDER && c < FINDER) return FINDER_TL[r][c];
    if (r < FINDER && c >= n - FINDER) return FINDER_TL[r][c - (n - FINDER)];
    if (r >= n - FINDER && c < FINDER) return FINDER_TL[r - (n - FINDER)][c];
    if (r >= n - FINDER && c >= n - FINDER) return FINDER_BR[r - (n - FINDER)][c - (n - FINDER)];
    return null;
  }

  function dataCellCount(n) {
    return n * n - 4 * FINDER * FINDER;
  }

  function payloadCapacity(n) {
    return Math.floor(dataCellCount(n) / 8) - 7;
  }

  function blockSizeForGrid(n) {
    const size = payloadCapacity(n) - PACKET_OVERHEAD;
    if (size < 24) throw new Error("grid too small");
    return size;
  }

  function crc32(bytes) {
    return root.Qxfer.crc32(bytes);
  }

  function wrapPayload(kind, data) {
    const head = new Uint8Array(3 + data.length);
    head[0] = kind;
    head[1] = data.length & 0xff;
    head[2] = (data.length >> 8) & 0xff;
    head.set(data, 3);
    const out = new Uint8Array(head.length + 4);
    out.set(head, 0);
    const view = new DataView(out.buffer);
    view.setUint32(head.length, crc32(head), true);
    return out;
  }

  function unwrapPayload(blob) {
    if (!blob || blob.length < 7) return null;
    const kind = blob[0];
    const length = blob[1] | (blob[2] << 8);
    if (kind !== TYPE_CONTROL && kind !== TYPE_DATA) return null;
    if (3 + length + 4 > blob.length) return null;
    const body = blob.subarray(0, 3 + length);
    const crc = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(3 + length, true);
    if (crc32(body) !== crc) return null;
    return { kind: kind, data: blob.subarray(3, 3 + length) };
  }

  function writeBits(n, payload) {
    const bits = [];
    for (let i = 0; i < payload.length; i++) {
      for (let b = 7; b >= 0; b--) bits.push((payload[i] >> b) & 1);
    }
    const grid = [];
    let k = 0;
    for (let r = 0; r < n; r++) {
      const row = [];
      for (let c = 0; c < n; c++) {
        const f = finderAt(r, c, n);
        if (f !== null) row.push(f);
        else {
          row.push(k < bits.length ? bits[k] : 0);
          k += 1;
        }
      }
      grid.push(row);
    }
    return grid;
  }

  function readBits(grid) {
    const n = grid.length;
    const bits = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (finderAt(r, c, n) === null) bits.push(grid[r][c] ? 1 : 0);
      }
    }
    const out = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < out.length; i++) {
      let v = 0;
      for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
      out[i] = v;
    }
    return out;
  }

  function encodeControl(text, n) {
    n = n || HANDSHAKE_GRID;
    const packed = wrapPayload(TYPE_CONTROL, new TextEncoder().encode(text));
    if (packed.length > Math.floor(dataCellCount(n) / 8)) throw new Error("control too large");
    return writeBits(n, packed);
  }

  function encodeData(packet, n) {
    const packed = wrapPayload(TYPE_DATA, packet);
    if (packed.length > Math.floor(dataCellCount(n) / 8)) throw new Error("packet too large");
    return writeBits(n, packed);
  }

  function decodeGrid(grid) {
    if (!grid || grid.length < 12) return null;
    const n = grid.length;
    let score = 0, total = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const expect = finderAt(r, c, n);
        if (expect === null) continue;
        total += 1;
        if (grid[r][c] === expect) score += 1;
      }
    }
    if (!total || score / total < 0.78) return null;
    return unwrapPayload(readBits(grid));
  }

  function drawGrid(canvas, grid) {
    const n = grid.length;
    const size = canvas.width;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#00e676";
    ctx.fillRect(0, 0, size, size);
    const border = Math.max(24, Math.floor(size * 0.06));
    const quiet = Math.max(8, Math.floor(size * 0.025));
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(border, border, size - 2 * border, size - 2 * border);
    const origin = border + quiet;
    const usable = size - 2 * border - 2 * quiet;
    const cell = usable / n;
    const gap = Math.max(1, cell * 0.08);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        ctx.fillStyle = grid[r][c] ? "#000000" : "#ffffff";
        ctx.fillRect(
          origin + c * cell + gap / 2,
          origin + r * cell + gap / 2,
          cell - gap,
          cell - gap
        );
      }
    }
  }

  function greenBBox(imageData) {
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
    if (count < 80) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function sampleGrid(imageData, n, ox, oy, ow, oh) {
    const { width, data } = imageData;
    const samples = [];
    const blacks = [], whites = [];
    for (let r = 0; r < n; r++) {
      const row = [];
      for (let c = 0; c < n; c++) {
        let acc = 0, cnt = 0;
        const pts = [[0.5, 0.5], [0.35, 0.35], [0.35, 0.65], [0.65, 0.35], [0.65, 0.65]];
        for (let p = 0; p < pts.length; p++) {
          const x = Math.floor(ox + (c + pts[p][0]) * ow / n);
          const y = Math.floor(oy + (r + pts[p][1]) * oh / n);
          if (x < 0 || y < 0 || x >= imageData.width || y >= imageData.height) continue;
          const i = (y * width + x) * 4;
          acc += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          cnt += 1;
        }
        const v = acc / Math.max(1, cnt);
        row.push(v);
        const expect = finderAt(r, c, n);
        if (expect === 1) blacks.push(v);
        else if (expect === 0) whites.push(v);
      }
      samples.push(row);
    }
    let thr;
    if (blacks.length && whites.length) {
      blacks.sort(function (a, b) { return a - b; });
      whites.sort(function (a, b) { return a - b; });
      thr = (blacks[blacks.length >> 1] + whites[whites.length >> 1]) / 2;
    } else {
      thr = 128;
    }
    const grid = [];
    for (let r = 0; r < n; r++) {
      const row = [];
      for (let c = 0; c < n; c++) row.push(samples[r][c] < thr ? 1 : 0);
      grid.push(row);
    }
    return grid;
  }

  function decodeImageData(imageData, grids) {
    grids = grids || [32, 40, 36, 28, 24, 48, 56];
    const regions = [];
    const box = greenBBox(imageData);
    if (box) {
      regions.push(box);
      const side = Math.min(box.w, box.h);
      const fracs = [0.08, 0.11, 0.14, 0.18];
      for (let i = 0; i < fracs.length; i++) {
        const pad = Math.floor(side * fracs[i]);
        regions.push({ x: box.x + pad, y: box.y + pad, w: box.w - 2 * pad, h: box.h - 2 * pad });
      }
    }
    regions.push({ x: 0, y: 0, w: imageData.width, h: imageData.height });
    const side = Math.min(imageData.width, imageData.height);
    regions.push({
      x: (imageData.width - side) >> 1,
      y: (imageData.height - side) >> 1,
      w: side,
      h: side,
    });
    for (let i = 0; i < regions.length; i++) {
      const rg = regions[i];
      if (rg.w < 40 || rg.h < 40) continue;
      for (let g = 0; g < grids.length; g++) {
        const grid = sampleGrid(imageData, grids[g], rg.x, rg.y, rg.w, rg.h);
        const got = decodeGrid(grid);
        if (got) return got;
      }
    }
    return null;
  }

  function displaySize(viewW, viewH, split) {
    viewW = Math.max(0, viewW || 0);
    viewH = Math.max(0, viewH || 0);
    const marginX = Math.max(24, Math.round(viewW * 0.04));
    const marginY = Math.max(88, Math.round(viewH * 0.1));
    const availW = Math.max(160, viewW - marginX * 2);
    const availH = Math.max(160, (split ? viewH * 0.48 : viewH) - marginY);
    const box = Math.min(availW, availH);
    const desktop = Math.min(viewW, viewH) >= 700;
    const target = desktop
      ? Math.min(Math.round(box * 0.68), 540)
      : Math.round(box * 0.9);
    return Math.max(180, Math.min(target, box));
  }

  function canvasSize(split) {
    const vv = typeof window !== "undefined" && window.visualViewport;
    const w = (vv && vv.width) || (typeof window !== "undefined" ? window.innerWidth : 390);
    const h = (vv && vv.height) || (typeof window !== "undefined" ? window.innerHeight : 844);
    return displaySize(w, h, split);
  }

  root.Beacon = {
    TYPE_CONTROL: TYPE_CONTROL,
    TYPE_DATA: TYPE_DATA,
    HANDSHAKE_GRID: HANDSHAKE_GRID,
    SUGGESTED_GRID: SUGGESTED_GRID,
    payloadCapacity: payloadCapacity,
    blockSizeForGrid: blockSizeForGrid,
    encodeControl: encodeControl,
    encodeData: encodeData,
    decodeGrid: decodeGrid,
    decodeImageData: decodeImageData,
    drawGrid: drawGrid,
    displaySize: displaySize,
    canvasSize: canvasSize,
    wrapPayload: wrapPayload,
    unwrapPayload: unwrapPayload,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.Beacon;
  }
})(typeof self !== "undefined" ? self : this);
