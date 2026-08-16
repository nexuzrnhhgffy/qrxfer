"""Binary packet codec, LZMA source blob, and optical handshake helpers."""

from __future__ import annotations

import json
import lzma
import os
import struct
import zlib
from dataclasses import dataclass
from typing import Optional, Tuple

from .constants import CRC_SIZE, MAGIC, MAX_NAME_BYTES, PACKET_OVERHEAD, PROTOCOL_VERSION
from .fountain import LTDecoder, LTEncoder

HEADER_STRUCT = struct.Struct("<4sI I I H I")  # magic, session, seq, k, block_size, total_len


def crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


@dataclass
class Packet:
    session_id: int
    seq: int
    k: int
    block_size: int
    total_len: int
    payload: bytes

    def encode(self) -> bytes:
        header = HEADER_STRUCT.pack(
            MAGIC,
            self.session_id & 0xFFFFFFFF,
            self.seq & 0xFFFFFFFF,
            self.k & 0xFFFFFFFF,
            self.block_size,
            self.total_len & 0xFFFFFFFF,
        )
        body = header + self.payload
        return body + struct.pack("<I", crc32(body))


def encode_packet(
    session_id: int,
    seq: int,
    k: int,
    block_size: int,
    total_len: int,
    payload: bytes,
) -> bytes:
    return Packet(session_id, seq, k, block_size, total_len, payload).encode()


def decode_packet(raw: bytes) -> Optional[Packet]:
    if raw is None or len(raw) < PACKET_OVERHEAD:
        return None
    if isinstance(raw, memoryview):
        raw = raw.tobytes()
    elif not isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw)
    idx = raw.find(MAGIC)
    if idx == -1:
        return None
    raw = bytes(raw[idx:])
    if len(raw) < HEADER_STRUCT.size + CRC_SIZE:
        return None
    magic, session_id, seq, k, block_size, total_len = HEADER_STRUCT.unpack_from(raw, 0)
    if magic != MAGIC or k < 1 or block_size < 1:
        return None
    need = HEADER_STRUCT.size + block_size + CRC_SIZE
    if len(raw) < need:
        return None
    body = raw[: HEADER_STRUCT.size + block_size]
    crc_expected = struct.unpack_from("<I", raw, HEADER_STRUCT.size + block_size)[0]
    if crc32(body) != crc_expected:
        return None
    payload = body[HEADER_STRUCT.size :]
    return Packet(session_id, seq, k, block_size, total_len, payload)


def compress_payload(data: bytes) -> bytes:
    """Maximum lossless LZMA (legacy .lzma / FORMAT_ALONE), matching lzma-js."""
    return lzma.compress(data, format=lzma.FORMAT_ALONE, preset=9)


def decompress_payload(compressed: bytes, version: int) -> bytes:
    if version >= 2:
        return lzma.decompress(compressed, format=lzma.FORMAT_ALONE)
    return zlib.decompress(compressed)


def build_source(filename: str, data: bytes) -> bytes:
    name_b = os.path.basename(filename).encode("utf-8")[:MAX_NAME_BYTES]
    header = struct.pack("<BB", PROTOCOL_VERSION, len(name_b)) + name_b
    header += struct.pack("<II", len(data), crc32(data))
    return header + compress_payload(data)


def parse_source(blob: bytes) -> Tuple[str, bytes]:
    if len(blob) < 10:
        raise ValueError("Source blob too small")
    version = blob[0]
    if version not in (1, 2):
        raise ValueError(f"Unsupported source version: {version}")
    name_len = blob[1]
    if len(blob) < 2 + name_len + 8:
        raise ValueError("Truncated source header")
    name = blob[2 : 2 + name_len].decode("utf-8")
    orig_size, orig_crc = struct.unpack_from("<II", blob, 2 + name_len)
    compressed = blob[2 + name_len + 8 :]
    raw = decompress_payload(compressed, version)
    if len(raw) != orig_size:
        raise ValueError("Decompressed size mismatch")
    if crc32(raw) != orig_crc:
        raise ValueError("Original file CRC mismatch")
    return name, raw


def agree_params(suggested_grid: int, suggested_fps: int, cam_fps: float, cam_width: int) -> Tuple[int, int]:
    """Pick a beacon-grid size and FPS both cameras can keep up with."""
    if cam_width >= 1600:
        max_g = 48
    elif cam_width >= 1000:
        max_g = 40
    else:
        max_g = 32
    allowed = [g for g in (24, 28, 32, 36, 40, 48) if g <= min(int(suggested_grid or 40), max_g)]
    grid = allowed[-1] if allowed else 32
    cam = int(cam_fps or 30)
    max_fps = max(2, min(6, cam // 8 or 2))
    fps = max(2, min(int(suggested_fps or 4), max_fps))
    return grid, fps


def encode_hello(info: dict) -> str:
    return "QXF2H" + json.dumps(info, separators=(",", ":"), ensure_ascii=False)


def encode_ack(info: dict) -> str:
    return "QXF2A" + json.dumps(info, separators=(",", ":"), ensure_ascii=False)


def encode_go(info: dict) -> str:
    return "QXF2G" + json.dumps(info, separators=(",", ":"), ensure_ascii=False)


def parse_control(text: str) -> Optional[dict]:
    if not text:
        return None
    text = text.strip()
    for prefix, kind in (("QXF2H", "H"), ("QXF2A", "A"), ("QXF2G", "G")):
        if text.startswith(prefix):
            try:
                data = json.loads(text[len(prefix) :])
            except json.JSONDecodeError:
                return None
            if not isinstance(data, dict):
                return None
            data["type"] = kind
            return data
    return None


class TransferEncoder:
    def __init__(self, filename: str, data: bytes, block_size: int, session_id: int):
        self.source = build_source(filename, data)
        self.lt = LTEncoder(self.source, block_size, session_id)
        self.session_id = self.lt.session_id
        self.block_size = block_size
        self.filename = os.path.basename(filename)
        self.orig_size = len(data)

    @property
    def k(self) -> int:
        return self.lt.k

    @property
    def total_len(self) -> int:
        return self.lt.total_len

    def packet(self, seq: int) -> bytes:
        payload = self.lt.symbol(seq)
        return encode_packet(
            self.session_id, seq, self.k, self.block_size, self.total_len, payload
        )


class TransferDecoder:
    def __init__(self):
        self.lt = LTDecoder()

    def ingest(self, raw: bytes) -> bool:
        pkt = decode_packet(raw)
        if pkt is None:
            return False
        return self.lt.add(
            pkt.session_id, pkt.seq, pkt.k, pkt.block_size, pkt.total_len, pkt.payload
        )

    @property
    def ready(self) -> bool:
        return self.lt.ready

    def result(self) -> Tuple[str, bytes]:
        blob = self.lt.assemble()
        return parse_source(blob)
