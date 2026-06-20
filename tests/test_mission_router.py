"""Task 2 — Backend WebSocket router for the ``START_MISSION`` command.

These tests pin the contract of the *not-yet-built* mission router that
``.claude/deploy-swarm-integration.md`` Task 2 asks for: the piece that
intercepts a ``START_MISSION`` frame on the WebSocket ``recv()`` listener,
extracts the drawn polygon, and hands it to
``coverage_planner.plan_mission(polygon_coords=polygon, num_drones=6)``.

This is a test-driven *specification*. The code under test does not exist yet,
so the whole module skips cleanly at collection time (see the import guard
below) until it is built — per the task instruction "do not run as code hasn't
been built yet". The suite then runs the moment the symbol appears.

────────────────────────────────────────────────────────────────────────────
ASSUMED CONTRACT  (build this in ``src/transport/websocket_server.py``)
────────────────────────────────────────────────────────────────────────────
A module-level, *synchronous*, *pure* function::

    def route_command(message) -> dict: ...

so the async ``recv()`` loop is a thin shell around it, e.g.::

    async for raw in websocket:
        ack = route_command(raw)            # never raises
        await websocket.send(json.dumps(ack))

Behaviour:
  * ``message`` may be a raw JSON **str** (straight off the wire) OR an
    already-parsed **dict**. Both must be accepted.
  * It MUST NEVER raise. Any malformed client frame has to come back as an
    error ack — a raised exception would kill the recv loop / the connection
    and (worse) must never touch the live broadcast path.
  * Returns a dict ack with ``"status": "ok" | "error"``.
      - ok   → also carries ``"command"`` and ``"assignments"`` (the exact
               ``plan_mission`` output: ``{"drone_1": [...], ..., "drone_6": ...}``).
      - error→ also carries a truthy short ``"error"`` reason string.
  * On a valid ``START_MISSION`` it calls
    ``plan_mission(polygon_coords=<polygon>, num_drones=6)`` — bound at module
    scope as ``plan_mission`` so it is monkeypatchable (the same pattern
    ``tests/test_producer_integration.py`` uses for ``producer.write_*``).
  * Polygon validation (must hold the recv loop alive against adversarial
    frames): the polygon must be a sequence of **≥ 3** vertices, each a
    2-element sequence of **finite** real numbers. Anything else → error ack,
    NOT a propagated exception.

Out of scope here (Task 3): injecting the returned waypoint arrays into the
running producer threads / unpausing ``WaypointNavigator.tick()``. That seam is
tested separately; this file stops at "router returned the right assignments".
"""
import json
import math

import pytest

# The transport module itself is already built (it just lacks route_command);
# importorskip also covers a missing ``websockets`` dep on a bare checkout.
ws_server = pytest.importorskip("src.transport.websocket_server")

route_command = getattr(ws_server, "route_command", None)
if route_command is None:  # Task 2 not implemented yet — skip the whole module.
    pytest.skip(
        "Task 2 not built: expected src.transport.websocket_server.route_command "
        "(see this module's docstring for the assumed contract).",
        allow_module_level=True,
    )


# --------------------------------------------------------------------------- #
# Fixtures / helpers
# --------------------------------------------------------------------------- #
# The strict schema from the task spec (deploy-swarm-integration.md, Task 1).
VALID_POLYGON = [[10, 10], [100, 10], [100, 100], [10, 100]]
VALID_MESSAGE = {"command": "START_MISSION", "polygon": VALID_POLYGON}


class _PlanSpy:
    """Records every plan_mission call and returns a canned 6-drone mapping.

    Lets us assert the router forwards the polygon verbatim with the exact
    ``num_drones=6`` keyword the task mandates, without depending on the real
    geometry output.
    """

    def __init__(self, result=None, raises=None):
        self.calls = []
        self._result = result if result is not None else {
            f"drone_{i}": [(float(i), float(i))] for i in range(1, 7)
        }
        self._raises = raises

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self._raises is not None:
            raise self._raises
        return self._result


@pytest.fixture
def spy(monkeypatch):
    """Install a plan_mission spy on the router module and hand it back."""
    s = _PlanSpy()
    monkeypatch.setattr(ws_server, "plan_mission", s)
    return s


def _ok(result):
    assert isinstance(result, dict), f"ack must be a dict, got {type(result)}"
    assert result.get("status") == "ok", f"expected ok ack, got {result}"
    return result


def _err(result):
    assert isinstance(result, dict), f"ack must be a dict, got {type(result)}"
    assert result.get("status") == "error", f"expected error ack, got {result}"
    # An error ack must explain itself with a non-empty reason string.
    reason = result.get("error")
    assert isinstance(reason, str) and reason, f"missing error reason in {result}"
    return result


# --------------------------------------------------------------------------- #
# Happy path — the documented schema
# --------------------------------------------------------------------------- #
def test_dict_message_returns_ok_with_six_assignments(spy):
    result = _ok(route_command(VALID_MESSAGE))
    assert result["command"] == "START_MISSION"
    assert set(result["assignments"]) == {f"drone_{i}" for i in range(1, 7)}


def test_raw_json_string_is_accepted(spy):
    """The wire delivers text frames — a JSON *string* must work too."""
    result = _ok(route_command(json.dumps(VALID_MESSAGE)))
    assert set(result["assignments"]) == {f"drone_{i}" for i in range(1, 7)}


def test_plan_mission_called_once_with_exact_contract(spy):
    """Task 2 is explicit: plan_mission(polygon_coords=polygon, num_drones=6)."""
    route_command(VALID_MESSAGE)
    assert len(spy.calls) == 1, "plan_mission must be called exactly once"
    args, kwargs = spy.calls[0]
    # num_drones must be 6 (the swarm size the task hard-codes).
    assert kwargs.get("num_drones", (args[1] if len(args) > 1 else None)) == 6
    # The polygon must reach the planner unmodified.
    passed = kwargs.get("polygon_coords", args[0] if args else None)
    assert [list(v) for v in passed] == VALID_POLYGON


def test_assignments_are_planner_output_verbatim(spy):
    result = _ok(route_command(VALID_MESSAGE))
    assert result["assignments"] == spy._result


def test_router_never_touches_broadcast_clients(spy):
    """Command handling is orthogonal to the live broadcast path."""
    before = set(ws_server.CLIENTS)
    route_command(VALID_MESSAGE)
    assert set(ws_server.CLIENTS) == before, "router must not mutate CLIENTS"


def test_repeated_commands_plan_each_time(spy):
    """A second polygon re-plans — no caching/short-circuit."""
    route_command(VALID_MESSAGE)
    route_command(VALID_MESSAGE)
    assert len(spy.calls) == 2


def test_extra_unknown_keys_are_ignored(spy):
    msg = dict(VALID_MESSAGE, mission_id="abc", note="ignore me", num_drones=999)
    _ok(route_command(msg))
    # The router must NOT let a client override the swarm size via a stray key.
    _, kwargs = spy.calls[0]
    assert kwargs.get("num_drones", 6) == 6


def test_polygon_of_tuples_is_accepted(spy):
    """An internal/dict caller may pass tuples instead of JSON lists."""
    msg = {"command": "START_MISSION", "polygon": [(10, 10), (100, 10), (50, 90)]}
    _ok(route_command(msg))


def test_float_coordinates_accepted(spy):
    """Frontend sends SIM_WORLD floats — these must pass straight through."""
    poly = [[10.5, 10.25], [100.0, 10.0], [100.0, 100.75], [10.0, 100.0]]
    msg = {"command": "START_MISSION", "polygon": poly}
    _ok(route_command(msg))
    _, kwargs = spy.calls[0]
    assert [list(v) for v in kwargs["polygon_coords"]] == poly


# --------------------------------------------------------------------------- #
# Real planner integration (coverage_planner IS built) — no spy, end to end.
# --------------------------------------------------------------------------- #
def test_end_to_end_with_real_planner_rectangle():
    """No monkeypatch: drive the genuine plan_mission and assert full coverage."""
    from src.coverage_planner import plan_mission as real_plan

    msg = {"command": "START_MISSION",
           "polygon": [[0, 0], [100, 0], [100, 50], [0, 50]]}
    result = _ok(route_command(msg))
    expected = real_plan(polygon_coords=msg["polygon"], num_drones=6)
    # Compare structurally (router may hand back lists where the planner used
    # tuples after a JSON round-trip); lengths + ordering must match exactly.
    assert set(result["assignments"]) == set(expected)
    for k in expected:
        got = [tuple(p) for p in result["assignments"][k]]
        assert got == [tuple(p) for p in expected[k]]


def test_end_to_end_concave_polygon_returns_six_drones():
    u_shape = [[0, 0], [100, 0], [100, 100], [70, 100],
               [70, 30], [30, 30], [30, 100], [0, 100]]
    result = _ok(route_command({"command": "START_MISSION", "polygon": u_shape}))
    assert len(result["assignments"]) == 6


def test_end_to_end_zero_area_polygon_plans_empty_not_error():
    """A collinear scribble is a *valid* frame: the planner returns empty paths,
    so the router answers ok with six empty assignments — not an error.
    """
    line = [[0, 0], [10, 0], [20, 0]]  # zero area -> plan_mission yields [] each
    result = _ok(route_command({"command": "START_MISSION", "polygon": line}))
    assert all(chunk == [] for chunk in result["assignments"].values())
    assert len(result["assignments"]) == 6


# --------------------------------------------------------------------------- #
# Malformed transport — bad JSON / wrong top-level types
# --------------------------------------------------------------------------- #
def test_invalid_json_string_is_rejected_not_raised(spy):
    _err(route_command("{not valid json"))
    assert spy.calls == [], "planner must not run on un-parseable input"


def test_empty_string_is_rejected(spy):
    _err(route_command(""))
    assert spy.calls == []


@pytest.mark.parametrize("raw", ["[]", "[1,2,3]", '"START_MISSION"', "42", "true", "null"])
def test_non_object_json_is_rejected(spy, raw):
    """Top-level JSON that isn't an object (dict) can't carry a command."""
    _err(route_command(raw))
    assert spy.calls == []


@pytest.mark.parametrize("message", [None, 42, 3.14, [VALID_POLYGON], ("START_MISSION",)])
def test_non_dict_non_str_message_is_rejected(spy, message):
    _err(route_command(message))
    assert spy.calls == []


# --------------------------------------------------------------------------- #
# Command field problems
# --------------------------------------------------------------------------- #
def test_missing_command_is_rejected(spy):
    _err(route_command({"polygon": VALID_POLYGON}))
    assert spy.calls == []


@pytest.mark.parametrize("cmd", [
    "STOP_MISSION", "start_mission", "Start_Mission", " START_MISSION",
    "START_MISSION ", "RETURN_HOME", "", "PAUSE",
])
def test_unknown_or_miscased_command_is_rejected(spy, cmd):
    """Command matching is exact and case-sensitive — only START_MISSION plans."""
    _err(route_command({"command": cmd, "polygon": VALID_POLYGON}))
    assert spy.calls == [], f"{cmd!r} must not trigger planning"


@pytest.mark.parametrize("cmd", [None, 123, ["START_MISSION"], {"x": 1}, True])
def test_non_string_command_is_rejected(spy, cmd):
    _err(route_command({"command": cmd, "polygon": VALID_POLYGON}))
    assert spy.calls == []


# --------------------------------------------------------------------------- #
# Polygon validation — the adversarial surface
# --------------------------------------------------------------------------- #
def test_missing_polygon_is_rejected(spy):
    _err(route_command({"command": "START_MISSION"}))
    assert spy.calls == []


@pytest.mark.parametrize("polygon", [None, "polygon", 5, {"a": 1}, True])
def test_polygon_wrong_container_type_is_rejected(spy, polygon):
    _err(route_command({"command": "START_MISSION", "polygon": polygon}))
    assert spy.calls == []


@pytest.mark.parametrize("polygon", [[], [[0, 0]], [[0, 0], [1, 1]]])
def test_polygon_with_fewer_than_three_vertices_is_rejected(spy, polygon):
    """A polygon needs ≥3 vertices; shapely raises below that, so the router
    must reject it *before* calling the planner — never let it propagate.
    """
    _err(route_command({"command": "START_MISSION", "polygon": polygon}))
    assert spy.calls == [], "planner must not see a sub-triangle polygon"


@pytest.mark.parametrize("vertex", [
    [0],            # too short
    [0, 0, 0],      # too long (3D / extra)
    [],             # empty vertex
    5,              # scalar, not a pair
    "xy",           # string masquerading as a 2-seq
    None,           # null vertex
    {"x": 0, "y": 0},  # mapping, not a sequence pair
])
def test_polygon_with_malformed_vertex_is_rejected(spy, vertex):
    poly = [[0, 0], [10, 0], vertex]  # one bad vertex poisons the frame
    _err(route_command({"command": "START_MISSION", "polygon": poly}))
    assert spy.calls == []


@pytest.mark.parametrize("bad", ["10", "ten", None, [1]])
def test_polygon_with_non_numeric_coordinate_is_rejected(spy, bad):
    poly = [[0, 0], [10, 0], [bad, 10]]
    _err(route_command({"command": "START_MISSION", "polygon": poly}))
    assert spy.calls == []


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_polygon_with_non_finite_coordinate_is_rejected(spy, bad):
    """NaN/Infinity survive ``json.loads`` by default and quietly corrupt the
    geometry (empty area / garbage waypoints). They must be rejected up front.
    """
    poly = [[0, 0], [10, 0], [bad, 10]]
    _err(route_command({"command": "START_MISSION", "polygon": poly}))
    assert spy.calls == []


def test_non_finite_via_raw_json_string_is_rejected(spy):
    """Same guard, but arriving as a real wire frame (json allows NaN/Infinity)."""
    raw = '{"command": "START_MISSION", "polygon": [[0,0],[10,0],[NaN, 10]]}'
    _err(route_command(raw))
    assert spy.calls == []


# --------------------------------------------------------------------------- #
# Planner blowups must be contained (recv loop stays alive)
# --------------------------------------------------------------------------- #
def test_planner_exception_is_contained(monkeypatch):
    """If plan_mission throws on a structurally-valid polygon, the router must
    swallow it into an error ack — a crash here would kill the connection.
    """
    boom = _PlanSpy(raises=RuntimeError("planner exploded"))
    monkeypatch.setattr(ws_server, "plan_mission", boom)
    _err(route_command(VALID_MESSAGE))


def test_planner_value_error_is_contained(monkeypatch):
    boom = _PlanSpy(raises=ValueError("bad spacing"))
    monkeypatch.setattr(ws_server, "plan_mission", boom)
    _err(route_command(VALID_MESSAGE))


# --------------------------------------------------------------------------- #
# Blanket fuzz: NOTHING makes route_command raise
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("garbage", [
    None, 0, 1, -1, 1.5, True, False, "", "   ", "\x00", "💥",
    "{", "}", "[]", "{}", "[[[", "null", "NaN",
    [], {}, set(), object(),
    {"command": "START_MISSION"},
    {"command": "START_MISSION", "polygon": None},
    {"command": "START_MISSION", "polygon": []},
    {"command": "START_MISSION", "polygon": [[0, 0]]},
    {"command": "START_MISSION", "polygon": [[0, 0], [1, "x"], [2, 2]]},
    {"command": 123, "polygon": VALID_POLYGON},
    {"polygon": VALID_POLYGON},
    {"command": "DROP_TABLES", "polygon": VALID_POLYGON},
    '{"command": "START_MISSION", "polygon": "not-a-list"}',
    '{"command": "START_MISSION"}',
    '{"command": 999}',
    json.dumps(VALID_MESSAGE),  # the one valid frame, for good measure
])
def test_route_command_never_raises_and_always_returns_a_status(spy, garbage):
    """The single most important property: a hostile/garbled client frame can
    never take down the recv loop. Every input yields a dict carrying a status.
    """
    try:
        result = route_command(garbage)
    except Exception as exc:  # noqa: BLE001 — that's exactly what we're forbidding
        pytest.fail(f"route_command raised on {garbage!r}: {exc!r}")
    assert isinstance(result, dict)
    assert result.get("status") in {"ok", "error"}


def test_large_polygon_is_handled(spy):
    """A many-vertex frame (dense hand-drawn circle) must not be a problem."""
    poly = [[50 + 40 * math.cos(t / 50 * 2 * math.pi),
             50 + 40 * math.sin(t / 50 * 2 * math.pi)] for t in range(50)]
    _ok(route_command({"command": "START_MISSION", "polygon": poly}))
    assert len(spy.calls) == 1
