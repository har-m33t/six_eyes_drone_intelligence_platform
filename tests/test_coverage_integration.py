"""Integration-contract tests for the dashboard coverage feature (Priority #3).

The dashboard (`six_eyes_dashboard.html`, Tasks 1 & 2 in
`.claude/dashboard_coverage.md`) consumes a *navigation telemetry* WebSocket
stream with this shape:

    {drone_id, x, y, current_waypoint_idx, waypoints_remaining, mission_complete}

`src/coverage_planner.py` can GENERATE the waypoints, but as of this review
**nothing in the runtime flies them or emits that packet shape**, and the
WebSocket `broadcast()` serialises with `dataclasses.asdict()`, which only
accepts dataclass instances — a plain nav dict cannot pass through unchanged.

So the dashboard's Task 1 (`recordCoverage`) and Task 2 (`updateCoverageStat`)
handlers are wired but never fire against the real backend. The tests below pin
that gap. The two `xfail(strict=True)` tests fail today and will XPASS (failing
the run) once the backend is wired — that is the signal to remove the marker.

See `.claude/dashboard_coverage_review.md` for the full write-up.
"""
import dataclasses
import pathlib

import pytest

from src import coverage_planner

SRC = pathlib.Path(__file__).resolve().parents[1] / "src"


# --------------------------------------------------------------------------- #
# What works today: the planner half of the feature.
# --------------------------------------------------------------------------- #
def test_planner_emits_json_safe_xy_waypoints():
    """The frontend reads telemetry.x / telemetry.y as plain numbers. The planner
    already yields plain float tuples, so the *waypoint* contract is satisfiable."""
    mission = coverage_planner.plan_mission(
        [(0, 0), (1000, 0), (1000, 1000), (0, 1000)], num_drones=6, sweep_spacing=100.0
    )
    assert set(mission) == {f"drone_{i}" for i in range(1, 7)}
    for path in mission.values():
        for wp in path:
            x, y = wp
            assert isinstance(x, float) and isinstance(y, float)


def test_asdict_rejects_plain_dict():
    """Documents WHY a nav dict can't ride the existing WS path: broadcast() does
    `asdict(packet)`, and asdict() raises on anything that isn't a dataclass.
    A nav-telemetry stream therefore needs either a dataclass wire type or a
    broadcast path that passes dicts through untouched (see F-INT-2)."""
    with pytest.raises(TypeError):
        dataclasses.asdict({"drone_id": "DRONE_1", "x": 1.0, "y": 2.0})


# --------------------------------------------------------------------------- #
# What's missing: the backend never produces nav telemetry. (Known gaps.)
# --------------------------------------------------------------------------- #
@pytest.mark.xfail(
    strict=True,
    reason="F-INT-1: no nav-telemetry wire type/builder exists. The dashboard needs "
    "{drone_id,x,y,current_waypoint_idx,waypoints_remaining,mission_complete}; "
    "src/packet.py defines no such builder. Remove this marker once one exists.",
)
def test_packet_module_exposes_nav_telemetry_builder():
    from src import packet

    builder = getattr(packet, "make_nav_telemetry", None) or getattr(
        packet, "NavTelemetry", None
    )
    assert builder is not None, "no nav-telemetry builder/dataclass in src/packet.py"


@pytest.mark.xfail(
    strict=True,
    reason="F-INT-1: coverage_planner is never wired into the runtime — no producer "
    "flies the planned waypoints or emits per-waypoint progress, so Task 1/2 "
    "handlers never fire. Remove this marker once the producer consumes the planner.",
)
def test_runtime_wires_coverage_planner():
    producer_src = (SRC / "producer.py").read_text(encoding="utf-8")
    main_src = (SRC / "main.py").read_text(encoding="utf-8")
    assert (
        "coverage_planner" in producer_src or "coverage_planner" in main_src
    ), "neither producer.py nor main.py imports/uses coverage_planner"
