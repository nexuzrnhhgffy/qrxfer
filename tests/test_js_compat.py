import json
import subprocess
import unittest
from pathlib import Path

from qrxfer.fountain import mix32, neighbors
from qrxfer.protocol import agree_params, crc32, encode_packet


ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / "pwa" / "js" / "protocol.js"


class JsCompatTests(unittest.TestCase):
    def test_neighbors_and_packets_match_javascript(self):
        script = r"""
const Q = require(process.argv[1]);
const session = 123456789, k = 17;
const neigh = [];
for (let seq = 0; seq < 40; seq++) neigh.push(Q.neighbors(session, seq, k));
const payload = new Uint8Array(16);
for (let i = 0; i < 16; i++) payload[i] = i + 3;
const pkt = Array.from(Q.encodePacket(7, 3, 4, 16, 50, payload));
const mixes = [];
for (let seq = 0; seq < 8; seq++) mixes.push(Q.mix32(session, seq));
const agreed = Q.agreeParams(40, 5, 30, 720);
const big = Array.from(Q.encodePacket(1, 2, 70000, 16, 50, payload));
console.log(JSON.stringify({neigh, pkt, mixes, crc: Q.crc32(payload), agreed, big, bigK: Q.decodePacket(big).k, maxFile: Q.MAX_FILE_BYTES}));
"""
        proc = subprocess.run(
            ["node", "-e", script, str(JS)],
            check=True,
            capture_output=True,
            text=True,
        )
        js = json.loads(proc.stdout)
        for seq, got in enumerate(js["neigh"]):
            self.assertEqual(got, neighbors(123456789, seq, 17), f"seq={seq}")
        payload = bytes(range(3, 19))
        py_pkt = list(encode_packet(7, 3, 4, 16, 50, payload))
        self.assertEqual(js["pkt"], py_pkt)
        self.assertEqual(js["crc"], crc32(payload))
        for seq, value in enumerate(js["mixes"]):
            self.assertEqual(value, mix32(123456789, seq), f"mix seq={seq}")
        self.assertEqual(js["agreed"]["qrVersion"], agree_params(40, 5, 30, 720)[0])
        self.assertEqual(js["agreed"]["fps"], agree_params(40, 5, 30, 720)[1])
        self.assertEqual(js["bigK"], 70000)
        self.assertEqual(js["big"], list(encode_packet(1, 2, 70000, 16, 50, payload)))
        self.assertEqual(js["maxFile"], 1024 * 1024 * 1024)


class MobileControlTests(unittest.TestCase):
    def test_huge_filename_control_still_fits(self):
        codec = ROOT / "pwa" / "js" / "codec.js"
        script = r"""
global.Qxfer = require(process.argv[1]);
global.self = global;
const B = require(process.argv[2]);
const Q = global.Qxfer;
const huge = Q.encodeHello({
  j: "ABC234",
  n: "content://media/external/file/" + "x".repeat(400) + ".jpg",
  o: 999999,
  t: 888888,
  k: 12345
});
const grid = B.encodeControl(huge, 32);
const got = B.decodeGrid(grid);
const meet = Q.encodeMeet("H", "ABC234");
const g2 = B.encodeControl(meet, 32);
const d2 = B.decodeGrid(g2);
const raw = new Uint8Array([1,2,3,4,5,6,7,8]);
const src = Q.buildChunkedSource("t.bin", raw, [{flag: 0, rawLen: raw.length, payload: raw}]);
console.log(JSON.stringify({
  meet: meet,
  meetParsed: Q.parseControl(d2.data ? new TextDecoder().decode(d2.data) : ""),
  recoveredJ: Q.parseControl(new TextDecoder().decode(got.data)).j,
  src: Array.from(src)
}));
"""
        proc = subprocess.run(
            ["node", "-e", script, str(JS), str(codec)],
            check=True,
            capture_output=True,
            text=True,
        )
        js = json.loads(proc.stdout)
        self.assertEqual(js["recoveredJ"], "ABC234")
        self.assertEqual(js["meetParsed"]["j"], "ABC234")
        from qrxfer.protocol import parse_source

        name, data = parse_source(bytes(js["src"]))
        self.assertEqual(name, "t.bin")
        self.assertEqual(data, bytes([1, 2, 3, 4, 5, 6, 7, 8]))


class DisplaySizeTests(unittest.TestCase):
    def test_fits_phone_and_desktop_without_filling_the_monitor(self):
        codec = ROOT / "pwa" / "js" / "codec.js"
        script = r"""
const B = require(process.argv[1]);
const phone = B.displaySize(390, 844, false);
const desk = B.displaySize(1920, 1080, false);
const land = B.displaySize(844, 390, false);
console.log(JSON.stringify({phone, desk, land}));
"""
        proc = subprocess.run(
            ["node", "-e", script, str(codec)],
            check=True,
            capture_output=True,
            text=True,
        )
        sizes = json.loads(proc.stdout)
        self.assertGreaterEqual(sizes["phone"], 180)
        self.assertLess(sizes["phone"], 390)
        self.assertLessEqual(sizes["desk"], 540)
        self.assertLess(sizes["desk"], 700)
        self.assertLessEqual(sizes["land"], 390)
        self.assertGreaterEqual(sizes["land"], 180)
