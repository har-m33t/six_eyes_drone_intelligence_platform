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
import math
from dataclasses import asdict

import websockets
from websockets.exceptions import ConnectionClosed

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

# Hook the thread manager registers to receive a KILL_DRONE request: a single
# normalised drone id (e.g. "DRONE_3") to force OFFLINE. Same decoupling rationale
# as _mission_handler — the router validates/logs the command; whoever registers
# decides how to action it (producer.kill_drone sets the per-drone stop Event).
# None = no consumer yet (the command is still validated and logged).
_kill_handler = None


def set_mission_handler(handler):
    """Register a callable invoked with the per-drone waypoint plan whenever a
    valid START_MISSION arrives. Pass None to clear it.
    """
    global _mission_handler
    _mission_handler = handler


def set_kill_handler(handler):
    """Register a callable invoked with a single drone id whenever a valid
    KILL_DRONE arrives (the dashboard's signal-lost demo control, README §9).
    Pass None to clear it.
    """
    global _kill_handler
    _kill_handler = handler


def _is_finite_number(coord) -> bool:
    """A usable coordinate is a real, finite int/float.

    Rejects ``bool`` (a subclass of ``int`` — ``[True, False]`` would otherwise
    sneak through as ``(1.0, 0.0)``) and non-finite ``NaN``/``±Inf`` (which
    ``isinstance(_, float)`` accepts but which the planner turns into an empty,
    silently-idle mission). See GAPs 1 & 2 in deploy-swarm-integration.md.
    """
    if isinstance(coord, bool) or not isinstance(coord, (int, float)):
        return False
    return math.isfinite(coord)


def _is_valid_polygon(polygon) -> bool:
    """A usable polygon is a list of at least three ``[lng, lat]`` finite-numeric
    vertices (the dashboard's Mapbox Draw control emits geographic coordinates).
    Structural validation only — range checking (|lng|<=180, |lat|<=90) is left
    to the planner, which is coordinate-system agnostic."""
    if not isinstance(polygon, (list, tuple)) or len(polygon) < 3:
        return False
    for vertex in polygon:
        if not isinstance(vertex, (list, tuple)) or len(vertex) != 2:
            return False
        if not all(_is_finite_number(coord) for coord in vertex):
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
        print(f"[WS] START_MISSION rejected -- invalid polygon: {polygon!r}")
        return None

    # Normalise vertices to plain (lng, lat) float tuples for shapely/the planner.
    # The planner is unit-agnostic and self-scales its sweep spacing from the
    # polygon extent, so geographic degrees need no special handling here.
    polygon_coords = [(float(x), float(y)) for x, y in polygon]

    # Guard the planner call too, not just the handler below: a geometry fault on
    # a structurally-valid polygon must be contained here, otherwise it unwinds
    # through _dispatch_command's recv loop and kills the client socket (GAP 3).
    try:
        mission_plan = plan_mission(polygon_coords=polygon_coords, num_drones=NUM_DRONES)
    except Exception as exc:
        print(f"[WS] START_MISSION planning failed, mission not started: {exc!r}")
        return None

    assigned = sum(1 for path in mission_plan.values() if path)
    total_waypoints = sum(len(path) for path in mission_plan.values())
    print(
        f"[WS] START_MISSION planned -- {len(polygon_coords)} vertices -> "
        f"{total_waypoints} waypoints across {assigned}/{NUM_DRONES} drones."
    )

    if _mission_handler is None:
        print("[WS] No mission handler registered -- plan not actioned (Task 3 pending).")
        return mission_plan

    try:
        _mission_handler(mission_plan)
    except Exception as exc:  # never let a handler fault kill the socket
        print(f"[WS] Mission handler raised, mission not started: {exc!r}")
    return mission_plan


def _handle_kill_drone(message: dict):
    """Force a target drone OFFLINE from a KILL_DRONE payload (README §9
    signal-lost demo control).

    Returns the normalised drone id on a valid request (even if no handler is
    registered, mirroring _handle_start_mission), or None if the payload was
    rejected. Pure/synchronous and fully guarded so a malformed or hostile
    command can never unwind through the recv loop and drop the client socket.
    """
    drone_id = message.get("drone_id")
    if not isinstance(drone_id, str):
        print(f"[WS] KILL_DRONE rejected -- drone_id not a string: {drone_id!r}")
        return None

    # Normalise to the canonical DRONE_N id and validate against the roster, so a
    # typo'd / out-of-range target is dropped rather than silently mis-killing.
    normalised = drone_id.strip().upper()
    if normalised not in config.DRONE_IDS:
        print(f"[WS] KILL_DRONE rejected -- unknown drone: {drone_id!r}")
        return None

    if _kill_handler is None:
        print(f"[WS] KILL_DRONE received for {normalised} -- no kill handler registered.")
        return normalised

    try:
        _kill_handler(normalised)
    except Exception as exc:  # never let a handler fault kill the socket
        print(f"[WS] Kill handler raised, drone not killed: {exc!r}")
        return normalised

    print(f"[WS] KILL_DRONE -- {normalised} forced OFFLINE.")
    return normalised


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
    elif command == "KILL_DRONE":
        _handle_kill_drone(message)
    elif command is not None:
        print(f"[WS] Ignoring unknown command: {command!r}")


async def register(websocket):
    CLIENTS.add(websocket)
    try:
        # Iterating the socket both keeps the client registered for broadcasts
        # (until it closes) and surfaces inbound command frames to route.
        async for raw in websocket:
            await _dispatch_command(raw)
    except ConnectionClosed:
        # Browser refreshes, sleeping tabs, and keepalive timeouts close the
        # recv iterator with ConnectionClosedError. Treat that as normal client
        # cleanup, not an unhandled server failure with a traceback.
        pass
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
