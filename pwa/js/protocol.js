/**
 * Qxfer protocol — must match qrxfer/fountain.py and qrxfer/protocol.py.
 * Integer-only PRNG so Python and JavaScript pick the same fountain neighbors.
 */
(function (root) {
  const MAGIC = [0x51, 0x58, 0x46, 0x31]; // QXF1
  const PROTOCOL_VERSION = 2;
  const HEADER_SIZE = 20;
  const CRC_SIZE = 4;
  const PACKET_OVERHEAD = HEADER_SIZE + CRC_SIZE;
  const QR_SLACK = 4;
  const MAX_NAME_BYTES = 180;

  const QR_BYTE_CAPACITY_L = {
    8: 192, 10: 271, 11: 321, 12: 367, 13: 425, 14: 458, 15: 520,
    16: 586, 17: 644, 18: 718, 19: 792, 20: 858, 21: 929, 22: 1003,
    23: 1091, 24: 1171, 25: 1273, 26: 1367, 27: 1465, 30: 1732, 40: 2953,
  };

  const PRESETS = {
    reliable: { qrVersion: 12, fps: 3, label: "قابل اطمینان" },
    balanced: { qrVersion: 18, fps: 5, label: "متعادل" },
    fast: { qrVersion: 25, fps: 8, label: "سریع" },
  };

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function blockSizeForVersion(version) {
    const cap = QR_BYTE_CAPACITY_L[version];
    if (!cap) throw new Error("Unsupported QR version " + version);
    const size = cap - PACKET_OVERHEAD - QR_SLACK;
    if (size < 32) throw new Error("QR version too small");
    return size;
  }

  function isqrt(n) {
    if (n < 2) return n;
    let x = n;
    let y = (x + 1) >> 1;
    while (y < x) {
      x = y;
      y = (x + Math.floor(n / x)) >> 1;
    }
    return x;
  }

  function XorShift32(seed) {
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 0xa3c59ac3;
  }
  XorShift32.prototype.nextU32 = function () {
    let x = this.state >>> 0;
    x ^= (x << 13) >>> 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    this.state = x >>> 0;
    return this.state;
  };
  XorShift32.prototype.nextBounded = function (n) {
    if (n <= 1) return 0;
    return this.nextU32() % n;
  };

  function mix32(sessionId, seq) {
    let x = (sessionId + 0x9e3779b9) >>> 0;
    x ^= Math.imul(seq, 0x85ebca77) >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15;
    if (x === 0) x = 0xa511e9b3;
    return x >>> 0;
  }

  function sampleDegree(rng, k) {
    if (k <= 1) return 1;
    const extra = rng.nextU32() % 1000;
    if (extra < 120) return 1;
    if (extra < 160) {
      const spike = isqrt(k);
      if (spike < 2) return 2;
      return spike > k ? k : spike;
    }
    let u = rng.nextU32();
    if (u < Math.floor(0xffffffff / k)) return 1;
    if (u === 0) u = 1;
    let d = Math.floor(0xffffffff / u);
    if (d < 2) d = 2;
    if (d > k) d = k;
    return d;
  }

  function neighbors(sessionId, seq, k) {
    if (k <= 0) throw new Error("k must be positive");
    if (seq < k) return [seq];
    const rng = new XorShift32(mix32(sessionId, seq));
    let degree = sampleDegree(rng, k);
    if (degree >= k) {
      const all = [];
      for (let i = 0; i < k; i++) all.push(i);
      return all;
    }
    const picked = [];
    const seen = new Set();
    let guard = 0;
    const limit = degree * 16 + 8;
    while (picked.length < degree && guard < limit) {
      guard++;
      const i = rng.nextBounded(k);
      if (!seen.has(i)) {
        seen.add(i);
        picked.push(i);
      }
    }
    if (!picked.length) picked.push(seq % k);
    picked.sort(function (a, b) { return a - b; });
    return picked;
  }

  function xorInplace(dst, src) {
    for (let i = 0; i < src.length; i++) dst[i] ^= src[i];
  }

  function encodePacket(sessionId, seq, k, blockSize, totalLen, payload) {
    const body = new Uint8Array(HEADER_SIZE + payload.length);
    const view = new DataView(body.buffer);
    body[0] = MAGIC[0]; body[1] = MAGIC[1]; body[2] = MAGIC[2]; body[3] = MAGIC[3];
    view.setUint32(4, sessionId >>> 0, true);
    view.setUint32(8, seq >>> 0, true);
    view.setUint16(12, k, true);
    view.setUint16(14, blockSize, true);
    view.setUint32(16, totalLen >>> 0, true);
    body.set(payload, HEADER_SIZE);
    const out = new Uint8Array(body.length + 4);
    out.set(body, 0);
    const crcView = new DataView(out.buffer);
    crcView.setUint32(body.length, crc32(body), true);
    return out;
  }

  function decodePacket(raw) {
    if (!raw || raw.length < PACKET_OVERHEAD) return null;
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    let idx = -1;
    for (let i = 0; i <= bytes.length - 4; i++) {
      if (bytes[i] === MAGIC[0] && bytes[i + 1] === MAGIC[1] &&
          bytes[i + 2] === MAGIC[2] && bytes[i + 3] === MAGIC[3]) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return null;
    const buf = bytes.subarray(idx);
    if (buf.length < PACKET_OVERHEAD) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const sessionId = view.getUint32(4, true);
    const seq = view.getUint32(8, true);
    const k = view.getUint16(12, true);
    const blockSize = view.getUint16(14, true);
    const totalLen = view.getUint32(16, true);
    if (k < 1 || blockSize < 1) return null;
    const need = HEADER_SIZE + blockSize + CRC_SIZE;
    if (buf.length < need) return null;
    const packetBody = buf.subarray(0, HEADER_SIZE + blockSize);
    const crcExpected = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(HEADER_SIZE + blockSize, true);
    if (crc32(packetBody) !== crcExpected) return null;
    const payload = packetBody.subarray(HEADER_SIZE);
    return { sessionId, seq, k, blockSize, totalLen, payload };
  }

  function LTEncoder(source, blockSize, sessionId) {
    this.blockSize = blockSize;
    this.sessionId = sessionId >>> 0;
    this.totalLen = source.length;
    let paddedLen = Math.ceil(source.length / blockSize) * blockSize;
    if (paddedLen === 0) paddedLen = blockSize;
    const padded = new Uint8Array(paddedLen);
    padded.set(source, 0);
    this.k = paddedLen / blockSize;
    this.blocks = [];
    for (let i = 0; i < this.k; i++) {
      this.blocks.push(padded.subarray(i * blockSize, (i + 1) * blockSize));
    }
  }
  LTEncoder.prototype.symbol = function (seq) {
    const idxs = neighbors(this.sessionId, seq, this.k);
    const acc = new Uint8Array(this.blocks[idxs[0]]);
    for (let n = 1; n < idxs.length; n++) xorInplace(acc, this.blocks[idxs[n]]);
    return acc;
  };

  function LTDecoder() {
    this.sessionId = null;
    this.k = null;
    this.blockSize = null;
    this.totalLen = null;
    this.recovered = [];
    this.recoveredCount = 0;
    this.pending = [];
    this.seen = new Set();
    this.packetsAccepted = 0;
  }
  LTDecoder.prototype.ready = function () {
    return this.k !== null && this.recoveredCount >= this.k;
  };
  LTDecoder.prototype.add = function (sessionId, seq, k, blockSize, totalLen, payload) {
    if (this.k === null) {
      this.sessionId = sessionId;
      this.k = k;
      this.blockSize = blockSize;
      this.totalLen = totalLen;
      this.recovered = new Array(k);
    } else if (
      sessionId !== this.sessionId || k !== this.k ||
      blockSize !== this.blockSize || totalLen !== this.totalLen
    ) {
      return false;
    }
    if (this.seen.has(seq)) return false;
    if (payload.length !== this.blockSize) return false;
    this.seen.add(seq);
    this.packetsAccepted += 1;
    const idxs = neighbors(sessionId, seq, k);
    const data = new Uint8Array(payload);
    const unknown = [];
    for (let n = 0; n < idxs.length; n++) {
      const i = idxs[n];
      if (this.recovered[i]) xorInplace(data, this.recovered[i]);
      else unknown.push(i);
    }
    if (!unknown.length) return true;
    if (unknown.length === 1) {
      this._setBlock(unknown[0], data);
      this._peel();
    } else {
      this.pending.push({ idxs: unknown, data: data });
    }
    if (this.recoveredCount < this.k && this.packetsAccepted % 8 === 0) this._gaussian();
    return true;
  };
  LTDecoder.prototype.finish = function () {
    if (this.k === null) return false;
    this._peel();
    if (this.recoveredCount < this.k) this._gaussian();
    return this.ready();
  };
  LTDecoder.prototype.assemble = function () {
    if (!this.finish()) throw new Error("Incomplete fountain decode");
    const blob = new Uint8Array(this.k * this.blockSize);
    for (let i = 0; i < this.k; i++) blob.set(this.recovered[i], i * this.blockSize);
    return blob.subarray(0, this.totalLen);
  };
  LTDecoder.prototype._setBlock = function (index, data) {
    if (!this.recovered[index]) {
      this.recovered[index] = new Uint8Array(data);
      this.recoveredCount += 1;
    }
  };
  LTDecoder.prototype._peel = function () {
    let changed = true;
    while (changed) {
      changed = false;
      const still = [];
      for (let p = 0; p < this.pending.length; p++) {
        const idxs = this.pending[p].idxs;
        const reduced = new Uint8Array(this.pending[p].data);
        const unknown = [];
        for (let n = 0; n < idxs.length; n++) {
          const i = idxs[n];
          if (this.recovered[i]) xorInplace(reduced, this.recovered[i]);
          else unknown.push(i);
        }
        if (unknown.length === 1) {
          this._setBlock(unknown[0], reduced);
          changed = true;
        } else if (unknown.length > 1) {
          still.push({ idxs: unknown, data: reduced });
        }
      }
      this.pending = still;
    }
  };
  LTDecoder.prototype._gaussian = function () {
    this._peel();
    if (this.k === null || this.recoveredCount >= this.k || !this.pending.length) return;
    const eqs = [];
    for (let p = 0; p < this.pending.length; p++) {
      const idxs = this.pending[p].idxs;
      const reduced = new Uint8Array(this.pending[p].data);
      const unknown = [];
      for (let n = 0; n < idxs.length; n++) {
        const i = idxs[n];
        if (this.recovered[i]) xorInplace(reduced, this.recovered[i]);
        else unknown.push(i);
      }
      if (unknown.length) eqs.push({ idxs: unknown, data: reduced });
    }
    if (!eqs.length) {
      this.pending = [];
      return;
    }
    const unkSet = new Set();
    for (let e = 0; e < eqs.length; e++) {
      for (let n = 0; n < eqs[e].idxs.length; n++) unkSet.add(eqs[e].idxs[n]);
    }
    const unknowns = Array.from(unkSet).sort(function (a, b) { return a - b; });
    const colOf = {};
    for (let c = 0; c < unknowns.length; c++) colOf[unknowns[c]] = c;
    const n = unknowns.length;
    const width = Math.ceil(n / 32);
    const rowsBits = [];
    const rowsData = [];
    for (let e = 0; e < eqs.length; e++) {
      const bits = new Uint32Array(width);
      for (let n2 = 0; n2 < eqs[e].idxs.length; n2++) {
        const c = colOf[eqs[e].idxs[n2]];
        bits[c >> 5] |= 1 << (c & 31);
      }
      rowsBits.push(bits);
      rowsData.push(new Uint8Array(eqs[e].data));
    }
    const m = rowsBits.length;
    let row = 0;
    for (let col = 0; col < n; col++) {
      let pivot = -1;
      for (let r = row; r < m; r++) {
        if ((rowsBits[r][col >> 5] >>> (col & 31)) & 1) {
          pivot = r;
          break;
        }
      }
      if (pivot < 0) continue;
      const tmpB = rowsBits[row]; rowsBits[row] = rowsBits[pivot]; rowsBits[pivot] = tmpB;
      const tmpD = rowsData[row]; rowsData[row] = rowsData[pivot]; rowsData[pivot] = tmpD;
      for (let r = 0; r < m; r++) {
        if (r !== row && ((rowsBits[r][col >> 5] >>> (col & 31)) & 1)) {
          for (let w = 0; w < width; w++) rowsBits[r][w] ^= rowsBits[row][w];
          xorInplace(rowsData[r], rowsData[row]);
        }
      }
      row += 1;
      if (row >= m) break;
    }
    let recoveredAny = false;
    const still = [];
    for (let r = 0; r < m; r++) {
      const ones = [];
      for (let c = 0; c < n; c++) {
        if ((rowsBits[r][c >> 5] >>> (c & 31)) & 1) ones.push(c);
      }
      if (ones.length === 1) {
        const idx = unknowns[ones[0]];
        if (!this.recovered[idx]) {
          this._setBlock(idx, rowsData[r]);
          recoveredAny = true;
        }
      } else if (ones.length > 1) {
        still.push({ idxs: ones.map(function (c) { return unknowns[c]; }), data: rowsData[r] });
      }
    }
    this.pending = still;
    if (recoveredAny) this._peel();
  };

  function utf8Encode(str) {
    return new TextEncoder().encode(str);
  }
  function utf8Decode(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  function buildSource(filename, data, compressFn) {
    const base = filename.split(/[\\/]/).pop() || "file.bin";
    let nameBytes = utf8Encode(base);
    if (nameBytes.length > MAX_NAME_BYTES) nameBytes = nameBytes.subarray(0, MAX_NAME_BYTES);
    const compressed = compressFn(data);
    const header = new Uint8Array(2 + nameBytes.length + 8 + compressed.length);
    header[0] = PROTOCOL_VERSION;
    header[1] = nameBytes.length;
    header.set(nameBytes, 2);
    const view = new DataView(header.buffer);
    view.setUint32(2 + nameBytes.length, data.length, true);
    view.setUint32(2 + nameBytes.length + 4, crc32(data), true);
    header.set(compressed, 2 + nameBytes.length + 8);
    return header;
  }

  async function parseSource(blob, inflateFn) {
    if (blob.length < 10) throw new Error("Source blob too small");
    const version = blob[0];
    if (version !== 1 && version !== 2) throw new Error("Unsupported source version");
    const nameLen = blob[1];
    const name = utf8Decode(blob.subarray(2, 2 + nameLen));
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const origSize = view.getUint32(2 + nameLen, true);
    const origCrc = view.getUint32(2 + nameLen + 4, true);
    const compressed = blob.subarray(2 + nameLen + 8);
    const raw = await inflateFn(compressed, version);
    if (raw.length !== origSize) throw new Error("Decompressed size mismatch");
    if (crc32(raw) !== origCrc) throw new Error("Original file CRC mismatch");
    return { name: name, data: raw };
  }

  function agreeParams(suggestedVersion, suggestedFps, camFps, camWidth) {
    let maxVer = 12;
    if (camWidth >= 900) maxVer = 15;
    if (camWidth >= 1280) maxVer = 18;
    if (camWidth >= 1800) maxVer = 22;
    const qrVersion = Math.min(suggestedVersion | 0, maxVer);
    const cam = (camFps || 30) | 0;
    const maxFps = Math.max(2, Math.min(8, Math.floor(cam / 6) || 2));
    const fps = Math.max(2, Math.min(suggestedFps | 0, maxFps));
    return { qrVersion: qrVersion, fps: fps };
  }

  function encodeHello(info) {
    return "QXF2H" + JSON.stringify(info);
  }
  function encodeAck(info) {
    return "QXF2A" + JSON.stringify(info);
  }
  function encodeGo(info) {
    return "QXF2G" + JSON.stringify(info);
  }
  function parseControl(text) {
    if (!text || typeof text !== "string") return null;
    const prefixes = { QXF2H: "H", QXF2A: "A", QXF2G: "G" };
    for (const p in prefixes) {
      if (text.indexOf(p) === 0) {
        try {
          const data = JSON.parse(text.slice(p.length));
          if (!data || typeof data !== "object") return null;
          data.type = prefixes[p];
          return data;
        } catch (e) {
          return null;
        }
      }
    }
    return null;
  }

  function TransferEncoder(filename, data, blockSize, sessionId, compressFn) {
    this.source = buildSource(filename, data, compressFn);
    this.lt = new LTEncoder(this.source, blockSize, sessionId);
    this.sessionId = this.lt.sessionId;
    this.blockSize = blockSize;
    this.filename = filename;
    this.origSize = data.length;
  }
  TransferEncoder.prototype.packet = function (seq) {
    return encodePacket(
      this.sessionId, seq, this.lt.k, this.blockSize, this.lt.totalLen, this.lt.symbol(seq)
    );
  };
  Object.defineProperty(TransferEncoder.prototype, "k", {
    get: function () { return this.lt.k; },
  });

  function TransferDecoder(inflateFn) {
    this.lt = new LTDecoder();
    this.inflateFn = inflateFn;
  }
  TransferDecoder.prototype.ingest = function (raw) {
    const pkt = decodePacket(raw);
    if (!pkt) return false;
    return this.lt.add(pkt.sessionId, pkt.seq, pkt.k, pkt.blockSize, pkt.totalLen, pkt.payload);
  };
  TransferDecoder.prototype.ready = function () {
    return this.lt.ready();
  };
  TransferDecoder.prototype.result = function () {
    return parseSource(this.lt.assemble(), this.inflateFn);
  };

  const api = {
    MAGIC: MAGIC,
    PRESETS: PRESETS,
    PACKET_OVERHEAD: PACKET_OVERHEAD,
    crc32: crc32,
    blockSizeForVersion: blockSizeForVersion,
    mix32: mix32,
    neighbors: neighbors,
    encodePacket: encodePacket,
    decodePacket: decodePacket,
    LTEncoder: LTEncoder,
    LTDecoder: LTDecoder,
    buildSource: buildSource,
    parseSource: parseSource,
    TransferEncoder: TransferEncoder,
    TransferDecoder: TransferDecoder,
    agreeParams: agreeParams,
    encodeHello: encodeHello,
    encodeAck: encodeAck,
    encodeGo: encodeGo,
    parseControl: parseControl,
    PROTOCOL_VERSION: PROTOCOL_VERSION,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.Qxfer = api;
})(typeof self !== "undefined" ? self : this);
