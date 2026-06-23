"""Task 3 — Thread Activation (Deploy Swarm).

Pins the seam that turns a planned mission into moving drones:

  * ``WaypointNavigator`` flies a route step-by-step via ``tick()`` and reports
    waypoint progress in the shape the dashboard's nav-telemetry stream expects.
  * ``producer.inject_mission`` (the handler the WS router calls) maps the
    planner's ``drone_1``..``drone_6`` keys onto running threads, arms a
    navigator each, and unpauses navigation.
  * Registering that handler with ``set_mission_handler`` makes a START_MISSION
    frame flow router -> planner -> navigators end to end.

These are pure/fast: no footage, no model, no sockets. The producer loop itself
(which calls ``tick()`` per frame) is exercised by test_producer_integration.
"""
import math

import pytest

from src import config
from src.navigation import WaypointNavigator, build_navigators
from src.packet import NavTelemetry, make_nav_packet
from src.transport import websocket_server as ws

import src.producer as producer


@pytest.fixture(autouse=True)
def clean_registry():
    """Each test starts and ends with an empty navigator registry + no handler,
    so the shared module-level state never leaks between tests (or into the
    producer-integration suite, which asserts a nav-free packet stream)."""
    producer.reset_navigators()
    ws.set_mission_handler(None)
    yield
    producer.reset_navigators()
    ws.set_mission_handler(None)


# --------------------------------------------------------------------------- #
# WaypointNavigator — continuous tick(dt) mover (see tests/test_navigation.py
# for the full edge-case spec; these cover the happy path + Task 3 wiring).
# --------------------------------------------------------------------------- #
def test_navigator_is_paused_until_activated():
    nav = WaypointNavigator([(0, 0), (100, 0)], speed=50)
    start = (nav.x, nav.y)
    nav.tick(1.0)  # not activated yet — must stay put
    assert (nav.x, nav.y) == start, "a paused navigator must not move"


def test_navigator_moves_toward_next_waypoint():
    nav = WaypointNavigator([(0, 0), (100, 0)], speed=10)
    nav.activate()
    nav.tick(1.0)  # retires (0,0), then advances 10 units toward (100,0)
    assert nav.x == pytest.approx(10.0)
    assert nav.y == pytest.approx(0.0)
    assert nav.current_waypoint_idx == 1  # waypoint 0 reached
    assert not nav.is_complete


def test_navigator_reaches_and_completes_route():
    nav = WaypointNavigator([(0, 0), (10, 0), (10, 10)], speed=100)
    nav.activate()
    # 100 units/s for 1s easily covers the 20-unit route in a single tick.
    telemetry = nav.tick(1.0)
    assert nav.is_complete
    assert telemetry["mission_complete"] is True
    assert telemetry["waypoints_remaining"] == 0
    assert (nav.x, nav.y) == (10.0, 10.0)  # parked on the final waypoint


def test_navigator_one_tick_can_clear_several_waypoints():
    nav = WaypointNavigator([(0, 0), (1, 0), (2, 0), (3, 0)], speed=100)
    nav.activate()
    nav.tick(1.0)
    assert nav.current_waypoint_idx == 4  # all four retired in one budget


def test_completed_navigator_tick_is_noop():
    nav = WaypointNavigator([(0, 0), (5, 0)], speed=100)
    nav.activate()
    nav.tick(1.0)
    assert nav.is_complete
    pos = (nav.x, nav.y)
    nav.tick(1.0)  # nothing left to fly
    assert (nav.x, nav.y) == pos


def test_navigator_telemetry_shape_matches_dashboard_contract():
    nav = WaypointNavigator([(0, 0), (50, 0), (50, 50)], speed=10)
    nav.activate()
    t = nav.tick(1.0)
    assert set(t) == {
        "x", "y", "current_waypoint_idx", "waypoints_remaining", "mission_complete",
    }
    assert isinstance(t["current_waypoint_idx"], int)
    assert isinstance(t["waypoints_remaining"], int)
    assert isinstance(t["mission_complete"], bool)
    # total route length is recoverable as current + remaining (dashboard math).
    assert t["current_waypoint_idx"] + t["waypoints_remaining"] == len(nav.waypoints)


def test_set_waypoints_redeploys_onto_new_route():
    nav = WaypointNavigator([(0, 0), (100, 0)], speed=10)
    nav.activate()
    nav.tick(1.0)
    nav.set_waypoints([(500, 500), (600, 500)])  # operator drew a new polygon
    assert (nav.x, nav.y) == (500.0, 500.0)  # repositioned to new route start
    assert nav.current_waypoint_idx == 0
    assert nav.active  # re-deploy keeps the active flag


def test_empty_route_is_immediately_complete():
    nav = WaypointNavigator([], speed=10)
    nav.activate()
    t = nav.tick(1.0)
    assert nav.is_complete and t["mission_complete"] is True


def test_navigator_default_speed_comes_from_config():
    nav = WaypointNavigator([(0, 0), (1000, 0)])
    assert nav.speed == config.NAV_SPEED_UNITS_S


# --------------------------------------------------------------------------- #
# make_nav_packet — the wire format the dashboard routes on
# --------------------------------------------------------------------------- #
def test_make_nav_packet_has_no_gps_and_carries_progress():
    nav = WaypointNavigator([(0, 0), (10, 0)], speed=5)
    nav.activate()
    pkt = make_nav_packet("DRONE_2", nav.tick(1.0))
    assert isinstance(pkt, NavTelemetry)
    from dataclasses import asdict
    d = asdict(pkt)
    # The dashboard's isNavTelemetry() keys on current_waypoint_idx / x+y-no-gps.
    assert "gps" not in d
    assert "current_waypoint_idx" in d
    assert d["drone_id"] == "DRONE_2"
    import json
    json.dumps(d)  # must serialize onto the wire


# --------------------------------------------------------------------------- #
# inject_mission — the registered mission handler
# --------------------------------------------------------------------------- #
def _rect_plan():
    """A real planner result so key mapping/route lengths are realistic."""
    from src.coverage_planner import plan_mission
    return plan_mission(polygon_coords=[(0, 0), (100, 0), (100, 50), (0, 50)],
                        num_drones=6)


def test_inject_mission_arms_all_six_drones():
    armed = producer.inject_mission(_rect_plan())
    assert armed == 6
    for i in range(1, 7):
        nav = producer.get_navigator(f"DRONE_{i}")
        assert isinstance(nav, WaypointNavigator)
        assert nav.active, "injected navigators must be unpaused"


def test_inject_mission_maps_lowercase_plan_keys_to_drone_ids():
    producer.inject_mission({"drone_3": [(0, 0), (10, 0), (10, 10)]})
    assert producer.get_navigator("DRONE_3") is not None
    assert producer.get_navigator("DRONE_1") is None  # only drone_3 was in the plan


def test_inject_mission_refreshes_existing_navigator_in_place():
    producer._remember_gps("DRONE_1", {"lng": -117.84, "lat": 33.67, "alt": 75.0})
    producer.inject_mission({"drone_1": [(-117.83, 33.67), (-117.82, 33.67)]})
    first = producer.get_navigator("DRONE_1")
    producer.inject_mission({"drone_1": [(-117.81, 33.68), (-117.80, 33.68)]})
    second = producer.get_navigator("DRONE_1")
    assert second is first, "re-deploy should update the same navigator object"
    assert (second.x, second.y) == (-117.84, 33.67)
    assert second.waypoints[0] == (-117.84, 33.67)
    assert second.waypoints[1] == (-117.81, 33.68)
    assert second.coverage_start_index == 1


def test_transit_to_start_does_not_count_as_coverage():
    producer._remember_gps("DRONE_1", {"lng": -117.84, "lat": 33.67, "alt": 75.0})
    producer.inject_mission({"drone_1": [(-117.83, 33.67), (-117.82, 33.67)]})
    nav = producer.get_navigator("DRONE_1")

    raw = nav.tick(1.0)
    telemetry = producer._mission_telemetry(nav, raw)
    gps = producer._gps_from_nav_telemetry(telemetry)

    assert telemetry["current_waypoint_idx"] == 0
    assert telemetry["waypoints_remaining"] == 2
    assert telemetry["coverage_active"] is False
    assert gps["coverage_active"] is False
    assert -117.84 < gps["lng"] < -117.83


def test_inject_mission_ignores_unknown_drone_keys():
    armed = producer.inject_mission({"drone_99": [(0, 0), (1, 1), (2, 2)]})
    assert armed == 0
    assert producer.get_navigator("DRONE_99") is None


def test_inject_mission_never_raises_on_garbage_plan():
    # The handler must be robust even though the router also guards it.
    assert producer.inject_mission({}) == 0


def test_inject_mission_rejects_non_finite_waypoints():
    armed = producer.inject_mission({"drone_1": [(float("nan"), 0.0), (1.0, 1.0)]})
    assert armed == 0
    assert producer.get_navigator("DRONE_1") is None


def test_pre_mission_gps_holds_fixed_hover_position():
    first = producer._hover_gps("DRONE_1")
    second = producer._hover_gps("DRONE_1")
    assert first == second
    assert first["lng"] == first["lon"]
    assert first["lat"] == pytest.approx(config.BASE_LAT)


# --------------------------------------------------------------------------- #
# End to end: START_MISSION frame -> router -> planner -> navigators
# --------------------------------------------------------------------------- #
def test_start_mission_frame_activates_producer_navigators():
    ws.set_mission_handler(producer.inject_mission)
    rect = [[0, 0], [100, 0], [100, 50], [0, 50]]
    plan = ws._handle_start_mission({"command": "START_MISSION", "polygon": rect})
    assert plan is not None
    # Every drone the planner assigned a (possibly empty) route to is now armed.
    for i in range(1, 7):
        assert producer.get_navigator(f"DRONE_{i}") is not None


def test_no_handler_means_no_navigators_armed():
    # Sanity: without registration the plan is computed but nothing is armed.
    rect = [[0, 0], [100, 0], [100, 50], [0, 50]]
    ws._handle_start_mission({"command": "START_MISSION", "polygon": rect})
    assert all(producer.get_navigator(f"DRONE_{i}") is None for i in range(1, 7))


# --------------------------------------------------------------------------- #
# KILL_DRONE (Task D2 backend): frame -> router -> producer.kill_drone -> the
# drone's stop Event, which makes its producer loop exit and emit SIGNAL LOST.
# --------------------------------------------------------------------------- #
@pytest.fixture
def restore_stop_events():
    """kill_drone mutates the shared producer.stop_events; snapshot the targeted
    flags and clear them afterwards so a kill never leaks into other suites."""
    yield
    for event in producer.stop_events.values():
        event.clear()


def test_kill_drone_sets_stop_event(restore_stop_events):
    assert not producer.stop_events["DRONE_3"].is_set()
    assert producer.kill_drone("DRONE_3") is True
    assert producer.stop_events["DRONE_3"].is_set()
    # Idempotent: re-killing an already-stopped drone is a harmless no-op.
    assert producer.kill_drone("drone_3") is True  # case-normalised, still True


def test_kill_drone_unknown_id_is_ignored(restore_stop_events):
    assert producer.kill_drone("DRONE_99") is False
    assert producer.kill_drone(None) is False


def test_kill_drone_frame_kills_targeted_drone_end_to_end(restore_stop_events):
    ws.set_kill_handler(producer.kill_drone)
    try:
        ws._handle_kill_drone({"command": "KILL_DRONE", "drone_id": "DRONE_3"})
        assert producer.stop_events["DRONE_3"].is_set()
        # Only the targeted drone is affected.
        assert not producer.stop_events["DRONE_1"].is_set()
    finally:
        ws.set_kill_handler(None)
