"""End-to-end producer integration against real footage.

Drives the actual drone_producer loop (real MP4 -> cv2 -> YOLO -> build_packet)
with a capturing sender, then asserts the emitted packets are well-formed,
JSON-serializable, and that the designated demo drone actually detects people.

Slow + optional: needs ultralytics, a model download, and the footage. Skips
cleanly otherwise so the fast suite still runs.
"""
import json
import os
import threading
import time
from dataclasses import asdict

import pytest

pytest.importorskip("ultralytics")
cv2 = pytest.importorskip("cv2")

from src import config  # noqa: E402
from src.producer import drone_producer, stop_events  # noqa: E402

# DRONE_1 -> drone_1.mp4, a validated person clip (DroneFootageTask Step 3).
DEMO_DRONE = "DRONE_1"

pytestmark = pytest.mark.skipif(
    not os.path.exists(config.VIDEO_PATHS[DEMO_DRONE]),
    reason=f"footage not present: {config.VIDEO_PATHS[DEMO_DRONE]}",
)


class _CapturingSender:
    def __init__(self):
        self.packets = []

    def send(self, packet):
        self.packets.append(packet)


def _run_producer(drone_id, target_count=30, timeout_s=20):
    sender = _CapturingSender()
    stop_events[drone_id].clear()
    t = threading.Thread(
        target=drone_producer,
        args=(drone_id, config.VIDEO_PATHS[drone_id], sender,
              config.START_OFFSETS[drone_id]),
        daemon=True,
    )
    t.start()
    deadline = time.time() + timeout_s
    while len(sender.packets) < target_count and time.time() < deadline:
        time.sleep(0.2)
    stop_events[drone_id].set()
    t.join(timeout=5)
    return sender.packets


def test_producer_emits_wellformed_serializable_packets():
    packets = _run_producer(DEMO_DRONE)
    assert packets, "producer emitted no packets"

    # frame_idx is monotonic from 0 (drives video sync downstream).
    assert [p.frame_idx for p in packets] == list(range(len(packets)))

    for p in packets:
        d = asdict(p)
        json.dumps(d)  # wire format must serialize
        assert d["drone_id"] == DEMO_DRONE
        assert d["mission"]["zone"] == config.assign_zone(DEMO_DRONE)
        for det in d["detections"]:
            assert det["class"] == "person"
            assert 0.0 <= det["confidence"] <= 1.0
            assert len(det["bbox"]) == 4


def test_demo_drone_actually_detects_people():
    """The 'person detected' demo scenario must stay triggerable on this clip."""
    packets = _run_producer(DEMO_DRONE, target_count=40)
    total = sum(len(p.detections) for p in packets)
    assert total > 0, (
        f"{DEMO_DRONE} ({config.VIDEO_PATHS[DEMO_DRONE]}) produced no detections "
        f"over {len(packets)} frames — footage may have regressed"
    )


def test_packets_carry_decodable_video_frames():
    """Live video: every packet must carry a base64 JPEG the dashboard can render."""
    import base64
    import numpy as np

    packets = _run_producer(DEMO_DRONE)
    assert packets, "producer emitted no packets"
    for p in packets:
        assert p.frame_b64, "packet missing frame_b64 — dashboard video would be blank"
    # Spot-check the first frame actually decodes back to an image.
    raw = base64.b64decode(packets[0].frame_b64)
    decoded = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    assert decoded is not None


# --- Foundry sink wiring (additive secondary sink, .claude/foundary-task.md) --
# These exercise the producer-side wiring of write_telemetry/write_detection
# (throttling, gating, row shape) with the actual write_* functions captured, so
# no live Foundry instance is touched.

class _FoundrySender:
    def __init__(self, foundry_enabled):
        self.foundry_enabled = foundry_enabled
        self.packets = []

    def send(self, packet):
        self.packets.append(packet)


def _run_producer_with_foundry(monkeypatch, foundry_enabled, target_count=30,
                               telemetry_interval=0.5, timeout_s=20):
    import src.producer as producer

    tele, det = [], []
    monkeypatch.setattr(producer, "write_telemetry", lambda row: tele.append(row) or True)
    monkeypatch.setattr(producer, "write_detection", lambda row: det.append(row) or True)
    monkeypatch.setattr(producer, "start_foundry_flusher", lambda: None)
    monkeypatch.setattr(producer, "TELEMETRY_WRITE_INTERVAL_S", telemetry_interval)

    sender = _FoundrySender(foundry_enabled)
    stop_events[DEMO_DRONE].clear()
    t = threading.Thread(
        target=producer.drone_producer,
        args=(DEMO_DRONE, config.VIDEO_PATHS[DEMO_DRONE], sender,
              config.START_OFFSETS[DEMO_DRONE]),
        daemon=True,
    )
    t.start()
    deadline = time.time() + timeout_s
    while len(sender.packets) < target_count and time.time() < deadline:
        time.sleep(0.2)
    stop_events[DEMO_DRONE].set()
    t.join(timeout=5)
    return sender, tele, det


def test_producer_writes_foundry_rows_when_enabled(monkeypatch):
    sender, tele, det = _run_producer_with_foundry(monkeypatch, foundry_enabled=True)

    assert sender.packets, "WS path emitted nothing — primary sink regressed"
    # Telemetry is throttled, not per-frame: with a 0.5s interval over the run we
    # expect several writes but far fewer than the frame count.
    assert len(tele) >= 2, f"expected throttled telemetry writes, got {len(tele)}"
    assert len(tele) < len(sender.packets), "telemetry must not be written per frame"
    for r in tele:  # flat row, no video, built from packet data
        assert "frame_b64" not in r
        assert {"drone_id", "lat", "lon", "battery", "zone"} <= r.keys()
        assert r["drone_id"] == DEMO_DRONE
    # The demo drone detects people, so detection rows should land and be well-formed.
    assert det, "demo drone produced no detection rows — YOLO/footage may have regressed"
    for r in det:
        assert len(r["detection_id"]) == 36 and 0.0 <= r["confidence"] <= 1.0


def test_producer_writes_nothing_to_foundry_when_disabled(monkeypatch):
    sender, tele, det = _run_producer_with_foundry(monkeypatch, foundry_enabled=False)
    assert sender.packets, "WS path must still emit when Foundry is disabled"
    assert tele == [] and det == [], "Foundry writes must be gated by foundry_enabled"
