"""Producer robustness: a feed whose video can't open must fail loudly, not blank.

cv2.VideoCapture never raises on a bad path — it returns a not-opened capture and
cap.read() then yields (False, None) forever. The old loop rewound and `continue`d
on every failure, so a missing/corrupt clip spun at 100% CPU, emitted no packet,
and left the dashboard tile blank with no diagnostic. The producer must instead
emit a terminal SIGNAL LOST so the tile shows OFFLINE (a diagnosable state).

These exercise the open-failure path only, which returns BEFORE the heavy shared
YOLO model is loaded, so they need cv2 but not ultralytics.
"""
import os

import pytest

cv2 = pytest.importorskip("cv2")

from src import config  # noqa: E402
from src.producer import drone_producer  # noqa: E402


class _CapturingSender:
    def __init__(self):
        self.packets = []

    def send(self, packet):
        self.packets.append(packet)


def test_resolve_video_path_anchors_relative_paths_at_project_root():
    resolved = config.resolve_video_path("footage/drone_1.mp4")
    assert os.path.isabs(resolved)
    assert resolved == os.path.join(config._PROJECT_ROOT, "footage/drone_1.mp4")
    # the configured clips actually resolve to files on disk from any CWD
    assert os.path.exists(resolved)


def test_resolve_video_path_leaves_absolute_paths_untouched():
    abs_path = os.path.abspath(os.path.join("footage", "drone_1.mp4"))
    assert config.resolve_video_path(abs_path) == abs_path


def test_unopenable_video_emits_single_signal_lost_and_returns():
    """A bad path must NOT hang or spin: drone_producer returns promptly having
    emitted exactly one SIGNAL LOST / CRITICAL packet (no frame)."""
    sender = _CapturingSender()

    # Returns synchronously — no thread needed. If the guard regressed to the old
    # spin-forever behaviour this call would never return and the test would hang.
    drone_producer("DRONE_1", "does/not/exist.mp4", sender)

    assert len(sender.packets) == 1, "expected exactly one terminal SIGNAL LOST packet"
    pkt = sender.packets[0]
    assert pkt.drone_id == "DRONE_1"
    assert pkt.health["signal"] == "LOST"
    assert pkt.health["status"] == "CRITICAL"
    assert pkt.frame_b64 is None, "no frame ever decoded → tile shows the LOST overlay"
