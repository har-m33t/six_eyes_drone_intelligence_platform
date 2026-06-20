"""Primary transport: asyncio WebSocket server that broadcasts every packet
to all connected dashboard clients.

The producer threads are synchronous; they reach this asyncio loop via
asyncio.run_coroutine_threadsafe() in foundry_client.DualSinkSender.

The socket is also the *inbound* command channel: the dashboard sends a
``START_MISSION`` command (a drawn search polygon) which this server hands to
the coverage planner and forwards to whoever owns the producer threads via the
registered mission handler (see set_mission_handler / Task 3).
"""
import asyncio
import json
from dataclasses import asdict

import websockets

from .. import config
from ..coverage_planner import plan_mission

CLIENTS = set()

# Number of drones in the swarm — the planner partitions the sweep into this
# many contiguous chunks (drone_1 .. drone_6).
NUM_DRONES = len(config.DRONE_IDS)

# Hook the thread manager registers (Task 3) to receive a freshly planned
# mission: a dict {"drone_1": [(x, y), ...], ...}. Kept as a module-level
# callback so this router stays decoupled from producer.py — Task 2 plans the
# mission; whoever registers decides what to do with it. None = no consumer yet
# (the command is still validated/planned and logged, just not actioned).
_mission_handler = None


def set_mission_handler(handler):
    """Register a callable invoked with the per-drone waypoint plan whenever a
    valid START_MISSION arrives. Pass None to clear it.
    """
    global _mission_handler
    _mission_handler = handler


def _is_valid_polygon(polygon) -> bool:
    """A usable polygon is a list of at least three [x, y] numeric vertices."""
    if not isinstance(polygon, (list, tuple)) or len(polygon) < 3:
        return False
    for vertex in polygon:
        if not isinstance(vertex, (list, tuple)) or len(vertex) != 2:
            return False
        if not all(isinstance(coord, (int, float)) for coord in vertex):
            return False
    return True


def _handle_start_mission(message: dict):
    """Plan a mission from a START_MISSION payload and dispatch it.

    Returns the per-drone plan dict on success, or None if the payload was
    rejected. Pure/synchronous: the planner is light geometry and the handler
    is the caller's concern — kept off the broadcast path either way.
    """
    polygon = message.get("polygon")
    if not _is_valid_polygon(polygon):
        print(f"[WS] START_MISSION rejected — invalid polygon: {polygon!r}")
        return None

    # Normalise vertices to plain (x, y) float tuples for shapely/the planner.
    polygon_coords = [(float(x), float(y)) for x, y in polygon]
    mission_plan = plan_mission(polygon_coords=polygon_coords, num_drones=NUM_DRONES)

    assigned = sum(1 for path in mission_plan.values() if path)
    total_waypoints = sum(len(path) for path in mission_plan.values())
    print(
        f"[WS] START_MISSION planned — {len(polygon_coords)} vertices -> "
        f"{total_waypoints} waypoints across {assigned}/{NUM_DRONES} drones."
    )

    if _mission_handler is None:
        print("[WS] No mission handler registered — plan not actioned (Task 3 pending).")
        return mission_plan

    try:
        _mission_handler(mission_plan)
    except Exception as exc:  # never let a handler fault kill the socket
        print(f"[WS] Mission handler raised, mission not started: {exc!r}")
    return mission_plan


async def _dispatch_command(raw):
    """Parse one inbound text frame and route any recognised command."""
    try:
        message = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        print("[WS] Ignoring non-JSON client message.")
        return
    if not isinstance(message, dict):
        return

    command = message.get("command")
    if command == "START_MISSION":
        _handle_start_mission(message)
    elif command is not None:
        print(f"[WS] Ignoring unknown command: {command!r}")


async def register(websocket):
    CLIENTS.add(websocket)
    try:
        # Iterating the socket both keeps the client registered for broadcasts
        # (until it closes) and surfaces inbound command frames to route.
        async for raw in websocket:
            await _dispatch_command(raw)
    finally:
        CLIENTS.discard(websocket)


async def broadcast(packet):
    if CLIENTS:
        message = json.dumps(asdict(packet))
        await asyncio.gather(
            *[client.send(message) for client in CLIENTS],
            return_exceptions=True,
        )


async def serve_forever(host: str = None, port: int = None):
    host = host or config.WS_HOST
    port = port or config.WS_PORT
    async with websockets.serve(register, host, port):
        print(f"[WS] Serving on ws://{host}:{port}")
        await asyncio.Future()  # run forever
