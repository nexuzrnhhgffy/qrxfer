"""Binary packet codec and source-blob (filename + zlib) helpers."""

from __future__ import annotations

import os
import struct
import zlib
from dataclasses import dataclass
from typing import Optional, Tuple

from .constants import CRC_SIZE, MAGIC, MAX_NAME_BYTES, PACKET_OVERHEAD, PROTOCOL_VERSION
from .fountain import LTDecoder, LTEncoder

HEADER_STRUCT = struct.Struct("<4sI I H H I")  # magic, session, seq, k, block_size, total_len


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
            self.k,
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


def build_source(filename: str, data: bytes) -> bytes:
    name_b = os.path.basename(filename).encode("utf-8")[:MAX_NAME_BYTES]
    header = struct.pack("<BB", PROTOCOL_VERSION, len(name_b)) + name_b
    header += struct.pack("<II", len(data), crc32(data))
    return header + zlib.compress(data, 9)


def parse_source(blob: bytes) -> Tuple[str, bytes]:
    if len(blob) < 10:
        raise ValueError("Source blob too small")
    version = blob[0]
    if version != PROTOCOL_VERSION:
        raise ValueError(f"Unsupported source version: {version}")
    name_len = blob[1]
    if len(blob) < 2 + name_len + 8:
        raise ValueError("Truncated source header")
    name = blob[2 : 2 + name_len].decode("utf-8")
    orig_size, orig_crc = struct.unpack_from("<II", blob, 2 + name_len)
    compressed = blob[2 + name_len + 8 :]
    raw = zlib.decompress(compressed)
    if len(raw) != orig_size:
        raise ValueError("Decompressed size mismatch")
    if crc32(raw) != orig_crc:
        raise ValueError("Original file CRC mismatch")
    return name, raw


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
