"""Flask UI — local static files only, no CDN."""

from __future__ import annotations

import argparse
import os
import threading
import webbrowser

from flask import Flask, Response, send_from_directory

PWA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "pwa"))


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)

    @app.after_request
    def _no_cache(resp: Response):
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        return resp

    @app.route("/")
    def index():
        resp = send_from_directory(PWA_DIR, "index.html")
        resp.headers["Content-Type"] = "text/html; charset=utf-8"
        return resp

    @app.route("/favicon.ico")
    def favicon():
        return send_from_directory(PWA_DIR, "favicon.svg", mimetype="image/svg+xml")

    @app.route("/<path:filename>")
    def static_file(filename: str):
        lower = filename.lower()
        mime = None
        if lower.endswith(".js"):
            mime = "application/javascript; charset=utf-8"
        elif lower.endswith(".css"):
            mime = "text/css; charset=utf-8"
        elif lower.endswith(".json") or lower.endswith(".webmanifest"):
            mime = "application/json; charset=utf-8"
        elif lower.endswith(".html"):
            mime = "text/html; charset=utf-8"
        elif lower.endswith(".svg"):
            mime = "image/svg+xml"
        return send_from_directory(PWA_DIR, filename, mimetype=mime)

    return app


def serve(host: str = "127.0.0.1", port: int = 8080, open_browser: bool = True) -> None:
    app = create_app()
    url = f"http://{host}:{port}/"
    print(f"Qxfer UI: {url}")
    print("یک صفحه — ارسال / دریافت. بدون CDN.")
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    app.run(host=host, port=port, debug=False, threaded=True, use_reloader=False)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve the Qxfer Flask UI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)
    serve(args.host, args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
