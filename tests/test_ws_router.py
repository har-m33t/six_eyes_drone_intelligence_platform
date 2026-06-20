"""Inbound command routing on the WebSocket server (Task 2).

These pin the START_MISSION contract: a valid drawn polygon is planned into a
per-drone waypoint dict and handed to the registered mission handler, while
malformed payloads are rejected without dispatching or raising.
"""
import json

import pytest

from src.transport import websocket_server as ws

# A 100 x 50 rectangle — same fixture the planner's own tests use.
RECT = [[0, 0], [100, 0], [100, 50], [0, 50]]


@pytest.fixture(autouse=True)
def clear_handler():
    """Each test starts with no handler and restores it afterwards."""
    ws.set_mission_handler(None)
    yield
    ws.set_mission_handler(None)


def test_start_mission_plans_and_dispatches():
    received = {}
    ws.set_mission_handler(lambda plan: received.update(plan))

    result = ws._handle_start_mission({"command": "START_MISSION", "polygon": RECT})

    # One contiguous chunk per drone, drone_1 .. drone_N, all from the planner.
    assert set(result) == {f"drone_{i}" for i in range(1, ws.NUM_DRONES + 1)}
    assert received == result
    total = sum(len(path) for path in result.values())
    assert total > 0
    # Waypoints are plain (x, y) float tuples — no shapely objects leak out.
    for path in result.values():
        for x, y in path:
            assert isinstance(x, float) and isinstance(y, float)


def test_start_mission_without_handler_still_plans():
    # No handler registered: the command is still validated and planned (just
    # not actioned), and nothing raises.
    result = ws._handle_start_mission({"command": "START_MISSION", "polygon": RECT})
    assert result is not None
    assert sum(len(p) for p in result.values()) > 0


@pytest.mark.parametrize(
    "polygon",
    [
        None,
        [],
        [[0, 0], [1, 1]],            # fewer than 3 vertices
        [[0, 0], [1, 1], "nope"],    # non-coordinate vertex
        [[0, 0], [1, 1], [2]],       # vertex missing a coordinate
        [[0, 0], [1, 1], [2, "x"]],  # non-numeric coordinate
    ],
)
def test_invalid_polygon_rejected(polygon):
    called = []
    ws.set_mission_handler(lambda plan: called.append(plan))
    result = ws._handle_start_mission({"command": "START_MISSION", "polygon": polygon})
    assert result is None
    assert called == []  # handler never fired on a bad polygon


def test_handler_exception_is_swallowed():
    def boom(_plan):
        raise RuntimeError("thread injection failed")

    ws.set_mission_handler(boom)
    # A faulting handler must not propagate out of the router (it would kill the
    # client socket otherwise).
    result = ws._handle_start_mission({"command": "START_MISSION", "polygon": RECT})
    assert result is not None


async def _dispatch(raw):
    await ws._dispatch_command(raw)


def test_dispatch_routes_start_mission():
    import asyncio

    received = {}
    ws.set_mission_handler(lambda plan: received.update(plan))
    asyncio.run(_dispatch(json.dumps({"command": "START_MISSION", "polygon": RECT})))
    assert received  # the planned mission reached the handler


def test_dispatch_ignores_garbage():
    import asyncio

    called = []
    ws.set_mission_handler(lambda plan: called.append(plan))
    asyncio.run(_dispatch("not json at all"))
    asyncio.run(_dispatch(json.dumps(["a", "list", "not", "a", "dict"])))
    asyncio.run(_dispatch(json.dumps({"command": "BOGUS"})))
    assert called == []
