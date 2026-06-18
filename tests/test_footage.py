"""Footage integrity + config-coherence checks.

These guard the data that must be correct *before* the producer is wired to the
real pipeline: every configured clip exists and decodes, and every START_OFFSET
fits inside its clip with distinct offsets per shared clip (otherwise the
desync that makes the six feeds look independent is silently lost — the producer
seeks past EOF, reads nothing, and falls back to frame 0).

Skips cleanly if a clip is missing so the rest of the suite still runs on a
checkout without footage (the .mp4 files are gitignored).
"""
import os
from collections import defaultdict

import pytest

from src import config

cv2 = pytest.importorskip("cv2")


def _missing_clips():
    return [p for p in set(config.VIDEO_PATHS.values()) if not os.path.exists(p)]


needs_footage = pytest.mark.skipif(
    bool(_missing_clips()),
    reason=f"footage not present: {_missing_clips()}",
)


def _frame_count(path):
    cap = cv2.VideoCapture(path)
    try:
        return int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    finally:
        cap.release()


def test_all_six_drones_have_a_video_path():
    assert set(config.VIDEO_PATHS) == set(config.DRONE_IDS)
    assert set(config.START_OFFSETS) == set(config.DRONE_IDS)


@needs_footage
@pytest.mark.parametrize("drone_id", config.DRONE_IDS)
def test_clip_opens_and_decodes(drone_id):
    path = config.VIDEO_PATHS[drone_id]
    cap = cv2.VideoCapture(path)
    try:
        assert cap.isOpened(), f"{path} did not open"
        assert int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) > 0, f"{path} has no frames"
        assert cap.get(cv2.CAP_PROP_FPS) > 0, f"{path} reports no FPS"
        ret, frame = cap.read()
        assert ret and frame is not None, f"{path} failed to decode first frame"
    finally:
        cap.release()


@needs_footage
@pytest.mark.parametrize("drone_id", config.DRONE_IDS)
def test_start_offset_within_clip_bounds(drone_id):
    """An offset past EOF silently collapses the desync to frame 0."""
    path = config.VIDEO_PATHS[drone_id]
    n = _frame_count(path)
    offset = config.START_OFFSETS[drone_id]
    assert 0 <= offset < n, (
        f"{drone_id} START_OFFSET={offset} is out of bounds for {path} "
        f"({n} frames) — desync would be lost"
    )


@needs_footage
def test_offsets_distinct_per_shared_clip():
    """Drones reusing the same clip must start at different frames, or they
    play in lockstep and the reuse becomes visually obvious."""
    by_clip = defaultdict(dict)
    for drone_id, path in config.VIDEO_PATHS.items():
        by_clip[path][drone_id] = config.START_OFFSETS[drone_id]

    for path, offsets in by_clip.items():
        vals = list(offsets.values())
        assert len(vals) == len(set(vals)), (
            f"{path} is shared by {offsets} with duplicate offsets — "
            f"those feeds would be synchronized"
        )


@needs_footage
def test_at_least_two_drones_on_validated_person_clips():
    """The demo needs >=2 'person detected' drones (DroneFootageTask Step 4)."""
    # drone_1.mp4 and drone_2.mp4 are the validated person clips.
    person_clips = {"footage/drone_1.mp4", "footage/drone_2.mp4"}
    on_person = [d for d, p in config.VIDEO_PATHS.items() if p in person_clips]
    assert len(on_person) >= 2, f"only {on_person} point at validated person clips"
