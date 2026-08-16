import unittest

from qrxfer.server import create_app


class FlaskServeTests(unittest.TestCase):
    def setUp(self):
        self.client = create_app().test_client()

    def _get(self, path):
        resp = self.client.get(path)
        try:
            body = resp.get_data(as_text=True)
            headers = dict(resp.headers)
            status = resp.status_code
        finally:
            resp.close()
        return status, headers, body

    def test_index_has_no_cdn(self):
        status, _, html = self._get("/")
        self.assertEqual(status, 200)
        self.assertNotIn("cdn.", html)
        self.assertNotIn("jsdelivr", html)
        self.assertIn("js/codec.js", html)
        self.assertIn('src="js/app.js"', html)

    def test_javascript_mime_is_not_plain_text(self):
        for path in ("/js/app.js", "/js/codec.js", "/js/protocol.js"):
            status, headers, _ = self._get(path)
            self.assertEqual(status, 200, path)
            ctype = headers["Content-Type"]
            self.assertTrue(
                ctype.startswith("application/javascript")
                or ctype.startswith("text/javascript"),
                f"{path} -> {ctype}",
            )
            self.assertNotIn("text/plain", ctype)

    def test_favicon_is_local(self):
        status, headers, _ = self._get("/favicon.ico")
        self.assertEqual(status, 200)
        self.assertIn("image/svg+xml", headers["Content-Type"])

    def test_send_does_not_open_camera(self):
        status, _, js = self._get("/js/app.js")
        self.assertEqual(status, 200)
        start = js.index("async function startSend")
        end = js.index("function playData")
        send_fn = js[start:end]
        self.assertNotIn("startCamera", send_fn)
        self.assertNotIn("getUserMedia", send_fn)
        recv_start = js.index("async function startReceive")
        recv_fn = js[recv_start:]
        self.assertIn("startCamera", recv_fn)
        self.assertIn("MAX_FILE_BYTES", js)

    def test_beacon_stays_square_and_not_stretched(self):
        status, _, css = self._get("/styles.css")
        self.assertEqual(status, 200)
        self.assertIn("aspect-ratio: 1 / 1", css)
        self.assertNotIn("#cam, #qrCanvas {\n    width: 100%;\n    height: 100%;", css)
        status, _, js = self._get("/js/codec.js")
        self.assertEqual(status, 200)
        self.assertIn("function displaySize", js)
        self.assertIn("540", js)
