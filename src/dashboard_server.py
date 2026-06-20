"""Local dashboard HTTP server.

Serves the vanilla HTML dashboard plus a generated runtime config script. This
keeps API access tokens in `.env` instead of embedding them in the codebase.

Run with:
    python -m src.dashboard_server
"""
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlparse

from . import config


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DASHBOARD_FILE = "six_eyes_dashboard.html"
FAVICON_SVG = b"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="10" fill="#08070c"/><circle cx="32" cy="32" r="18" fill="none" stroke="#9333ea" stroke-width="5"/><circle cx="32" cy="32" r="5" fill="#a78bfa"/></svg>"""


def _dashboard_ws_url() -> str:
    if config.DASHBOARD_WS_URL:
        return config.DASHBOARD_WS_URL
    return f"ws://{config.WS_HOST}:{config.WS_PORT}"


def runtime_config_js() -> str:
    payload = {
        "MAPBOX_ACCESS_TOKEN": config.MAPBOX_ACCESS_TOKEN,
        "WS_URL": _dashboard_ws_url(),
        "INITIAL_MAP_CENTER": [config.BASE_LON, config.BASE_LAT],
    }
    return f"window.SIX_EYES_CONFIG = Object.freeze({json.dumps(payload)});\n"


class DashboardRequestHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("", "/"):
            self.path = f"/{DASHBOARD_FILE}"
        path = self.path.split("?", 1)[0]
        if path == "/runtime-config.js":
            self._serve_runtime_config()
            return
        if path == "/favicon.ico":
            self._serve_favicon()
            return
        super().do_GET()

    def send_head(self):
        if self._is_private_path():
            self.send_error(404)
            return None
        return super().send_head()

    def _is_private_path(self):
        request_path = PurePosixPath(unquote(urlparse(self.path).path))
        private_roots = {".git", ".venv", ".pytest_cache", ".claude"}
        return any(
            part in private_roots or part == ".env" or part.startswith(".env.")
            for part in request_path.parts
        )

    def _serve_runtime_config(self):
        body = runtime_config_js().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/javascript; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_favicon(self):
        self.send_response(200)
        self.send_header("Content-Type", "image/svg+xml")
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Content-Length", str(len(FAVICON_SVG)))
        self.end_headers()
        self.wfile.write(FAVICON_SVG)


def main():
    handler = partial(DashboardRequestHandler, directory=str(PROJECT_ROOT))
    server = ThreadingHTTPServer((config.DASHBOARD_HOST, config.DASHBOARD_PORT), handler)
    url = f"http://{config.DASHBOARD_HOST}:{config.DASHBOARD_PORT}/"
    print(f"[dashboard] Serving SIX-EYES dashboard at {url}")
    if not config.MAPBOX_ACCESS_TOKEN:
        print("[dashboard] MAPBOX_ACCESS_TOKEN is not set; Mapbox tiles will not load.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[dashboard] Stopping.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
