"""Task 2 — adversarial tests for the START_MISSION WebSocket router.

Complements ``tests/test_ws_router.py`` (which covers the happy path) by trying
hard to *break* the inbound command path in ``src/transport/websocket_server``:

  * ``_is_valid_polygon``   — the gatekeeper that must reject every malformed
                              drawn polygon before it reaches shapely.
  * ``_handle_start_mission`` — plans a valid polygon via
                              ``plan_mission(polygon_coords=…, num_drones=6)``
                              and dispatches to the registered handler; returns
                              None (no dispatch) on a rejected payload.
  * ``_dispatch_command``   — the async recv() interceptor; must never raise on
                              a hostile/garbled frame (a raise kills the client
                              socket and can take down the broadcast path).

Three real gaps surfaced while writing these are pinned as ``xfail`` (see the
companion notes appended to ``.claude/deploy-swarm-integration.md``): they keep
the suite green today and will report XPASS the moment the validator/handler is
hardened.

Async handlers are driven with ``asyncio.run`` inside sync tests (the same
pattern test_ws_router uses) so no pytest-asyncio plugin is needed — important
because plugin autoload is disabled in this repo (pytest.ini).
"""
import asyncio
import json
import math

import pytest

from src.transport import websocket_server as ws

# 100 x 50 rectangle — the planner's own fixture; yields a non-empty plan.
RECT = [[0, 0], [100, 0], [100, 50], [0, 50]]
VALID_MESSAGE = {"command": "START_MISSION", "polygon": RECT}


@pytest.fixture(autouse=True)
def clear_handler():
    """Every test starts/ends with no mission handler registered."""
    ws.set_mission_handler(None)
    yield
    ws.set_mission_handler(None)


class _PlanSpy:
    """Captures plan_mission calls; returns a canned per-drone plan."""

    def __init__(self, result=None, raises=None):
        self.calls = []
        self._result = result if result is not None else {
            f"drone_{i}": [(float(i), float(i))] for i in range(1, ws.NUM_DRONES + 1)
        }
        self._raises = raises

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self._raises is not None:
            raise self._raises
        return self._result


# --------------------------------------------------------------------------- #
# _is_valid_polygon — what the gatekeeper accepts
# --------------------------------------------------------------------------- #
def test_valid_polygon_accepts_rectangle():
    assert ws._is_valid_polygon(RECT) is True


def test_valid_polygon_accepts_tuples_and_floats():
    assert ws._is_valid_polygon([(0.0, 0.0), (10.5, 0.0), (5.0, 9.9)]) is True


def test_valid_polygon_accepts_many_vertices():
    circle = [[50 + 40 * math.cos(t / 32 * 2 * math.pi),
               50 + 40 * math.sin(t / 32 * 2 * math.pi)] for t in range(32)]
    assert ws._is_valid_polygon(circle) is True


@pytest.mark.parametrize("polygon", [
    None,                       # missing
    "abcdef",                   # string masquerading as a vertex sequence
    5,                          # scalar
    {"a": [0, 0]},              # mapping
    [],                         # empty
    [[0, 0]],                   # 1 vertex
    [[0, 0], [1, 1]],           # 2 vertices (< 3, shapely would raise)
])
def test_valid_polygon_rejects_bad_containers(polygon):
    assert ws._is_valid_polygon(polygon) is False


@pytest.mark.parametrize("vertex", [
    [0],            # too short
    [0, 0, 0],      # 3-D / extra coord
    [],             # empty
    5,              # scalar, not a pair
    "xy",           # 2-char string is len-2 but not numeric
    None,           # null vertex
    {"x": 0, "y": 0},  # mapping
])
def test_valid_polygon_rejects_malformed_vertex(vertex):
    assert ws._is_valid_polygon([[0, 0], [10, 0], vertex]) is False


@pytest.mark.parametrize("bad", ["10", "ten", None, [1], (1, 2)])
def test_valid_polygon_rejects_non_numeric_coordinate(bad):
    assert ws._is_valid_polygon([[0, 0], [10, 0], [bad, 10]]) is False


# --- Formerly-known gaps, now fixed (see deploy-swarm-integration.md) ------- #
# These were xfail until _is_valid_polygon / _handle_start_mission were
# hardened; they are now real regression guards.
@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_coordinate_should_be_rejected(bad):
    """GAP 1 fixed: NaN/±Inf are non-finite and must be rejected, not planned
    into a silently-empty mission."""
    assert ws._is_valid_polygon([[0, 0], [10, 0], [bad, 10]]) is False


def test_bool_coordinate_should_be_rejected():
    """GAP 2 fixed: bool subclasses int but is not a coordinate."""
    assert ws._is_valid_polygon([[True, False], [10, 0], [5, 9]]) is False


# --------------------------------------------------------------------------- #
# _handle_start_mission — planning + dispatch contract
# --------------------------------------------------------------------------- #
def test_handle_calls_planner_with_exact_contract(monkeypatch):
    """Task 2 mandates plan_mission(polygon_coords=polygon, num_drones=6)."""
    spy = _PlanSpy()
    monkeypatch.setattr(ws, "plan_mission", spy)

    ws._handle_start_mission(VALID_MESSAGE)

    assert len(spy.calls) == 1
    _, kwargs = spy.calls[0]
    assert kwargs["num_drones"] == ws.NUM_DRONES == 6
    # Vertices are normalised to plain (float, float) tuples for shapely.
    coords = kwargs["polygon_coords"]
    assert coords == [(0.0, 0.0), (100.0, 0.0), (100.0, 50.0), (0.0, 50.0)]
    assert all(isinstance(x, float) and isinstance(y, float) for x, y in coords)


def test_handle_returns_planner_output_and_dispatches(monkeypatch):
    spy = _PlanSpy()
    monkeypatch.setattr(ws, "plan_mission", spy)
    received = []
    ws.set_mission_handler(received.append)

    result = ws._handle_start_mission(VALID_MESSAGE)

    assert result == spy._result
    assert received == [spy._result], "the planned mission must reach the handler"


def test_handle_invalid_polygon_returns_none_and_skips_planner(monkeypatch):
    spy = _PlanSpy()
    monkeypatch.setattr(ws, "plan_mission", spy)
    called = []
    ws.set_mission_handler(called.append)

    result = ws._handle_start_mission({"command": "START_MISSION", "polygon": [[0, 0]]})

    assert result is None
    assert spy.calls == [], "planner must not run on a rejected polygon"
    assert called == [], "handler must not fire on a rejected polygon"


def test_handle_missing_polygon_key_returns_none(monkeypatch):
    spy = _PlanSpy()
    monkeypatch.setattr(ws, "plan_mission", spy)
    assert ws._handle_start_mission({"command": "START_MISSION"}) is None
    assert spy.calls == []


def test_handle_zero_area_polygon_plans_empty_not_none():
    """A collinear scribble is structurally valid: the real planner returns six
    empty paths, so the handler returns a (non-None) plan, not a rejection.
    """
    line = [[0, 0], [10, 0], [20, 0]]  # zero area
    result = ws._handle_start_mission({"command": "START_MISSION", "polygon": line})
    assert result is not None
    assert set(result) == {f"drone_{i}" for i in range(1, ws.NUM_DRONES + 1)}
    assert all(path == [] for path in result.values())


def test_handle_swallows_handler_exception(monkeypatch):
    """A faulting Task-3 handler must not propagate (it would kill the socket)."""
    spy = _PlanSpy()
    monkeypatch.setattr(ws, "plan_mission", spy)

    def boom(_plan):
        raise RuntimeError("thread injection failed")

    ws.set_mission_handler(boom)
    result = ws._handle_start_mission(VALID_MESSAGE)
    assert result == spy._result  # planning still succeeded; fault contained


def test_handle_real_planner_end_to_end():
    """No monkeypatch — drive the genuine planner and check full coverage."""
    from src.coverage_planner import plan_mission as real_plan

    result = ws._handle_start_mission(VALID_MESSAGE)
    expected = real_plan(polygon_coords=[(float(x), float(y)) for x, y in RECT],
                         num_drones=ws.NUM_DRONES)
    assert result == expected
    assert sum(len(p) for p in result.values()) > 0


# --------------------------------------------------------------------------- #
# _dispatch_command — the async recv() interceptor must never raise
# --------------------------------------------------------------------------- #
def _dispatch(raw):
    return asyncio.run(ws._dispatch_command(raw))


def test_dispatch_routes_valid_start_mission():
    received = []
    ws.set_mission_handler(received.append)
    _dispatch(json.dumps(VALID_MESSAGE))
    assert received, "valid START_MISSION must reach the handler"


def test_dispatch_returns_none():
    """The interceptor is fire-and-forget; it reports nothing back to recv()."""
    assert _dispatch(json.dumps(VALID_MESSAGE)) is None


def test_dispatch_accepts_bytes_frame():
    """websockets can deliver binary frames; json.loads handles bytes."""
    received = []
    ws.set_mission_handler(received.append)
    _dispatch(json.dumps(VALID_MESSAGE).encode("utf-8"))
    assert received


@pytest.mark.parametrize("raw", [
    "not json at all",
    "",
    "{",
    json.dumps(["a", "list"]),       # non-dict JSON
    json.dumps(42),                  # bare number
    json.dumps("START_MISSION"),     # bare string
    json.dumps(None),                # null
    json.dumps({"command": "BOGUS", "polygon": RECT}),     # unknown command
    json.dumps({"command": None, "polygon": RECT}),        # null command
    json.dumps({"polygon": RECT}),                          # no command key
    json.dumps({"command": "START_MISSION"}),              # no polygon
    json.dumps({"command": "START_MISSION", "polygon": "x"}),   # bad polygon
    json.dumps({"command": "START_MISSION", "polygon": [[0, 0], [1, 1]]}),  # < 3
    json.dumps({"command": 123, "polygon": RECT}),         # non-string command
    None,                            # not even a string
    123,                             # int frame
])
def test_dispatch_never_raises_and_never_dispatches_on_garbage(raw):
    """No hostile frame may dispatch a mission or escape as an exception."""
    called = []
    ws.set_mission_handler(called.append)
    try:
        _dispatch(raw)
    except Exception as exc:  # noqa: BLE001 — exactly the thing we forbid
        pytest.fail(f"_dispatch_command raised on {raw!r}: {exc!r}")
    assert called == [], f"garbage frame {raw!r} must not dispatch a mission"


# --- Formerly a gap: planner faults are now contained ---------------------- #
def test_dispatch_contains_planner_exception(monkeypatch):
    """GAP 3 fixed: a planner fault on a structurally-valid polygon is caught in
    _handle_start_mission and must not propagate out of the recv interceptor
    (which would kill the client socket)."""
    monkeypatch.setattr(ws, "plan_mission", _PlanSpy(raises=RuntimeError("planner exploded")))
    _dispatch(json.dumps(VALID_MESSAGE))  # must NOT raise
