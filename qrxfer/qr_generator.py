import numpy as np
from PIL import Image
import logging
import qrcode
from qrcode.constants import ERROR_CORRECT_L, ERROR_CORRECT_M, ERROR_CORRECT_Q, ERROR_CORRECT_H

from .constants import LOCK_BORDER, LOCK_COLOR

logger = logging.getLogger(__name__)

_ECC = {
    "L": ERROR_CORRECT_L,
    "M": ERROR_CORRECT_M,
    "Q": ERROR_CORRECT_Q,
    "H": ERROR_CORRECT_H,
}


class QRCodeGenerator:
    def __init__(
        self,
        version=18,
        qr_size=720,
        border_color=LOCK_COLOR,
        border_width=LOCK_BORDER,
        ecc="L",
        quiet_zone=4,
    ):
        self.version = version
        self.qr_size = qr_size
        self.border_color = border_color
        self.border_width = border_width
        self.ecc = ecc
        self.quiet_zone = quiet_zone

    def generate_qr_code(self, data: bytes) -> np.ndarray:
        modules_count = (self.version * 4) + 17
        target_modules = modules_count + (self.quiet_zone * 2)
        box_size = max(4, self.qr_size // target_modules)

        qr = qrcode.QRCode(
            version=self.version,
            error_correction=_ECC[self.ecc],
            box_size=box_size,
            border=self.quiet_zone,
        )
        qr.add_data(data, optimize=0)
        qr.make(fit=False)

        img = qr.make_image(fill_color=(0, 0, 0), back_color=(255, 255, 255)).convert("RGB")

        if img.size[0] != self.qr_size or img.size[1] != self.qr_size:
            canvas = Image.new("RGB", (self.qr_size, self.qr_size), (255, 255, 255))
            offset = (
                (self.qr_size - img.size[0]) // 2,
                (self.qr_size - img.size[1]) // 2,
            )
            canvas.paste(img, offset)
            img = canvas

        bordered_size = self.qr_size + (2 * self.border_width)
        bordered = Image.new("RGB", (bordered_size, bordered_size), self.border_color)
        bordered.paste(img, (self.border_width, self.border_width))
        return np.array(bordered)
