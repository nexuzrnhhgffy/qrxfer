import unittest

from qrxfer.blockcode import (
    TYPE_CONTROL,
    TYPE_DATA,
    decode_grid,
    decode_image,
    encode_control,
    encode_data,
    payload_capacity,
    render_grid,
    unwrap_payload,
    wrap_payload,
)
from qrxfer.protocol import encode_hello


class BlockcodeTests(unittest.TestCase):
    def test_wrap_crc(self):
        blob = wrap_payload(TYPE_CONTROL, b"hello")
        kind, data = unwrap_payload(blob)
        self.assertEqual(kind, TYPE_CONTROL)
        self.assertEqual(data, b"hello")
        self.assertIsNone(unwrap_payload(blob[:-1] + bytes([blob[-1] ^ 1])))

    def test_grid_control_roundtrip(self):
        text = encode_hello({"s": 7, "n": "a.txt", "g": 32, "f": 4})
        grid = encode_control(text, 32)
        got = decode_grid(grid)
        self.assertIsNotNone(got)
        self.assertEqual(got[0], TYPE_CONTROL)
        self.assertEqual(got[1].decode("utf-8"), text)

    def test_render_and_scan(self):
        packet = b"QXF1" + bytes(range(40))
        self.assertLess(len(wrap_payload(TYPE_DATA, packet)), payload_capacity(32) + 7)
        frame = render_grid(encode_data(packet, 32), size=480)
        got = decode_image(frame, grids=(32,))
        self.assertIsNotNone(got)
        self.assertEqual(got[0], TYPE_DATA)
        self.assertEqual(got[1], packet)
