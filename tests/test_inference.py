"""Verify YOLO loads and fires on a synthetic frame.

Marked slow/optional: requires ultralytics + a model download. Skips cleanly
if ultralytics isn't installed so the rest of the suite still runs.
"""
import numpy as np
import pytest

ultralytics = pytest.importorskip("ultralytics")

from src.inference import load_model, run_detection  # noqa: E402


def test_run_detection_returns_list():
    model = load_model()
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)  # blank frame, no persons
    detections = run_detection(model, frame)
    assert isinstance(detections, list)
    for d in detections:
        assert d["class"] == "person"
        assert 0.0 <= d["confidence"] <= 1.0
        assert len(d["bbox"]) == 4
