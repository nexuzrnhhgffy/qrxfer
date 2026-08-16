import os
import random
import tempfile
import unittest

from qrxfer.constants import block_size_for_version
from qrxfer.fountain import LTDecoder, LTEncoder, neighbors
from qrxfer.protocol import TransferDecoder, TransferEncoder, decode_packet, encode_packet


class FountainTests(unittest.TestCase):
    def test_systematic_neighbors(self):
        for seq in range(10):
            self.assertEqual(neighbors(99, seq, 10), [seq])

    def test_neighbors_are_deterministic(self):
        a = neighbors(123456789, 40, 17)
        b = neighbors(123456789, 40, 17)
        self.assertEqual(a, b)
        self.assertTrue(1 <= len(a) <= 17)
        self.assertEqual(a, sorted(set(a)))

    def test_roundtrip_with_loss(self):
        rng = random.Random(0)
        data = bytes(rng.getrandbits(8) for _ in range(8000))
        enc = LTEncoder(data, block_size=64, session_id=0xA11CE5)
        dec = LTDecoder()
        sent = 0
        for seq in range(enc.k * 5):
            if rng.random() < 0.4:
                continue
            payload = enc.symbol(seq)
            dec.add(enc.session_id, seq, enc.k, enc.block_size, enc.total_len, payload)
            sent += 1
            if dec.ready:
                break
        self.assertTrue(dec.finish(), f"failed after {sent} packets, recovered {dec.recovered_count}/{dec.k}")
        self.assertEqual(dec.assemble(), data)

    def test_packet_crc_and_padding(self):
        payload = b"\x01\x02\x03\x04" + b"\x00" * 12
        raw = encode_packet(7, 3, 4, 16, 50, payload)
        pkt = decode_packet(raw + b"\x00\x00TRAILING")
        self.assertIsNotNone(pkt)
        self.assertEqual(pkt.payload, payload)
        self.assertIsNone(decode_packet(raw[:-1] + bytes([(raw[-1] ^ 1)])))

    def test_file_transfer_roundtrip(self):
        payload = b"hello qrxfer \x00\xff" * 200
        block = block_size_for_version(12)
        enc = TransferEncoder("note.txt", payload, block, session_id=42)
        dec = TransferDecoder()
        for seq in range(int(enc.k * 1.8) + 8):
            dec.ingest(enc.packet(seq))
            if dec.ready:
                break
        name, data = dec.result()
        self.assertEqual(name, "note.txt")
        self.assertEqual(data, payload)

    def test_lzma_and_handshake(self):
        from qrxfer.protocol import (
            agree_params,
            compress_payload,
            decompress_payload,
            encode_hello,
            parse_control,
        )

        data = (b"qrxfer " * 800) + bytes(range(64))
        packed = compress_payload(data)
        self.assertLess(len(packed), len(data) // 2)
        self.assertEqual(decompress_payload(packed, 2), data)
        hello = encode_hello({"s": 9, "n": "a.txt", "v": 18, "f": 5})
        parsed = parse_control(hello)
        self.assertEqual(parsed["type"], "H")
        self.assertEqual(parsed["s"], 9)
        self.assertEqual(agree_params(40, 5, 30, 720), (32, 3))
        self.assertEqual(agree_params(40, 5, 60, 1920), (40, 5))


class QrPipelineTests(unittest.TestCase):
    def test_qr_image_roundtrip(self):
        from qrxfer.blockcode import TYPE_DATA, block_size_for_grid, decode_image, encode_data, render_grid

        payload = os.urandom(400)
        block = block_size_for_grid(32)
        enc = TransferEncoder("rand.bin", payload, block, session_id=99)
        dec = TransferDecoder()
        for seq in range(int(enc.k * 2) + 4):
            frame = render_grid(encode_data(enc.packet(seq), 32), size=480)
            got = decode_image(frame, grids=(32,))
            self.assertIsNotNone(got, f"grid not decoded at seq={seq}")
            self.assertEqual(got[0], TYPE_DATA)
            dec.ingest(got[1])
        name, data = dec.result()
        self.assertEqual(name, "rand.bin")
        self.assertEqual(data, payload)

    def test_video_roundtrip(self):
        from qrxfer.decoder import VideoDecoder
        from qrxfer.generator import QRVideoGenerator

        payload = b"video-pipe-" + os.urandom(300)
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "tiny.bin")
            out = os.path.join(tmp, "out.mp4")
            with open(src, "wb") as f:
                f.write(payload)
            QRVideoGenerator(
                grid=32, fps=4, qr_size=480, overhead=1.8, repeats=1
            ).generate(src, out, session_id=123)
            decoder = VideoDecoder()
            ok = decoder.process_video(out)
            self.assertTrue(ok, "video decode failed")
            dest = decoder.save(tmp)
            with open(dest, "rb") as f:
                self.assertEqual(f.read(), payload)


if __name__ == "__main__":
    unittest.main()
