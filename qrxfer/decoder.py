"""Decode Qxfer beacon-grid packets from a recorded video."""

from __future__ import annotations

import logging
import os
import time
from typing import Callable, List, Optional

import cv2
import numpy as np

from .blockcode import TYPE_DATA, decode_image as decode_beacon
from .lock import detect_lock_region
from .protocol import TransferDecoder

logger = logging.getLogger(__name__)


def decode_image(image_bgr: np.ndarray) -> List[bytes]:
    if image_bgr is None or image_bgr.size == 0:
        return []
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    got = decode_beacon(rgb)
    if got and got[0] == TYPE_DATA:
        return [got[1]]
    return []


class VideoDecoder:
    def __init__(self, progress: Optional[Callable[[str], None]] = None):
        self.decoder = TransferDecoder()
        self.progress = progress or (lambda msg: None)
        self.frames_seen = 0
        self.frames_decoded = 0

    def ingest_frame(self, frame_bgr: np.ndarray) -> bool:
        self.frames_seen += 1
        for payload in decode_image(frame_bgr):
            if self.decoder.ingest(payload):
                self.frames_decoded += 1
        return self.decoder.ready

    def process_video(self, path: str, max_frames: Optional[int] = None) -> bool:
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            raise IOError(f"Could not open video: {path}")
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        idx = 0
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                idx += 1
                if self.ingest_frame(frame):
                    self.progress(
                        f"Recovered file after {idx} frames "
                        f"({self.decoder.lt.recovered_count}/{self.decoder.lt.k} blocks)"
                    )
                    return True
                if idx % 15 == 0:
                    k = self.decoder.lt.k or "?"
                    rec = self.decoder.lt.recovered_count
                    self.progress(
                        f"Analyzing frame {idx}/{total or '?'} — blocks {rec}/{k}, "
                        f"unique packets {self.decoder.lt.packets_accepted}"
                    )
                if max_frames and idx >= max_frames:
                    break
        finally:
            cap.release()
        self.decoder.lt.finish()
        return self.decoder.ready

    def save(self, output_dir: str) -> str:
        name, data = self.decoder.result()
        os.makedirs(output_dir, exist_ok=True)
        safe = os.path.basename(name) or "recovered.bin"
        dest = os.path.join(output_dir, safe)
        base, ext = os.path.splitext(dest)
        n = 1
        while os.path.exists(dest):
            dest = f"{base}_{n}{ext}"
            n += 1
        with open(dest, "wb") as f:
            f.write(data)
        return dest


def record_camera(output_path: str, camera_index: int = 0, width: int = 1920, height: int = 1080) -> str:
    """Record the camera until Ctrl+C (or q in the preview window)."""
    cap = cv2.VideoCapture(camera_index)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_FPS, 30)
    if not cap.isOpened():
        raise IOError(f"Could not open camera {camera_index}")
    ok, frame = cap.read()
    if not ok:
        cap.release()
        raise IOError("Camera produced no frames")
    h, w = frame.shape[:2]
    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(output_path, fourcc, 30.0, (w, h), True)
    if not writer.isOpened():
        cap.release()
        raise IOError("Could not open camera recorder")
    logger.info("Recording %s. Press q in the window or Ctrl+C to stop.", output_path)
    started = time.time()
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            writer.write(frame)
            locked, region = detect_lock_region(frame)
            preview = frame.copy()
            color = (0, 255, 0) if locked else (0, 0, 255)
            if region:
                x, y, bw, bh = region
                cv2.rectangle(preview, (x, y), (x + bw, y + bh), color, 3)
            guide = int(min(w, h) * 0.7)
            gx, gy = (w - guide) // 2, (h - guide) // 2
            cv2.rectangle(preview, (gx, gy), (gx + guide, gy + guide), color, 2)
            label = "LOCKED" if locked else "ALIGN GREEN FRAME"
            cv2.putText(
                preview,
                label,
                (24, 48),
                cv2.FONT_HERSHEY_SIMPLEX,
                1.1,
                color,
                2,
                cv2.LINE_AA,
            )
            cv2.imshow("Qxfer record — q to stop", preview)
            if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                break
    except KeyboardInterrupt:
        logger.info("Recording stopped by user")
    finally:
        writer.release()
        cap.release()
        cv2.destroyAllWindows()
    logger.info("Recorded %.1fs to %s", time.time() - started, output_path)
    return output_path
