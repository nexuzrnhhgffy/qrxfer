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
const agreed = Q.agreeParams(25, 8, 30, 720);
console.log(JSON.stringify({neigh, pkt, mixes, crc: Q.crc32(payload), agreed}));
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
        self.assertEqual(js["agreed"]["qrVersion"], agree_params(25, 8, 30, 720)[0])
        self.assertEqual(js["agreed"]["fps"], agree_params(25, 8, 30, 720)[1])
