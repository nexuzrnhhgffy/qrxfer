"""Shared constants for the Qxfer optical transfer protocol."""

MAGIC = b"QXF1"
PROTOCOL_VERSION = 2
HEADER_SIZE = 20  # bytes before payload
CRC_SIZE = 4
PACKET_OVERHEAD = HEADER_SIZE + CRC_SIZE  # 24

# Byte-mode capacity at error-correction level L (ISO/IEC 18004).
QR_BYTE_CAPACITY_L = {
    1: 17, 2: 32, 3: 53, 4: 78, 5: 106, 6: 134, 7: 154, 8: 192,
    9: 230, 10: 271, 11: 321, 12: 367, 13: 425, 14: 458, 15: 520,
    16: 586, 17: 644, 18: 718, 19: 792, 20: 858, 21: 929, 22: 1003,
    23: 1091, 24: 1171, 25: 1273, 26: 1367, 27: 1465, 28: 1528,
    29: 1628, 30: 1732, 31: 1840, 32: 1952, 33: 2068, 34: 2188,
    35: 2303, 36: 2431, 37: 2563, 38: 2699, 39: 2809, 40: 2953,
}

# A few extra bytes of slack so QR encoders that count headers strictly still fit.
QR_SLACK = 4

PRESETS = {
    "reliable": {
        "qr_version": 12,
        "grid": 32,
        "fps": 3,
        "ecc": "L",
        "label": "Reliable (phone / distance)",
    },
    "balanced": {
        "qr_version": 18,
        "grid": 40,
        "fps": 4,
        "ecc": "L",
        "label": "Balanced",
    },
    "fast": {
        "qr_version": 25,
        "grid": 48,
        "fps": 6,
        "ecc": "L",
        "label": "Fast (close, good light)",
    },
}

DEFAULT_PRESET = "balanced"
DEFAULT_OVERHEAD = 1.7
LOCK_COLOR = (0, 230, 118)  # RGB green used as the camera-lock frame
LOCK_BORDER = 28
MAX_NAME_BYTES = 180


def block_size_for_version(qr_version: int) -> int:
    if qr_version not in QR_BYTE_CAPACITY_L:
        raise ValueError(f"Unsupported QR version: {qr_version}")
    size = QR_BYTE_CAPACITY_L[qr_version] - PACKET_OVERHEAD - QR_SLACK
    if size < 32:
        raise ValueError(f"QR version {qr_version} is too small for Qxfer packets")
    return size
