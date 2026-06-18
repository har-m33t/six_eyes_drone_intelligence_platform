"""Video frame encoding + dual-sink frame routing.

frame_b64 is the base64 JPEG the dashboard renders (data:image/jpeg;base64,...).
It travels on the WebSocket path only; the Foundry telemetry dataset has no
video column, so the secondary sink must strip it.
"""
import base64
import time
from dataclasses import asdict

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from src import config  # noqa: E402
from src.packet import build_packet  # noqa: E402
from src.producer import encode_frame_b64  # noqa: E402
from src.transport import foundry_client  # noqa: E402


def _frame(h=720, w=1280):
    # Non-uniform content so JPEG actually encodes something decodable.
    return np.random.randint(0, 255, (h, w, 3), dtype=np.uint8)


def test_encode_frame_b64_is_decodable_jpeg():
    b64 = encode_frame_b64(_frame(), width=640, quality=70)
    assert isinstance(b64, str) and b64
    raw = base64.b64decode(b64)
    decoded = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    assert decoded is not None, "frame_b64 did not decode back to an image"


def test_encode_frame_b64_downscales_to_width():
    b64 = encode_frame_b64(_frame(h=1080, w=1920), width=640, quality=70)
    raw = base64.b64decode(b64)
    decoded = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    assert decoded.shape[1] == 640
    assert decoded.shape[0] == round(1080 * 640 / 1920)  # aspect preserved


def test_encode_frame_b64_disabled_returns_none():
    assert encode_frame_b64(_frame(), width=0) is None


def test_packet_carries_frame_b64_through_json():
    p = build_packet("DRONE_1", frame_idx=0, detections=[], frame_b64="QUJD")
    d = asdict(p)
    assert d["frame_b64"] == "QUJD"
    import json
    assert json.loads(json.dumps(d))["frame_b64"] == "QUJD"


def test_foundry_payload_strips_frame_b64_but_keeps_telemetry(monkeypatch):
    """Secondary sink must drop the video frame; primary (WS) keeps it."""
    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["json"] = json
        return None

    monkeypatch.setattr(foundry_client.requests, "post", fake_post)

    packet = build_packet("DRONE_1", frame_idx=0, detections=[], frame_b64="BIGFRAME")
    foundry_client.push_to_foundry(packet)

    deadline = time.time() + 2
    while "json" not in captured and time.time() < deadline:
        time.sleep(0.02)

    assert "json" in captured, "Foundry push never fired"
    payload = captured["json"]
    assert "frame_b64" not in payload, "video frame must not go to Foundry"
    # Telemetry the dataset DOES want is still present.
    assert payload["drone_id"] == "DRONE_1"
    assert "gps" in payload and "health" in payload

    # The WebSocket payload, by contrast, keeps the frame.
    assert asdict(packet)["frame_b64"] == "BIGFRAME"
