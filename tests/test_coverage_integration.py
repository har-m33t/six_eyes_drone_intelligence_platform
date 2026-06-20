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


def test_planner_uses_dense_default_for_mapbox_lnglat_polygon():
    """Mapbox polygons must use degree-scale spacing, not legacy SIM spacing."""
    polygon = [(-117.83, 33.67), (-117.81, 33.67), (-117.81, 33.69), (-117.83, 33.69)]

    path = coverage_planner.generate_lawnmower_path(polygon)

    assert len(path) >= 150
    ys = sorted({round(y, 7) for _, y in path})
    assert (ys[1] - ys[0]) == pytest.approx(coverage_planner.DEFAULT_GEO_SWEEP_SPACING)


def test_asdict_rejects_plain_dict():
    """Documents WHY a nav dict can't ride the existing WS path: broadcast() does
    `asdict(packet)`, and asdict() raises on anything that isn't a dataclass.
    A nav-telemetry stream therefore needs either a dataclass wire type or a
    broadcast path that passes dicts through untouched (see F-INT-2)."""
    with pytest.raises(TypeError):
        dataclasses.asdict({"drone_id": "DRONE_1", "x": 1.0, "y": 2.0})


# --------------------------------------------------------------------------- #
# Now wired by Deploy Swarm Task 3 (.claude/deploy-swarm-integration.md). The
# xfail(strict) markers these tests carried have been removed now that the gap
# is closed: src/packet.py has a nav-telemetry wire type, and the runtime flies
# the planned waypoints (WS router -> producer.inject_mission -> navigators).
# --------------------------------------------------------------------------- #
def test_packet_module_exposes_nav_telemetry_builder():
    from src import packet

    builder = getattr(packet, "make_nav_telemetry", None) or getattr(
        packet, "NavTelemetry", None
    )
    assert builder is not None, "no nav-telemetry builder/dataclass in src/packet.py"
    # It must be a dataclass so the existing broadcast() asdict() path accepts it.
    assert dataclasses.is_dataclass(packet.NavTelemetry)
    fields = {f.name for f in dataclasses.fields(packet.NavTelemetry)}
    assert {"drone_id", "x", "y", "current_waypoint_idx",
            "waypoints_remaining", "mission_complete"} <= fields


def test_runtime_wires_coverage_planner():
    """The planner is consumed by the runtime: the WS router plans a START_MISSION
    polygon via coverage_planner, and main.py registers producer.inject_mission
    as the handler that flies the result through WaypointNavigators."""
    ws_src = (SRC / "transport" / "websocket_server.py").read_text(encoding="utf-8")
    main_src = (SRC / "main.py").read_text(encoding="utf-8")
    producer_src = (SRC / "producer.py").read_text(encoding="utf-8")

    assert "plan_mission" in ws_src, "WS router must plan via coverage_planner"
    assert "set_mission_handler" in main_src and "inject_mission" in main_src, (
        "main.py must register the producer's mission handler"
    )
    assert "WaypointNavigator" in producer_src, (
        "producer must fly planned waypoints via the navigator"
    )


def test_main_registers_mission_handler_before_websocket_serves(monkeypatch):
    """An early dashboard deploy must not be planned and then dropped because
    the WebSocket server started before producer.inject_mission was registered."""
    from src import main as runtime
    from src.transport import websocket_server as ws

    observed_handlers = []

    async def fake_serve_forever():
        observed_handlers.append(ws._mission_handler)

    class DummySender:
        foundry_enabled = False

    monkeypatch.setattr(runtime, "serve_forever", fake_serve_forever)
    monkeypatch.setattr(runtime, "DualSinkSender", lambda _loop: DummySender())
    monkeypatch.setattr(runtime, "warmup", lambda: None)
    monkeypatch.setattr(runtime, "launch_producers", lambda _sender: [])
    monkeypatch.setattr(runtime.config, "MISSION_DURATION_S", 0)

    ws.set_mission_handler(None)
    try:
        runtime.main()
        assert observed_handlers == [runtime.inject_mission]
    finally:
        ws.set_mission_handler(None)
