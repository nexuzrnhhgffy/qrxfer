"""Turn a file into a looping beacon-grid video."""

from __future__ import annotations

import logging
import os
import secrets
from typing import Optional

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .blockcode import block_size_for_grid, encode_data, render_grid
from .constants import DEFAULT_OVERHEAD, DEFAULT_PRESET, LOCK_COLOR, PRESETS
from .protocol import TransferEncoder
from .video_writer import VideoWriter

logger = logging.getLogger(__name__)

_GRID_FROM_QR = {12: 32, 15: 32, 18: 40, 22: 40, 25: 48}


def _load_font(size: int):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _solid_frame(size, text, bg=(0, 0, 0), fg=(255, 255, 255)):
    img = Image.new("RGB", size, bg)
    draw = ImageDraw.Draw(img)
    font = _load_font(max(48, size[0] // 8))
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((size[0] - tw) // 2, (size[1] - th) // 2), text, fill=fg, font=font)
    return np.array(img)


class QRVideoGenerator:
    def __init__(
        self,
        qr_version=None,
        qr_size=720,
        fps=None,
        preset=DEFAULT_PRESET,
        overhead=DEFAULT_OVERHEAD,
        repeats=2,
        num_processes=1,
        grid=None,
    ):
        spec = dict(PRESETS.get(preset, PRESETS[DEFAULT_PRESET]))
        self.grid = grid or spec.get("grid") or _GRID_FROM_QR.get(qr_version or spec.get("qr_version"), 32)
        self.fps = fps or spec["fps"]
        self.qr_size = qr_size
        self.overhead = overhead
        self.repeats = max(1, repeats)
        self.qr_version = qr_version or spec.get("qr_version")
        self.block_size = block_size_for_grid(self.grid)

    def _frame(self, packet: bytes) -> np.ndarray:
        return render_grid(encode_data(packet, self.grid), size=self.qr_size)

    def generate(self, input_file, output_video, session_id: Optional[int] = None):
        if not os.path.exists(input_file):
            raise FileNotFoundError(input_file)
        with open(input_file, "rb") as f:
            data = f.read()
        session_id = secrets.randbits(32) if session_id is None else session_id
        encoder = TransferEncoder(
            os.path.basename(input_file), data, self.block_size, session_id
        )
        n_unique = max(encoder.k + 8, int(encoder.k * self.overhead))
        logger.info(
            "Encoding %s: orig=%s bytes, source=%s bytes, k=%s, grid=%s, packets=%s x%s",
            input_file,
            encoder.orig_size,
            encoder.total_len,
            encoder.k,
            self.grid,
            n_unique,
            self.repeats,
        )

        first = self._frame(encoder.packet(0))
        h, w = first.shape[:2]
        writer = VideoWriter(output_video, fps=self.fps, frame_size=(w, h))
        writer.open()
        try:
            ready_frames = max(3, int(self.fps * 3))
            for i in range(ready_frames):
                second = i // max(1, self.fps)
                label = ["3", "2", "1"][min(second, 2)]
                writer.write_frame(_solid_frame((w, h), label, bg=LOCK_COLOR, fg=(0, 0, 0)))

            for _rep in range(self.repeats):
                for seq in range(n_unique):
                    writer.write_frame(self._frame(encoder.packet(seq)))
                    if (seq + 1) % 25 == 0:
                        logger.info("Written packet %s/%s", seq + 1, n_unique)
        finally:
            writer.close()
        return {
            "k": encoder.k,
            "packets": n_unique * self.repeats,
            "session_id": session_id,
            "output": output_video,
            "grid": self.grid,
        }

    def preview(self, input_file, session_id: Optional[int] = None):
        import cv2

        with open(input_file, "rb") as f:
            data = f.read()
        session_id = secrets.randbits(32) if session_id is None else session_id
        encoder = TransferEncoder(
            os.path.basename(input_file), data, self.block_size, session_id
        )
        delay = max(1, int(1000 / self.fps))
        seq = 0
        logger.info("Live preview k=%s grid=%s. Press q to quit.", encoder.k, self.grid)
        while True:
            frame = self._frame(encoder.packet(seq))
            bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
            cv2.imshow("Qxfer sender — q to quit", bgr)
            seq += 1
            key = cv2.waitKey(delay) & 0xFF
            if key in (ord("q"), 27):
                break
        cv2.destroyAllWindows()
