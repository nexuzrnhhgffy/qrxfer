import unittest

from qrxfer.hub import Hub, normalize_code


class HubTests(unittest.TestCase):
    def test_join_start_and_progress(self):
        hub = Hub()
        sess = hub.create({"name": "a.txt", "orig": 10, "compressed": 4, "grid": 40, "fps": 4, "optical": 9})
        code = sess["code"]
        self.assertEqual(len(code), 6)
        self.assertEqual(normalize_code(code.lower()), code)
        self.assertIsNone(hub.get("nope"))

        joined = hub.join(code.lower(), cam_fps=30, cam_width=720)
        self.assertEqual(joined["status"], "joined")
        self.assertEqual(joined["grid"], 32)
        self.assertEqual(joined["fps"], 3)

        self.assertIsNone(hub.start(code))
        offered = hub.offer(code, k=12, optical=9)
        self.assertEqual(offered["k"], 12)
        started = hub.start(code)
        self.assertEqual(started["status"], "sending")

        hub.progress(code, recovered=4, k=12, seq=8)
        done = hub.done(code, ok=True)
        self.assertEqual(done["status"], "done")
        self.assertEqual(done["progress"]["recovered"], 4)
