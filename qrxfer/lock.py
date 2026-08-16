"""Find the green lock frame and return the inner QR region."""

from __future__ import annotations

from typing import Optional, Tuple

import cv2
import numpy as np


def _green_mask_bgr(frame_bgr: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    # Wide green band so phone screens and compressed video still match.
    lower = np.array([35, 40, 40])
    upper = np.array([90, 255, 255])
    return cv2.inRange(hsv, lower, upper)


def detect_lock_region(frame_bgr: np.ndarray) -> Tuple[bool, Optional[Tuple[int, int, int, int]]]:
    """Return (locked, crop_xywh) for the interior of a green square frame."""
    h, w = frame_bgr.shape[:2]
    mask = _green_mask_bgr(frame_bgr)
    mask = cv2.medianBlur(mask, 5)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return False, None
    contour = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(contour)
    if area < (w * h * 0.04):
        return False, None
    x, y, bw, bh = cv2.boundingRect(contour)
    if bw < 40 or bh < 40:
        return False, None
    ratio = bw / float(bh)
    if ratio < 0.7 or ratio > 1.4:
        return False, None
    inset = max(6, int(min(bw, bh) * 0.08))
    x0 = min(w - 1, max(0, x + inset))
    y0 = min(h - 1, max(0, y + inset))
    x1 = min(w, max(x0 + 10, x + bw - inset))
    y1 = min(h, max(y0 + 10, y + bh - inset))
    return True, (x0, y0, x1 - x0, y1 - y0)


def crop_lock(frame_bgr: np.ndarray) -> Optional[np.ndarray]:
    locked, region = detect_lock_region(frame_bgr)
    if not locked or region is None:
        return None
    x, y, w, h = region
    return frame_bgr[y : y + h, x : x + w]


def center_square(frame_bgr: np.ndarray, fraction: float = 0.78) -> np.ndarray:
    h, w = frame_bgr.shape[:2]
    side = int(min(h, w) * fraction)
    x0 = (w - side) // 2
    y0 = (h - side) // 2
    return frame_bgr[y0 : y0 + side, x0 : x0 + side]
