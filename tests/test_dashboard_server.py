import json
import re
import subprocess
import sys
import http.client
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

from src import dashboard_server


def _config_payload(js: str) -> dict:
    match = re.fullmatch(r"window\.SIX_EYES_CONFIG = Object\.freeze\((.*)\);\n", js)
    assert match is not None
    return json.loads(match.group(1))


def test_runtime_config_uses_env_backed_values(monkeypatch):
    monkeypatch.setattr(dashboard_server.config, "MAPBOX_ACCESS_TOKEN", "test-token-from-env")
    monkeypatch.setattr(dashboard_server.config, "DASHBOARD_WS_URL", "wss://example.test/prod")
    monkeypatch.setattr(dashboard_server.config, "BASE_LON", -118.25)
    monkeypatch.setattr(dashboard_server.config, "BASE_LAT", 34.05)

    payload = _config_payload(dashboard_server.runtime_config_js())

    assert payload == {
        "MAPBOX_ACCESS_TOKEN": "test-token-from-env",
        "WS_URL": "wss://example.test/prod",
        "INITIAL_MAP_CENTER": [-118.25, 34.05],
    }


def test_runtime_config_falls_back_to_ws_host_port(monkeypatch):
    monkeypatch.setattr(dashboard_server.config, "MAPBOX_ACCESS_TOKEN", "")
    monkeypatch.setattr(dashboard_server.config, "DASHBOARD_WS_URL", "")
    monkeypatch.setattr(dashboard_server.config, "WS_HOST", "127.0.0.1")
    monkeypatch.setattr(dashboard_server.config, "WS_PORT", 9876)

    payload = _config_payload(dashboard_server.runtime_config_js())

    assert payload["MAPBOX_ACCESS_TOKEN"] == ""
    assert payload["WS_URL"] == "ws://127.0.0.1:9876"
    assert payload["INITIAL_MAP_CENTER"] == [
        dashboard_server.config.BASE_LON,
        dashboard_server.config.BASE_LAT,
    ]


def test_static_server_blocks_env_family_paths():
    for path in ("/.env", "/.env.local", "/nested/.env.production"):
        handler = SimpleNamespace(path=path)
        assert dashboard_server.DashboardRequestHandler._is_private_path(handler)


def test_static_server_allows_runtime_config_path():
    handler = SimpleNamespace(path="/runtime-config.js")
    assert not dashboard_server.DashboardRequestHandler._is_private_path(handler)


def test_direct_execution_does_not_raise_import_error():
    """`python src/dashboard_server.py` (direct run) must work, not only
    `python -m src.dashboard_server`. Before the import shim this raised
    `ImportError: attempted relative import with no known parent package`."""
    root = dashboard_server.PROJECT_ROOT
    script = root / "src" / "dashboard_server.py"
    result = subprocess.run(
        [sys.executable, str(script), "--check"],
        capture_output=True,
        text=True,
        cwd=str(root),
        timeout=30,
    )
    assert result.returncode == 0, f"stderr:\n{result.stderr}"
    assert "--check OK" in result.stdout
    assert "ImportError" not in result.stderr


def test_module_execution_also_works():
    """The documented `python -m src.dashboard_server` launch path still works."""
    root = dashboard_server.PROJECT_ROOT
    result = subprocess.run(
        [sys.executable, "-m", "src.dashboard_server", "--check"],
        capture_output=True,
        text=True,
        cwd=str(root),
        timeout=30,
    )
    assert result.returncode == 0, f"stderr:\n{result.stderr}"
    assert "--check OK" in result.stdout


def _http_get(server, path):
    conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
    conn.request("GET", path)
    response = conn.getresponse()
    body = response.read()
    conn.close()
    return response, body


def test_env_file_is_not_served_over_http(monkeypatch):
    """The secret-bearing `.env` must never be reachable as a static file, even
    though the server's document root is the project root that contains it."""
    monkeypatch.setattr(dashboard_server.config, "MAPBOX_ACCESS_TOKEN", "should-not-leak")
    handler = partial(
        dashboard_server.DashboardRequestHandler,
        directory=str(dashboard_server.PROJECT_ROOT),
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for path in ("/.env", "/.env.local", "/.git/config"):
            response, _ = _http_get(server, path)
            assert response.status == 404, f"{path} should be blocked, got {response.status}"

        # The token is delivered ONLY through the generated runtime-config script,
        # not by exposing the .env file itself.
        response, body = _http_get(server, "/runtime-config.js")
        assert response.status == 200
        assert b"should-not-leak" in body
    finally:
        server.shutdown()
        server.server_close()


def test_favicon_request_is_served_without_404():
    handler = partial(
        dashboard_server.DashboardRequestHandler,
        directory=str(dashboard_server.PROJECT_ROOT),
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
        conn.request("GET", "/favicon.ico")
        response = conn.getresponse()
        body = response.read()
        conn.close()

        assert response.status == 200
        assert response.getheader("Content-Type") == "image/svg+xml"
        assert body.startswith(b"<svg")
    finally:
        server.shutdown()
        server.server_close()
