import unittest

from qrxfer.server import create_app


class FlaskServeTests(unittest.TestCase):
    def setUp(self):
        self.client = create_app().test_client()

    def test_index_has_no_cdn(self):
        resp = self.client.get("/")
        self.assertEqual(resp.status_code, 200)
        html = resp.get_data(as_text=True)
        self.assertNotIn("cdn.", html)
        self.assertNotIn("jsdelivr", html)
        self.assertIn("js/codec.js", html)
        self.assertIn('src="js/app.js"', html)

    def test_javascript_mime_is_not_plain_text(self):
        for path in ("/js/app.js", "/js/codec.js", "/js/protocol.js"):
            resp = self.client.get(path)
            self.assertEqual(resp.status_code, 200, path)
            ctype = resp.headers["Content-Type"]
            self.assertTrue(
                ctype.startswith("application/javascript")
                or ctype.startswith("text/javascript"),
                f"{path} -> {ctype}",
            )
            self.assertNotIn("text/plain", ctype)

    def test_favicon_is_local(self):
        resp = self.client.get("/favicon.ico")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("image/svg+xml", resp.headers["Content-Type"])
