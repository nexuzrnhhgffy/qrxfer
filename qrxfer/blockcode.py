"""Camera-easy Beacon Grid: fat black/white cells, green lock frame, bullseye finders.

No QR spec. Designed so a phone camera can sample a regular grid after
cropping the green frame. Python and pwa/js/codec.js must stay in sync.
"""

from __future__ import annotations

from typing import List, Optional, Tuple

import numpy as np
from PIL import Image, ImageDraw

from .protocol import crc32

FINDER = 5
TYPE_CONTROL = 1
TYPE_DATA = 2
HEADER_BYTES = 7  # type + len_le + crc32
GREEN = (0, 230, 118)
HANDSHAKE_GRID = 32
SUGGESTED_GRID = 40

FINDER_TL = [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 1, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
]
FINDER_BR = [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
]


def _finder_at(r: int, c: int, n: int) -> Optional[int]:
    if r < FINDER and c < FINDER:
        return FINDER_TL[r][c]
    if r < FINDER and c >= n - FINDER:
        return FINDER_TL[r][c - (n - FINDER)]
    if r >= n - FINDER and c < FINDER:
        return FINDER_TL[r - (n - FINDER)][c]
    if r >= n - FINDER and c >= n - FINDER:
        return FINDER_BR[r - (n - FINDER)][c - (n - FINDER)]
    return None


def data_cell_count(n: int) -> int:
    return n * n - 4 * FINDER * FINDER


def payload_capacity(n: int) -> int:
    return data_cell_count(n) // 8 - HEADER_BYTES


def block_size_for_grid(n: int) -> int:
    from .constants import PACKET_OVERHEAD

    cap = payload_capacity(n)
    size = cap - PACKET_OVERHEAD
    if size < 24:
        raise ValueError(f"grid {n} is too small")
    return size


def _write_bits(n: int, payload: bytes) -> List[List[int]]:
    bits = []
    for byte in payload:
        for b in range(7, -1, -1):
            bits.append((byte >> b) & 1)
    grid = [[0] * n for _ in range(n)]
    i = 0
    for r in range(n):
        for c in range(n):
            finder = _finder_at(r, c, n)
            if finder is not None:
                grid[r][c] = finder
            else:
                grid[r][c] = bits[i] if i < len(bits) else 0
                i += 1
    return grid


def _read_bits(grid: List[List[int]]) -> bytes:
    n = len(grid)
    bits = []
    for r in range(n):
        for c in range(n):
            if _finder_at(r, c, n) is None:
                bits.append(1 if grid[r][c] else 0)
    out = bytearray(len(bits) // 8)
    for i in range(len(out)):
        v = 0
        for b in range(8):
            v = (v << 1) | bits[i * 8 + b]
        out[i] = v
    return bytes(out)


def wrap_payload(kind: int, data: bytes) -> bytes:
    if len(data) > 65535:
        raise ValueError("payload too large for one frame")
    head = bytes([kind, len(data) & 0xFF, (len(data) >> 8) & 0xFF])
    body = head + data
    return body + crc32(body).to_bytes(4, "little")


def unwrap_payload(blob: bytes) -> Optional[Tuple[int, bytes]]:
    if len(blob) < HEADER_BYTES:
        return None
    kind = blob[0]
    length = blob[1] | (blob[2] << 8)
    if kind not in (TYPE_CONTROL, TYPE_DATA):
        return None
    if 3 + length + 4 > len(blob):
        return None
    body = blob[: 3 + length]
    crc = int.from_bytes(blob[3 + length : 7 + length], "little")
    if crc32(body) != crc:
        return None
    return kind, body[3:]


def encode_control(text: str, n: int = HANDSHAKE_GRID) -> List[List[int]]:
    packed = wrap_payload(TYPE_CONTROL, text.encode("utf-8"))
    if len(packed) > data_cell_count(n) // 8:
        raise ValueError("control text does not fit this grid")
    return _write_bits(n, packed)


def encode_data(packet: bytes, n: int) -> List[List[int]]:
    packed = wrap_payload(TYPE_DATA, packet)
    if len(packed) > data_cell_count(n) // 8:
        raise ValueError("packet does not fit this grid")
    return _write_bits(n, packed)


def decode_grid(grid: List[List[int]]) -> Optional[Tuple[int, bytes]]:
    if not grid or len(grid) < 12:
        return None
    n = len(grid)
    score = 0
    total = 0
    for r in range(n):
        for c in range(n):
            expect = _finder_at(r, c, n)
            if expect is None:
                continue
            total += 1
            if grid[r][c] == expect:
                score += 1
    if total == 0 or score / total < 0.78:
        return None
    return unwrap_payload(_read_bits(grid))


def render_grid(grid: List[List[int]], size: int = 720) -> np.ndarray:
    n = len(grid)
    img = Image.new("RGB", (size, size), GREEN)
    draw = ImageDraw.Draw(img)
    border = max(24, int(size * 0.06))
    quiet = max(8, int(size * 0.025))
    inner = size - 2 * border
    draw.rectangle([border, border, size - border - 1, size - border - 1], fill=(255, 255, 255))
    origin = border + quiet
    usable = inner - 2 * quiet
    cell = usable / n
    gap = max(1.0, cell * 0.08)
    for r in range(n):
        for c in range(n):
            x0 = origin + c * cell + gap / 2
            y0 = origin + r * cell + gap / 2
            x1 = origin + (c + 1) * cell - gap / 2
            y1 = origin + (r + 1) * cell - gap / 2
            color = (0, 0, 0) if grid[r][c] else (255, 255, 255)
            draw.rectangle([x0, y0, x1, y1], fill=color)
    return np.array(img)


def _green_bbox(rgb: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    mask = (g > 90) & (g > r + 28) & (g > b + 28)
    ys, xs = np.where(mask)
    if len(xs) < 80:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def _sample_grid(rgb: np.ndarray, n: int) -> List[List[int]]:
    h, w = rgb.shape[:2]
    lum = (0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]).astype(np.float32)
    samples = np.zeros((n, n), dtype=np.float32)
    for r in range(n):
        for c in range(n):
            acc = 0.0
            cnt = 0
            for dr, dc in ((0.5, 0.5), (0.35, 0.35), (0.35, 0.65), (0.65, 0.35), (0.65, 0.65)):
                x = int((c + dc) * w / n)
                y = int((r + dr) * h / n)
                if 0 <= x < w and 0 <= y < h:
                    acc += lum[y, x]
                    cnt += 1
            samples[r, c] = acc / max(1, cnt)
    # Threshold from finder black vs white
    blacks = []
    whites = []
    for r in range(n):
        for c in range(n):
            expect = _finder_at(r, c, n)
            if expect is None:
                continue
            if expect:
                blacks.append(samples[r, c])
            else:
                whites.append(samples[r, c])
    if blacks and whites:
        thr = (float(np.median(blacks)) + float(np.median(whites))) / 2.0
    else:
        thr = float(np.median(samples))
    return [[1 if samples[r, c] < thr else 0 for c in range(n)] for r in range(n)]


def decode_image(rgb: np.ndarray, grids: Tuple[int, ...] = (32, 40, 36, 28, 24, 48, 56)) -> Optional[Tuple[int, bytes]]:
    if rgb is None or rgb.size == 0:
        return None
    if rgb.ndim == 3 and rgb.shape[2] == 3:
        pass
    else:
        return None
    box = _green_bbox(rgb)
    crops = []
    if box:
        x0, y0, x1, y1 = box
        crops.append(rgb[y0 : y1 + 1, x0 : x1 + 1])
        side = min(x1 - x0, y1 - y0)
        for frac in (0.08, 0.11, 0.14, 0.18):
            pad = int(side * frac)
            xa, ya = x0 + pad, y0 + pad
            xb, yb = x1 - pad, y1 - pad
            if xb - xa > 40 and yb - ya > 40:
                crops.append(rgb[ya:yb, xa:xb])
    h, w = rgb.shape[:2]
    side = min(h, w)
    x0 = (w - side) // 2
    y0 = (h - side) // 2
    crops.append(rgb[y0 : y0 + side, x0 : x0 + side])
    for crop in crops:
        if crop.size == 0:
            continue
        for n in grids:
            grid = _sample_grid(crop, n)
            got = decode_grid(grid)
            if got:
                return got
    return None
