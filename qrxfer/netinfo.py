"""Discover LAN / USB-tether IPv4 addresses so a phone can open the UI."""

from __future__ import annotations

import re
import socket
import subprocess
import sys
from typing import List


def _add(ips: List[str], ip: str) -> None:
    if not ip or ip in ips:
        return
    if ":" in ip or ip.startswith(("127.", "0.", "169.254.")):
        return
    ips.append(ip)


def lan_ipv4() -> List[str]:
    ips: List[str] = []
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.4)
        sock.connect(("1.1.1.1", 80))
        _add(ips, sock.getsockname()[0])
        sock.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            _add(ips, info[4][0])
    except OSError:
        pass
    if sys.platform == "win32":
        try:
            out = subprocess.check_output(
                "ipconfig", text=True, encoding="utf-8", errors="ignore", timeout=4
            )
            for match in re.finditer(r"IPv4[^:]*:\s*([0-9.]+)", out):
                _add(ips, match.group(1))
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        for cmd in (["hostname", "-I"], ["ip", "-4", "-o", "addr"]):
            try:
                out = subprocess.check_output(cmd, text=True, errors="ignore", timeout=4)
            except (OSError, subprocess.TimeoutExpired):
                continue
            for match in re.finditer(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b", out):
                _add(ips, match.group(1))
    return ips


def try_adb_reverse(port: int) -> bool:
    """Map phone localhost:port to this machine so the phone can use 127.0.0.1."""
    try:
        proc = subprocess.run(
            ["adb", "reverse", f"tcp:{port}", f"tcp:{port}"],
            capture_output=True,
            timeout=4,
            check=False,
        )
        return proc.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False
