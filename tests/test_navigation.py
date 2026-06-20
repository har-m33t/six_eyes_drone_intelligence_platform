"""Task 3 — ``WaypointNavigator`` edge-case & stress spec (adversarial companion
to the happy-path cases in ``test_thread_activation.py``).

``tests/test_thread_activation.py`` already pins the *contract* of the
not-yet-built ``src/navigation.WaypointNavigator``:

    * ``WaypointNavigator(waypoints, speed=config.NAV_SPEED_UNITS_S)``
    * a **continuous** mover: ``tick(dt)`` advances ``speed * dt`` units along the
      polyline, retiring every waypoint it passes and clamping onto the last one;
      it returns the dashboard nav-telemetry dict
      ``{x, y, current_waypoint_idx, waypoints_remaining, mission_complete}``.
    * ``.x/.y`` position (starts on ``waypoints[0]``), ``.current_waypoint_idx``
      (count of retired waypoints), ``.is_complete``, ``.active`` /``.activate()``
      (paused until activated), ``.set_waypoints(new)`` (redeploy in place).

This module does NOT re-test that happy path. It hammers the degenerate and
hostile inputs a real drawn-polygon mission produces — the cases a naive
implementation crashes, hangs, overshoots, or silently corrupts on. It skips
cleanly until ``src/navigation.py`` exists (TDD, same as ``test_mission_router``).
"""
from __future__ import annotations

import math
import threading

import pytest

nav_mod = pytest.importorskip("src.navigation")
from src import config  # noqa: E402

WaypointNavigator = getattr(nav_mod, "WaypointNavigator", None)
if WaypointNavigator is None:
    pytest.skip(
        "Task 3 not built: expected src.navigation.WaypointNavigator "
        "(see tests/test_thread_activation.py for the full contract).",
        allow_module_level=True,
    )

EPS = 1e-6
REQUIRED_KEYS = {"x", "y", "current_waypoint_idx", "waypoints_remaining", "mission_complete"}


def _make(waypoints, speed=10.0):
    nav = WaypointNavigator(list(waypoints), speed=speed)
    nav.activate()
    return nav


def _finite(v):
    return isinstance(v, (int, float)) and math.isfinite(float(v))


def _bbox(waypoints):
    xs = [p[0] for p in waypoints]
    ys = [p[1] for p in waypoints]
    return min(xs), min(ys), max(xs), max(ys)


def _check_telemetry(t, route_len):
    """Per-tick invariants on the returned telemetry dict."""
    assert set(t) == REQUIRED_KEYS, f"telemetry keys drifted: {set(t)}"
    assert _finite(t["x"]) and _finite(t["y"]), f"non-finite position: {t}"
    idx, rem = t["current_waypoint_idx"], t["waypoints_remaining"]
    assert isinstance(idx, int) and isinstance(rem, int)
    assert 0 <= idx <= route_len, f"idx out of range: {idx}/{route_len}"
    assert 0 <= rem <= route_len, f"remaining out of range: {rem}/{route_len}"
    # The dashboard recovers total route length as idx + remaining — it must be
    # exactly the route length on every tick (else "% SEARCHED" jitters).
    assert idx + rem == route_len, f"idx+remaining != route length: {t} vs {route_len}"
    assert t["mission_complete"] == (rem == 0), "mission_complete must track remaining==0"


# --------------------------------------------------------------------------- #
# Overshoot / clamping — the #1 way a continuous mover goes wrong
# --------------------------------------------------------------------------- #
def test_huge_speed_lands_exactly_on_final_waypoint_no_overshoot():
    route = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]
    nav = _make(route, speed=1e9)
    t = nav.tick(1.0)
    assert t["mission_complete"] is True
    assert (nav.x, nav.y) == (10.0, 10.0), "overshot the final waypoint"
    assert t["waypoints_remaining"] == 0


def test_position_never_escapes_route_bounding_box():
    """A correct mover walks straight segments and clamps at each corner, so it
    stays inside the route's bbox. A mover that overshoots a corner (continuing
    past it by the leftover budget) escapes — this catches that."""
    route = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0),
             (0.0, 10.0), (0.0, 20.0), (10.0, 20.0)]
    min_x, min_y, max_x, max_y = _bbox(route)
    nav = _make(route, speed=3.0)  # small step -> many intermediate ticks
    for _ in range(1000):
        t = nav.tick(1.0)
        _check_telemetry(t, len(route))
        assert min_x - EPS <= nav.x <= max_x + EPS, f"x escaped bbox: {nav.x}"
        assert min_y - EPS <= nav.y <= max_y + EPS, f"y escaped bbox: {nav.y}"
        if t["mission_complete"]:
            break
    else:
        pytest.fail("zigzag route never completed within 1000 ticks")
    assert (nav.x, nav.y) == (10.0, 20.0)


def test_tiny_steps_accumulate_to_exact_finish():
    route = [(0.0, 0.0), (1.0, 0.0)]
    nav = _make(route, speed=0.01)  # 100 ticks of dt=1 to cross 1 unit
    for _ in range(100_000):
        t = nav.tick(1.0)
        if t["mission_complete"]:
            break
    assert t["mission_complete"] is True
    assert nav.x == pytest.approx(1.0, abs=1e-6)
    assert nav.y == pytest.approx(0.0, abs=1e-6)


# --------------------------------------------------------------------------- #
# Degenerate routes
# --------------------------------------------------------------------------- #
def test_single_waypoint_route_completes_on_the_spot():
    nav = _make([(42.0, -7.0)], speed=10.0)
    t = nav.tick(1.0)
    assert t["mission_complete"] is True
    assert (nav.x, nav.y) == (42.0, -7.0)


def test_consecutive_duplicate_waypoints_no_zero_division():
    """A zero-length segment makes the heading vector (0,0); normalising it
    naively is a ZeroDivisionError. The route must still fly to the end."""
    route = [(0.0, 0.0), (0.0, 0.0), (10.0, 0.0), (10.0, 0.0), (10.0, 10.0)]
    nav = _make(route, speed=3.0)
    for _ in range(1000):
        t = nav.tick(1.0)  # must not raise
        _check_telemetry(t, len(route))
        if t["mission_complete"]:
            break
    else:
        pytest.fail("route with duplicate waypoints never completed (stall?)")
    assert (nav.x, nav.y) == (10.0, 10.0)


def test_all_identical_waypoints_terminate_without_infinite_loop():
    route = [(3.0, 3.0)] * 50
    nav = _make(route, speed=1.0)
    for _ in range(500):
        t = nav.tick(1.0)
        if t["mission_complete"]:
            break
    else:
        pytest.fail("route of identical points never terminated")
    assert nav.waypoints  # the route is preserved
    assert t["waypoints_remaining"] == 0


# --------------------------------------------------------------------------- #
# Hostile dt / speed
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("dt", [-1.0, -1e9, float("nan")])
def test_non_positive_or_nan_dt_does_not_move_or_corrupt(dt):
    route = [(0.0, 0.0), (100.0, 0.0)]
    nav = _make(route, speed=10.0)
    start = (nav.x, nav.y)
    t = nav.tick(dt)  # must not raise, must not teleport / NaN the position
    assert _finite(nav.x) and _finite(nav.y), f"dt={dt} corrupted position: {(nav.x, nav.y)}"
    assert (nav.x, nav.y) == start, f"dt={dt} moved the drone"
    assert t["mission_complete"] is False


def test_zero_speed_makes_no_forward_progress_but_never_falsely_completes():
    """A drone that can't move must not be reported as having searched its area.
    Construction may reject speed<=0 outright; if it doesn't, ticking must fail
    soft (finite, no false completion, no crash)."""
    route = [(0.0, 0.0), (100.0, 0.0)]
    try:
        nav = _make(route, speed=0.0)
    except (ValueError, ZeroDivisionError):
        return  # rejecting non-positive speed up front is acceptable
    for _ in range(100):
        t = nav.tick(1.0)
        assert _finite(nav.x) and _finite(nav.y)
    assert t["mission_complete"] is False, "a zero-speed drone must not report complete"


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_waypoint_does_not_hang_or_raise(bad):
    """NaN/Inf can slip through JSON into the polygon -> planner -> waypoints.
    The navigator must fail soft: bounded ticking, no exception, no infinite
    loop (the producer thread must survive)."""
    route = [(0.0, 0.0), (bad, 5.0), (10.0, 10.0)]
    nav = _make(route, speed=3.0)
    for _ in range(5000):
        t = nav.tick(1.0)  # must not raise
        if t["mission_complete"]:
            break


# --------------------------------------------------------------------------- #
# Aliasing / defensive copy
# --------------------------------------------------------------------------- #
def test_route_argument_is_defensively_copied():
    """If the navigator aliases the caller's list, the planner reusing or
    clearing that buffer silently corrupts an in-flight mission."""
    route = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]
    nav = WaypointNavigator(route, speed=3.0)
    nav.activate()
    route.clear()
    route.append((999.0, 999.0))  # hostile mutation right after construction
    for _ in range(1000):
        t = nav.tick(1.0)
        if t["mission_complete"]:
            break
    else:
        pytest.fail("mutating the caller's list broke the route (aliasing bug)")
    assert (nav.x, nav.y) == (10.0, 10.0), "injected (999,999) leaked into the route"


# --------------------------------------------------------------------------- #
# Redeploy via set_waypoints — edge inputs
# --------------------------------------------------------------------------- #
def test_set_waypoints_to_empty_route_completes_immediately():
    nav = _make([(0.0, 0.0), (100.0, 0.0)], speed=10.0)
    nav.tick(1.0)
    nav.set_waypoints([])  # operator cleared the polygon
    t = nav.tick(1.0)
    assert t["mission_complete"] is True
    assert _finite(nav.x) and _finite(nav.y)


def test_set_waypoints_resets_progress_counters():
    nav = _make([(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)], speed=100.0)
    nav.tick(1.0)  # fly the original route to completion
    assert nav.is_complete
    new_route = [(0.0, 0.0), (50.0, 0.0), (50.0, 50.0), (0.0, 50.0)]
    nav.set_waypoints(new_route)
    # Read the freshly-armed state straight off the exposed attributes (ticking
    # to read it would risk retiring the zero-distance start waypoint first).
    assert nav.current_waypoint_idx == 0, "redeploy must reset the waypoint index"
    assert not nav.is_complete, "a re-armed navigator is not complete"
    assert len(nav.waypoints) == len(new_route)
    assert (nav.x, nav.y) == (0.0, 0.0), "should reposition onto the new route start"


def test_set_waypoints_mid_flight_is_defensively_copied_too():
    nav = _make([(0.0, 0.0), (100.0, 0.0)], speed=5.0)
    nav.tick(1.0)
    new = [(0.0, 0.0), (5.0, 0.0), (5.0, 5.0)]
    nav.set_waypoints(new)
    new.clear()
    new.append((999.0, 999.0))
    for _ in range(1000):
        t = nav.tick(1.0)
        if t["mission_complete"]:
            break
    assert (nav.x, nav.y) == (5.0, 5.0), "re-injected route aliased the caller's list"


# --------------------------------------------------------------------------- #
# Stress
# --------------------------------------------------------------------------- #
def test_long_route_completes_in_bounded_ticks():
    """A dense hand-drawn polygon can plan thousands of waypoints. With a step
    that crosses several per tick it must still finish promptly and keep its
    counters consistent the whole way (no per-tick O(n) rescans)."""
    route = [(float(i % 200), float(i)) for i in range(10_000)]
    nav = _make(route, speed=50.0)
    last = None
    for _ in range(200_000):
        last = nav.tick(1.0)
        if last["mission_complete"]:
            break
    assert last["mission_complete"] is True, "10k-waypoint route did not finish in budget"
    assert last["waypoints_remaining"] == 0
    assert last["current_waypoint_idx"] == len(route)


def test_default_speed_auto_paces_small_lnglat_routes(monkeypatch):
    monkeypatch.setattr(config, "NAV_GEO_ROUTE_DURATION_S", 60.0)
    route = [(-117.83, 33.67), (-117.81, 33.67), (-117.81, 33.69)]
    expected_length = math.hypot(0.02, 0.0) + math.hypot(0.0, 0.02)

    nav = WaypointNavigator(route)

    assert nav.speed == pytest.approx(expected_length / 60.0)
    nav.activate()
    t = nav.tick(1.0)
    assert t["mission_complete"] is False
    assert (nav.x, nav.y) != route[-1]


def test_monotonic_counters_over_full_flight():
    route = [(float(i % 100), float((i * 7) % 100)) for i in range(500)]
    nav = _make(route, speed=20.0)
    prev_idx, prev_rem = -1, len(route) + 1
    for _ in range(100_000):
        t = nav.tick(1.0)
        _check_telemetry(t, len(route))
        assert t["current_waypoint_idx"] >= prev_idx, "idx went backwards"
        assert t["waypoints_remaining"] <= prev_rem, "remaining increased"
        prev_idx, prev_rem = t["current_waypoint_idx"], t["waypoints_remaining"]
        if t["mission_complete"]:
            break
    assert prev_rem == 0


def test_concurrent_tick_and_redeploy_never_crash():
    """The producer thread ticks while the WS thread redeploys a new route into
    the same navigator (Task 3 'update in place'). Neither may raise nor leave a
    torn, non-finite position."""
    nav = _make([(float(i % 100), float(i % 50)) for i in range(2000)], speed=10.0)
    errors = []
    stop = threading.Event()

    def ticker():
        try:
            for _ in range(50_000):
                if stop.is_set():
                    return
                t = nav.tick(1.0)
                assert _finite(t["x"]) and _finite(t["y"])
        except Exception as exc:  # noqa: BLE001
            errors.append(("tick", exc))

    def redeployer():
        try:
            routes = [
                [(0.0, 0.0), (80.0, 0.0), (80.0, 80.0)],
                [(10.0, 10.0), (60.0, 10.0)],
                [(float(i), float(i)) for i in range(300)],
            ]
            for _ in range(200):
                if stop.is_set():
                    return
                nav.set_waypoints(routes[_ % len(routes)])
        except Exception as exc:  # noqa: BLE001
            errors.append(("redeploy", exc))

    threads = [threading.Thread(target=ticker), threading.Thread(target=redeployer)]
    for t in threads:
        t.start()
    threads[1].join(timeout=30)
    stop.set()
    threads[0].join(timeout=10)
    assert not any(th.is_alive() for th in threads), "tick/redeploy deadlocked"
    assert not errors, f"concurrent tick/redeploy failures: {errors}"
