"""Local static server for the PWA (camera APIs need http://localhost)."""

from __future__ import annotations

import argparse
import functools
import os
import socketserver
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler

PWA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "pwa"))


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".json": "application/json",
        ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json",
    }

    def log_message(self, fmt, *args):
        sys.stderr.write("[qrxfer] " + (fmt % args) + "\n")

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def serve(host: str = "127.0.0.1", port: int = 8080, open_browser: bool = True) -> None:
    handler = functools.partial(Handler, directory=PWA_DIR)
    with socketserver.ThreadingTCPServer((host, port), handler) as httpd:
        httpd.daemon_threads = True
        url = f"http://{host}:{port}/"
        print(f"Qxfer UI: {url}")
        print("Send tab: choose a file and play QR codes fullscreen.")
        print("Receive tab: record the other screen, then analyze.")
        if open_browser:
            threading.Timer(0.4, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve the Qxfer web UI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)
    serve(args.host, args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
