"""In-memory transfer sessions so sender and receiver can find each other."""

from __future__ import annotations

import secrets
import threading
import time
from typing import Any, Optional

from .protocol import agree_params

ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
CODE_LEN = 6
TTL_SEC = 2 * 60 * 60
MAX_SESSIONS = 64


def new_code() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(CODE_LEN))


def normalize_code(code: str) -> str:
    return "".join(ch for ch in (code or "").upper() if ch in ALPHABET)


class Hub:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, dict[str, Any]] = {}

    def _purge(self, now: float) -> None:
        dead = [c for c, s in self._sessions.items() if now - s["created"] > TTL_SEC]
        for code in dead:
            self._sessions.pop(code, None)
        if len(self._sessions) <= MAX_SESSIONS:
            return
        oldest = sorted(self._sessions, key=lambda c: self._sessions[c]["created"])
        for code in oldest[: len(self._sessions) - MAX_SESSIONS]:
            self._sessions.pop(code, None)

    def _snapshot(self, sess: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in sess.items() if k != "lock"}

    def create(self, offer: dict[str, Any]) -> dict[str, Any]:
        now = time.time()
        with self._lock:
            self._purge(now)
            code = new_code()
            while code in self._sessions:
                code = new_code()
            sess = {
                "code": code,
                "created": now,
                "status": "waiting",
                "name": str(offer.get("name") or "file.bin")[:180],
                "orig": int(offer.get("orig") or 0),
                "compressed": int(offer.get("compressed") or 0),
                "suggest_grid": int(offer.get("grid") or 40),
                "suggest_fps": int(offer.get("fps") or 4),
                "optical": int(offer.get("optical") or 0),
                "grid": None,
                "fps": None,
                "k": None,
                "recv": None,
                "progress": {"recovered": 0, "k": 0, "seq": 0},
                "error": None,
            }
            self._sessions[code] = sess
            return self._snapshot(sess)

    def get(self, code: str) -> Optional[dict[str, Any]]:
        key = normalize_code(code)
        now = time.time()
        with self._lock:
            self._purge(now)
            sess = self._sessions.get(key)
            return None if sess is None else self._snapshot(sess)

    def join(self, code: str, cam_fps: float, cam_width: int) -> Optional[dict[str, Any]]:
        key = normalize_code(code)
        now = time.time()
        with self._lock:
            sess = self._sessions.get(key)
            if sess is None:
                return None
            grid, fps = agree_params(
                sess["suggest_grid"], sess["suggest_fps"], cam_fps, cam_width
            )
            sess["grid"] = grid
            sess["fps"] = fps
            sess["recv"] = {
                "camFps": float(cam_fps or 0),
                "width": int(cam_width or 0),
                "joinedAt": now,
            }
            if sess["status"] == "waiting":
                sess["status"] = "joined"
            return self._snapshot(sess)

    def offer(self, code: str, k: int, optical: int) -> Optional[dict[str, Any]]:
        key = normalize_code(code)
        with self._lock:
            sess = self._sessions.get(key)
            if sess is None:
                return None
            sess["k"] = int(k)
            sess["optical"] = int(optical)
            return self._snapshot(sess)

    def start(self, code: str) -> Optional[dict[str, Any]]:
        key = normalize_code(code)
        with self._lock:
            sess = self._sessions.get(key)
            if sess is None:
                return None
            if sess["status"] not in ("joined", "sending"):
                return None
            if not sess.get("k"):
                return None
            sess["status"] = "sending"
            return self._snapshot(sess)

    def progress(self, code: str, recovered: int, k: int, seq: int = 0) -> Optional[dict[str, Any]]:
        key = normalize_code(code)
        with self._lock:
            sess = self._sessions.get(key)
            if sess is None:
                return None
            sess["progress"] = {
                "recovered": int(recovered),
                "k": int(k),
                "seq": int(seq),
            }
            return self._snapshot(sess)

    def done(self, code: str, ok: bool = True, error: str | None = None) -> Optional[dict[str, Any]]:
        key = normalize_code(code)
        with self._lock:
            sess = self._sessions.get(key)
            if sess is None:
                return None
            sess["status"] = "done" if ok else "error"
            sess["error"] = error
            return self._snapshot(sess)

    def cancel(self, code: str) -> Optional[dict[str, Any]]:
        key = normalize_code(code)
        with self._lock:
            sess = self._sessions.get(key)
            if sess is None:
                return None
            sess["status"] = "error"
            sess["error"] = "cancelled"
            return self._snapshot(sess)
