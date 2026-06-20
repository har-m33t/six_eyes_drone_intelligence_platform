"""Task 3 — thread-activation edge-case & stress spec (adversarial companion to
the happy-path cases in ``test_thread_activation.py``).

The happy-path file pins the contract: ``producer.inject_mission(plan)`` maps the
planner's ``drone_<n>`` keys onto ``DRONE_<n>`` navigators and unpauses them,
``producer.get_navigator`` / ``reset_navigators`` manage the registry, and
``packet.make_nav_packet`` builds the ``NavTelemetry`` wire frame the dashboard
routes on. This module attacks that layer with the inputs a real drawn polygon
actually produces — surplus drones with empty routes, partial/garbage plans,
rapid redeploys that could leak navigators, the lowercase→UPPERCASE id mapping,
the nav-vs-gps packet-shape split, and concurrent deploys racing the tick loop.

Skips cleanly until Task 3 is built (importorskip + capability guards).
"""
from __future__ import annotations

import threading

import pytest

producer = pytest.importorskip("src.producer")
pytest.importorskip("src.navigation")
ws = pytest.importorskip("src.transport.websocket_server")

from src import config  # noqa: E402
from src.coverage_planner import plan_mission  # noqa: E402

# Capability guard: skip until the Task 3 producer surface exists.
for _attr in ("inject_mission", "get_navigator", "reset_navigators"):
    if not hasattr(producer, _attr):
        pytest.skip(
            f"Task 3 not built: producer.{_attr} missing "
            "(see tests/test_thread_activation.py for the contract).",
            allow_module_level=True,
        )

NUM = len(config.DRONE_IDS)
RECT = [(0, 0), (100, 0), (100, 50), (0, 50)]


def _plan(polygon=RECT, spacing=10.0):
    return plan_mission(polygon_coords=[(float(x), float(y)) for x, y in polygon],
                        num_drones=NUM, sweep_spacing=spacing)


@pytest.fixture(autouse=True)
def _clean():
    producer.reset_navigators()
    ws.set_mission_handler(None)
    yield
    producer.reset_navigators()
    ws.set_mission_handler(None)


# --------------------------------------------------------------------------- #
# Surplus drones / empty + single-waypoint routes
# --------------------------------------------------------------------------- #
def test_tiny_polygon_with_surplus_empty_routes_does_not_crash():
    """A 5x5 area yields far fewer waypoints than drones, so the planner hands
    several drones empty routes. Injection must tolerate that without raising."""
    plan = _plan([(0, 0), (5, 0), (5, 5), (0, 5)])
    empties = [k for k, v in plan.items() if not v]
    assert empties, "fixture should produce at least one empty-route drone"
    armed = producer.inject_mission(plan)  # must not raise
    assert isinstance(armed, int) and 0 <= armed <= NUM
    # Reading every navigator (armed or not) must be crash-free.
    for i in range(1, NUM + 1):
        nav = producer.get_navigator(f"DRONE_{i}")
        if nav is not None:
            nav.tick(0.0)  # a no-op read must never raise, even on an empty route


def test_single_waypoint_route_drone_completes_without_error():
    producer.inject_mission({"drone_1": [(7.0, 7.0)]})
    nav = producer.get_navigator("DRONE_1")
    assert nav is not None
    nav.activate()
    t = nav.tick(1.0)
    assert t["mission_complete"] is True


# --------------------------------------------------------------------------- #
# Malformed / hostile plans — inject must never take a thread down
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("garbage", [
    {}, None, [], "START_MISSION", 42, 3.14, True,
    {"drone_1": None},
    {"drone_1": "xy"},
    {"drone_1": [(1,)]},                       # 1-tuple waypoint
    {"drone_1": [("a", "b"), ("c", "d")]},     # non-numeric coords
    {"drone_1": [[float("nan"), 0.0], [1.0, 1.0]]},
    {"drone_1": 12345},
    {None: [(0, 0), (1, 1)]},                  # non-string key
    {"drone_1": [(0, 0), (1, 1)], "drone_x": [(2, 2), (3, 3)]},
])
def test_inject_mission_never_raises_on_garbage_plan(garbage):
    try:
        result = producer.inject_mission(garbage)
    except Exception as exc:  # noqa: BLE001 — exactly what we're forbidding
        pytest.fail(f"inject_mission raised on {garbage!r}: {exc!r}")
    # When it returns a count, it must be a sane non-negative int.
    if isinstance(result, int):
        assert 0 <= result <= NUM


def test_partial_plan_missing_drones_arms_only_present_ones():
    producer.inject_mission({"drone_2": [(0, 0), (10, 0)], "drone_5": [(1, 1), (2, 2)]})
    assert producer.get_navigator("DRONE_2") is not None
    assert producer.get_navigator("DRONE_5") is not None
    assert producer.get_navigator("DRONE_1") is None
    assert producer.get_navigator("DRONE_3") is None


def test_unknown_drone_keys_arm_nothing():
    armed = producer.inject_mission({"drone_99": [(0, 0), (1, 1), (2, 2)],
                                     "FOXTROT": [(0, 0), (1, 1)]})
    assert armed == 0
    assert producer.get_navigator("DRONE_99") is None


def test_tuple_and_list_waypoints_both_accepted():
    producer.inject_mission({"drone_1": [(0.0, 0.0), (10.0, 0.0)]})
    producer.inject_mission({"drone_2": [[0.0, 0.0], [10.0, 0.0]]})
    assert producer.get_navigator("DRONE_1") is not None
    assert producer.get_navigator("DRONE_2") is not None


# --------------------------------------------------------------------------- #
# Redeploy / registry hygiene — no leaks, clean reset
# --------------------------------------------------------------------------- #
def test_repeated_redeploys_never_accumulate_navigators():
    seen_ids = []
    for poly in ([(0, 0), (100, 0), (100, 50), (0, 50)],
                 [(0, 0), (40, 0), (40, 40), (0, 40)],
                 [(5, 5), (90, 5), (90, 60), (5, 60)]):
        producer.inject_mission(_plan(poly))
        ids = [id(producer.get_navigator(f"DRONE_{i}")) for i in range(1, NUM + 1)
               if producer.get_navigator(f"DRONE_{i}") is not None]
        assert len(ids) <= NUM, "more navigators than drones after redeploy"
        seen_ids.append(ids)
    # Redeploys should refresh the *same* navigator objects in place (Task 3:
    # "instantiate OR update"), not spawn a fresh set each time.
    if all(len(s) == NUM for s in seen_ids):
        assert seen_ids[0] == seen_ids[-1], "redeploy replaced navigator objects (leak risk)"


def test_reset_navigators_clears_the_registry():
    producer.inject_mission(_plan())
    assert any(producer.get_navigator(f"DRONE_{i}") for i in range(1, NUM + 1))
    producer.reset_navigators()
    assert all(producer.get_navigator(f"DRONE_{i}") is None for i in range(1, NUM + 1))


def test_redeploy_keeps_current_position_and_transits_to_new_route():
    producer._remember_gps("DRONE_1", {"lng": -117.84, "lat": 33.67, "alt": 75.0})
    producer.inject_mission({"drone_1": [(-117.83, 33.67), (-117.82, 33.67)]})
    first = producer.get_navigator("DRONE_1")
    producer.inject_mission({"drone_1": [(-117.81, 33.68), (-117.80, 33.68)]})
    second = producer.get_navigator("DRONE_1")
    assert second is first, "redeploy should update the same navigator instance"
    assert (second.x, second.y) == (-117.84, 33.67)
    assert second.waypoints[:2] == [(-117.84, 33.67), (-117.81, 33.68)]


# --------------------------------------------------------------------------- #
# Router seam under load
# --------------------------------------------------------------------------- #
def test_rapid_start_mission_frames_stay_consistent():
    ws.set_mission_handler(producer.inject_mission)
    for poly in ([[0, 0], [100, 0], [100, 50], [0, 50]],
                 [[0, 0], [10, 0], [20, 0]],            # zero-area scribble
                 [[0, 0], [60, 0], [60, 60], [0, 60]]):
        res = ws._handle_start_mission({"command": "START_MISSION", "polygon": poly})
        assert res is not None  # valid frames all plan, even the zero-area one
    # Registry never grew past the swarm size through all those deploys.
    armed = sum(1 for i in range(1, NUM + 1) if producer.get_navigator(f"DRONE_{i}"))
    assert armed <= NUM


def test_router_zero_area_polygon_injects_inert_drones():
    ws.set_mission_handler(producer.inject_mission)
    res = ws._handle_start_mission(
        {"command": "START_MISSION", "polygon": [[0, 0], [10, 0], [20, 0]]})
    assert res is not None
    for i in range(1, NUM + 1):
        nav = producer.get_navigator(f"DRONE_{i}")
        if nav is not None:
            nav.activate()
            assert nav.tick(1.0)["mission_complete"] is True, "empty-route drone should be inert"


# --------------------------------------------------------------------------- #
# Concurrency — WS thread deploys while producer threads tick
# --------------------------------------------------------------------------- #
def test_concurrent_deploys_and_navigator_reads_stay_sane():
    producer.inject_mission(_plan())
    errors = []
    stop = threading.Event()

    def deployer():
        polys = [RECT, [(0, 0), (60, 0), (60, 60), (0, 60)],
                 [(5, 5), (80, 5), (80, 40), (5, 40)]]
        i = 0
        try:
            while not stop.is_set():
                producer.inject_mission(_plan(polys[i % len(polys)]))
                i += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(("deploy", exc))

    def ticker():
        try:
            for _ in range(4000):
                armed = 0
                for j in range(1, NUM + 1):
                    nav = producer.get_navigator(f"DRONE_{j}")
                    if nav is not None:
                        armed += 1
                        if not nav.is_complete:
                            nav.tick(0.1)
                assert armed <= NUM, f"registry overflowed: {armed}"
        except Exception as exc:  # noqa: BLE001
            errors.append(("tick", exc))

    threads = [threading.Thread(target=deployer), threading.Thread(target=ticker)]
    for t in threads:
        t.start()
    threads[1].join(timeout=30)
    stop.set()
    threads[0].join(timeout=10)
    assert not any(t.is_alive() for t in threads), "deploy/tick race deadlocked"
    assert not errors, f"concurrent deploy/tick failures: {errors}"


# --------------------------------------------------------------------------- #
# Nav-telemetry wire frame — must not collide with the DronePacket stream
# --------------------------------------------------------------------------- #
def test_nav_packet_is_distinguishable_from_gps_packet():
    """The dashboard's isNavTelemetry() routes a frame as nav telemetry only if
    it has current_waypoint_idx and NO gps. A nav frame that leaks gps/health
    would be mis-routed into the GPS panel. Pin the split."""
    pkt_mod = pytest.importorskip("src.packet")
    make_nav_packet = getattr(pkt_mod, "make_nav_packet", None)
    NavTelemetry = getattr(pkt_mod, "NavTelemetry", None)
    if make_nav_packet is None or NavTelemetry is None:
        pytest.skip("nav-telemetry builder not built yet")

    import dataclasses
    import json

    telemetry = {"x": 12.0, "y": 34.0, "current_waypoint_idx": 5,
                 "waypoints_remaining": 20, "mission_complete": False}
    pkt = make_nav_packet("DRONE_3", telemetry)
    assert dataclasses.is_dataclass(pkt), "broadcast() uses asdict(); must be a dataclass"
    d = dataclasses.asdict(pkt)
    assert d["drone_id"] == "DRONE_3"
    assert "current_waypoint_idx" in d
    # The nav stream must carry none of the heavy DronePacket fields.
    for forbidden in ("gps", "health", "detections", "frame_b64"):
        assert forbidden not in d, f"nav frame leaked DronePacket field {forbidden!r}"
    json.dumps(d)  # rides the WebSocket as JSON


def test_nav_packet_round_trips_real_navigator_telemetry():
    from src.navigation import WaypointNavigator
    pkt_mod = pytest.importorskip("src.packet")
    make_nav_packet = getattr(pkt_mod, "make_nav_packet", None)
    if make_nav_packet is None:
        pytest.skip("nav-telemetry builder not built yet")

    import dataclasses

    nav = WaypointNavigator([(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)], speed=100.0)
    nav.activate()
    telemetry = nav.tick(1.0)  # completes the route
    pkt = make_nav_packet("DRONE_1", telemetry)
    d = dataclasses.asdict(pkt)
    assert d["mission_complete"] is True
    assert d["waypoints_remaining"] == 0
    assert d["x"] == 10.0 and d["y"] == 10.0
