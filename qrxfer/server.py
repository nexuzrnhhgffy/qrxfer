"""Flask UI — local static files, session API, LAN/USB access."""

from __future__ import annotations

import argparse
import os
import threading
import webbrowser

from flask import Flask, Response, jsonify, request, send_from_directory

from .hub import Hub
from .netinfo import lan_ipv4, try_adb_reverse

PWA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "pwa"))


def create_app(port: int = 8080) -> Flask:
    kwargs = {"static_folder": None}
    try:
        app = Flask(__name__, trusted_hosts=None, **kwargs)
    except TypeError:
        app = Flask(__name__, **kwargs)
    app.config["TRUSTED_HOSTS"] = None
    hub = Hub()

    @app.after_request
    def _headers(resp: Response):
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        return resp

    def _json_error(message: str, status: int):
        return jsonify({"error": message}), status

    def _body():
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else {}

    @app.route("/api/info")
    def api_info():
        ips = lan_ipv4()
        return jsonify(
            {
                "port": port,
                "this": request.host_url,
                "local": [f"http://127.0.0.1:{port}/"],
                "phone": [f"http://{ip}:{port}/" for ip in ips],
            }
        )

    @app.route("/api/sessions", methods=["POST", "OPTIONS"])
    def api_create_session():
        if request.method == "OPTIONS":
            return ("", 204)
        sess = hub.create(_body())
        return jsonify(sess)

    @app.route("/api/sessions/<code>", methods=["GET"])
    def api_get_session(code: str):
        sess = hub.get(code)
        if sess is None:
            return _json_error("نشست پیدا نشد", 404)
        return jsonify(sess)

    @app.route("/api/sessions/<code>/join", methods=["POST", "OPTIONS"])
    def api_join(code: str):
        if request.method == "OPTIONS":
            return ("", 204)
        body = _body()
        sess = hub.join(code, body.get("camFps") or 30, body.get("width") or 1280)
        if sess is None:
            return _json_error("نشست پیدا نشد", 404)
        return jsonify(sess)

    @app.route("/api/sessions/<code>/offer", methods=["POST", "OPTIONS"])
    def api_offer(code: str):
        if request.method == "OPTIONS":
            return ("", 204)
        body = _body()
        sess = hub.offer(code, int(body.get("k") or 0), int(body.get("optical") or 0))
        if sess is None:
            return _json_error("نشست پیدا نشد", 404)
        return jsonify(sess)

    @app.route("/api/sessions/<code>/start", methods=["POST", "OPTIONS"])
    def api_start(code: str):
        if request.method == "OPTIONS":
            return ("", 204)
        sess = hub.start(code)
        if sess is None:
            return _json_error("گیرنده هنوز آماده نیست", 409)
        return jsonify(sess)

    @app.route("/api/sessions/<code>/progress", methods=["POST", "OPTIONS"])
    def api_progress(code: str):
        if request.method == "OPTIONS":
            return ("", 204)
        body = _body()
        sess = hub.progress(
            code, int(body.get("recovered") or 0), int(body.get("k") or 0), int(body.get("seq") or 0)
        )
        if sess is None:
            return _json_error("نشست پیدا نشد", 404)
        return jsonify(sess)

    @app.route("/api/sessions/<code>/done", methods=["POST", "OPTIONS"])
    def api_done(code: str):
        if request.method == "OPTIONS":
            return ("", 204)
        body = _body()
        sess = hub.done(code, ok=bool(body.get("ok", True)), error=body.get("error"))
        if sess is None:
            return _json_error("نشست پیدا نشد", 404)
        return jsonify(sess)

    @app.route("/api/sessions/<code>/cancel", methods=["POST", "OPTIONS"])
    def api_cancel(code: str):
        if request.method == "OPTIONS":
            return ("", 204)
        sess = hub.cancel(code)
        if sess is None:
            return _json_error("نشست پیدا نشد", 404)
        return jsonify(sess)

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
        if filename.startswith("api/"):
            return _json_error("not found", 404)
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


def serve(host: str = "0.0.0.0", port: int = 8080, open_browser: bool = True) -> None:
    app = create_app(port=port)
    adb_ok = try_adb_reverse(port)
    print(f"Qxfer UI: http://127.0.0.1:{port}/")
    phones = lan_ipv4()
    if phones:
        print("از گوشی (USB / هات‌اسپات / LAN) یکی از این‌ها را باز کنید:")
        for ip in phones:
            print(f"  http://{ip}:{port}/")
    else:
        print("آدرس شبکه پیدا نشد. سرور روی همه کارت‌های شبکه گوش می‌دهد.")
    if adb_ok:
        print(f"adb reverse فعال است — روی گوشی بزنید: http://127.0.0.1:{port}/")
    else:
        print("اگر گوشی با کابل وصل است، USB debugging را روشن کنید تا adb reverse کار کند.")
    print("اگر گوشی وصل نشد، فایروال ویندوز پورت 8080 را ببندد.")
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(f"http://127.0.0.1:{port}/")).start()
    app.run(host=host, port=port, debug=False, threaded=True, use_reloader=False)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve the Qxfer Flask UI")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)
    serve(args.host, args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
