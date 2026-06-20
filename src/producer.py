"""Producer threads: one daemon thread per drone. Each loops its MP4 at
real-time FPS, runs YOLO detection, builds a packet, and hands it to the sender.
"""
import base64
import math
import threading
import time

import cv2

from . import config
from .inference import load_model, run_detection
from .navigation import WaypointNavigator
from .packet import (
    build_packet, make_detection_row, make_nav_packet, make_telemetry_row)
from .transport.foundry_client import (
    start_foundry_flusher, write_detection, write_telemetry)

# Per-drone stop flags — set the Event to kill a drone (e.g. demo signal-lost).
stop_events = {drone_id: threading.Event() for drone_id in config.DRONE_IDS}

# --- Deploy Swarm: thread activation (Task 3) -------------------------------
# Active WaypointNavigators, keyed by DRONE_ID. Empty until the operator deploys
# a search polygon: until then the producers just stream video + simulated GPS
# (navigation is "paused"). inject_mission() installs/refreshes navigators here
# and the producer threads pick them up on their next frame to start flying and
# broadcasting nav-telemetry. The dict is shared across threads — the WS thread
# writes it (via the registered mission handler) while six producer threads read
# it every frame — so all access is guarded by _nav_lock.
_navigators = {}
_last_gps_by_drone = {}
_nav_lock = threading.Lock()


def _plan_key_to_drone_id(plan_key) -> str:
    """coverage_planner emits 'drone_1'..'drone_6'; config uses 'DRONE_1'..
    Tolerates non-string keys (a hostile plan) by stringifying first."""
    return str(plan_key).upper()


def _coerce_waypoints(waypoints):
    """Validate/normalise one drone's route into ``[(float, float), ...]``.

    Returns the route (possibly empty — surplus drones legitimately get []), or
    None if the value isn't a clean list of 2-number vertices. Lets inject_mission
    skip a malformed drone instead of letting WaypointNavigator's unpacking raise
    deep on the WS thread (a drawn polygon can deliver almost anything via JSON).
    """
    if not isinstance(waypoints, (list, tuple)):
        return None
    route = []
    for vertex in waypoints:
        if not isinstance(vertex, (list, tuple)) or len(vertex) != 2:
            return None
        try:
            x, y = float(vertex[0]), float(vertex[1])
        except (TypeError, ValueError):
            return None
        if not math.isfinite(x) or not math.isfinite(y):
            return None
        route.append((x, y))
    return route


def _hover_gps(drone_id):
    """Fixed pre-mission GPS so drones hold position until START_MISSION."""
    pattern = config.DRONE_PATTERNS[drone_id]
    lng = round(config.BASE_LON + pattern["lon_amp"], 6)
    lat = round(config.BASE_LAT, 6)
    return {"lat": lat, "lng": lng, "lon": lng, "alt": 75.0, "coverage_active": False}


def _gps_point(gps):
    if not gps:
        return None
    lng = gps.get("lng", gps.get("lon"))
    lat = gps.get("lat")
    if lng is None or lat is None:
        return None
    lng, lat = float(lng), float(lat)
    if not math.isfinite(lng) or not math.isfinite(lat):
        return None
    return (lng, lat)


def _current_route_start(drone_id):
    return _gps_point(_last_gps_by_drone.get(drone_id)) or _gps_point(_hover_gps(drone_id))


def _looks_like_lnglat_route(route):
    if not route:
        return False
    xs = [pt[0] for pt in route]
    ys = [pt[1] for pt in route]
    if not all(-180 <= x <= 180 for x in xs) or not all(-90 <= y <= 90 for y in ys):
        return False
    if max(max(xs) - min(xs), max(ys) - min(ys)) > 1.0:
        return False
    return any(abs(x) > 90 for x in xs) or any(abs(y) > 10 for y in ys)


def _route_with_transit_start(drone_id, route):
    """Prepend the drone's current map position so deploy never teleports."""
    if not route:
        return route, 0, 0
    if not _looks_like_lnglat_route(route):
        return route, 0, len(route)
    current = _current_route_start(drone_id)
    if current is None:
        return route, 0, len(route)
    first = route[0]
    distance = math.hypot(first[0] - current[0], first[1] - current[1])
    if distance <= 1e-12:
        return route, 0, len(route)
    return [current] + route, 1, len(route)


def _attach_mission_progress(nav, coverage_start_index, mission_waypoint_count):
    nav.coverage_start_index = int(coverage_start_index)
    nav.mission_waypoint_count = int(mission_waypoint_count)
    nav.coverage_speed = nav.speed


def _set_nav_phase_speed(nav):
    if int(getattr(nav, "coverage_start_index", 0)) > 0:
        if nav.current_waypoint_idx <= int(getattr(nav, "coverage_start_index", 0)):
            nav.speed = config.NAV_GEO_TRANSIT_SPEED_DEG_S
        else:
            nav.speed = getattr(nav, "coverage_speed", nav.speed)


def inject_mission(plan) -> int:
    """Mission handler (registered with websocket_server.set_mission_handler).

    Given a coverage plan ``{"drone_1": [(x, y), ...], ...}``, install or refresh
    a WaypointNavigator per drone and *unpause* it, so the running producer
    threads immediately begin flying their assigned boustrophedon routes and
    broadcasting movement to the dashboard. Returns the number of drones armed.

    Runs on the WebSocket thread; the navigator dict is lock-guarded because the
    producer threads read it every frame. Defensive throughout: a non-dict plan,
    unknown drone keys, and malformed routes are skipped (never raised) so a
    hostile or garbled frame can't take a thread down — the router swallows
    handler exceptions too, but routine bad input is handled here, not relied on.
    """
    if not isinstance(plan, dict):
        print(f"[producer] Mission plan ignored -- not a dict: {type(plan).__name__}.")
        return 0

    activated = 0
    with _nav_lock:
        for plan_key, waypoints in plan.items():
            drone_id = _plan_key_to_drone_id(plan_key)
            if drone_id not in stop_events:
                print(f"[producer] Mission plan: ignoring unknown drone {plan_key!r}.")
                continue
            route = _coerce_waypoints(waypoints)
            if route is None:
                print(f"[producer] Mission plan: bad route for {plan_key!r}, skipped.")
                continue
            nav_route, coverage_start_index, mission_waypoint_count = _route_with_transit_start(
                drone_id, route
            )
            nav = _navigators.get(drone_id)
            if nav is None:
                nav = WaypointNavigator(nav_route)
                _navigators[drone_id] = nav
            else:
                nav.set_waypoints(nav_route)  # re-deploy onto a new polygon
            _attach_mission_progress(nav, coverage_start_index, mission_waypoint_count)
            nav.activate()
            activated += 1
    print(f"[producer] START_MISSION injected -- {activated} drone(s) navigating.")
    return activated


def get_navigator(drone_id):
    """Thread-safe read of a drone's active navigator (None if not deployed)."""
    with _nav_lock:
        return _navigators.get(drone_id)


def reset_navigators():
    """Clear all navigators (re-paused, idle state). Used by main() on startup
    and by tests to isolate the shared registry between runs."""
    with _nav_lock:
        _navigators.clear()
        _last_gps_by_drone.clear()

# Foundry telemetry is enqueued at most this often per drone (the dataset is a
# 5s-cadence state log, not a per-frame firehose). Detections are enqueued as
# they fire. The background flush thread batches and commits them — see
# foundry_client and .claude/foundary-task.md.
TELEMETRY_WRITE_INTERVAL_S = 5.0


def encode_frame_b64(frame, width=None, quality=None):
    """Downscale and JPEG-encode a frame to a base64 string for packet.frame_b64.

    Returns None when streaming is disabled (width 0) or encoding fails, so the
    dashboard cleanly falls back to its NO-SIGNAL placeholder.
    """
    width = config.VIDEO_STREAM_WIDTH if width is None else width
    quality = config.VIDEO_JPEG_QUALITY if quality is None else quality
    if not width:
        return None

    h, w = frame.shape[:2]
    if w > width:
        scaled_h = max(1, round(h * width / w))
        frame = cv2.resize(frame, (width, scaled_h), interpolation=cv2.INTER_AREA)

    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        return None
    return base64.b64encode(buf).decode("ascii")


def _build_signal_lost_packet(drone_id, frame_idx, frame_b64):
    """A terminal packet that forces the drone into the SIGNAL LOST / CRITICAL
    state. The last frame is reused so the dashboard shows the frozen image
    under its greyed-out SIGNAL LOST overlay rather than going blank.
    """
    packet = build_packet(drone_id, frame_idx, detections=[], frame_b64=frame_b64)
    packet.health["signal"] = "LOST"
    packet.health["status"] = "CRITICAL"
    return packet


def _mission_telemetry(nav, telemetry):
    """Translate navigator route progress into mission-only coverage progress."""
    if not telemetry:
        return None
    coverage_start_index = int(getattr(nav, "coverage_start_index", 0))
    mission_waypoint_count = int(
        getattr(nav, "mission_waypoint_count", len(getattr(nav, "waypoints", [])))
    )
    reached = int(telemetry.get("current_waypoint_idx", 0))
    done = max(0, min(mission_waypoint_count, reached - coverage_start_index))
    remaining = max(0, mission_waypoint_count - done)
    result = dict(telemetry)
    result["current_waypoint_idx"] = done
    result["waypoints_remaining"] = remaining
    result["mission_complete"] = remaining == 0
    result["coverage_active"] = done > 0
    return result


def _gps_from_nav_telemetry(telemetry):
    """Convert navigator route coordinates into the Mapbox GPS packet shape.

    The planner now consumes Mapbox Draw polygons, so navigator ``x`` is lng and
    ``y`` is lat for deployed missions. Keep ``lon`` as a compatibility alias.
    """
    if not telemetry:
        return None
    total = int(telemetry.get("current_waypoint_idx", 0)) + int(
        telemetry.get("waypoints_remaining", 0)
    )
    if total <= 0:
        return None
    lng = float(telemetry["x"])
    lat = float(telemetry["y"])
    if not math.isfinite(lng) or not math.isfinite(lat):
        return None
    return {
        "lat": lat,
        "lng": lng,
        "lon": lng,
        "alt": 75.0,
        "coverage_active": telemetry.get("coverage_active", True),
    }


def _remember_gps(drone_id, gps):
    point = _gps_point(gps)
    if point is None:
        return
    lng, lat = point
    with _nav_lock:
        _last_gps_by_drone[drone_id] = {
            "lat": lat,
            "lng": lng,
            "lon": lng,
            "alt": gps.get("alt", 75.0),
            "coverage_active": gps.get("coverage_active", False),
        }


def drone_producer(drone_id, video_path, sender, start_offset=0):
    model = load_model()
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_delay = 1.0 / fps
    frame_idx = 0
    last_frame_b64 = None
    last_write = 0.0  # last Foundry telemetry write time for this drone

    if start_offset > 0:
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_offset)

    stop = stop_events[drone_id]
    detections = []  # reused on the frames between detection runs (see stride below)
    nav_last_t = time.time()  # wall-clock of the previous nav tick (real-time dt)
    while not stop.is_set():
        t_start = time.time()
        ret, frame = cap.read()
        if not ret:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # loop video
            continue

        # Detect on a frame stride, not every frame: six CPU YOLO streams can't
        # infer every frame in real time (review finding #8). Video still streams
        # every frame; detections carry over from the last run in between.
        ran_detection = frame_idx % config.DETECT_EVERY_N == 0
        if ran_detection:
            detections = run_detection(model, frame)
        # --- Deploy Swarm: fly this drone's assigned route, if one is active.
        # Movement integrates against real wall-clock dt (the loop runs below
        # real-time on CPU, so frame_delay would understate it). When active, the
        # navigator's lng/lat route position overrides the synthetic GPS in the
        # main packet, so Mapbox markers/coverage follow the deployed mission.
        nav = get_navigator(drone_id)
        now = time.time()
        nav_telemetry = None
        gps_override = _hover_gps(drone_id)
        if nav is not None and nav.active:
            _set_nav_phase_speed(nav)
            nav_telemetry = _mission_telemetry(nav, nav.tick(now - nav_last_t))
            gps_override = _gps_from_nav_telemetry(nav_telemetry) or gps_override
        nav_last_t = now

        frame_b64 = encode_frame_b64(frame)
        last_frame_b64 = frame_b64
        packet = build_packet(
            drone_id,
            frame_idx,
            detections,
            frame_b64=frame_b64,
            gps_override=gps_override,
        )
        _remember_gps(drone_id, packet.gps)
        sender.send(packet)

        # --- ADDITIVE: real Foundry dataset writes, off the WebSocket hot path.
        # Reuse the gps/health/mission already on `packet` (no recompute). write_*
        # only buffer a row in memory; the background flush thread batches them and
        # does open→upload→commit, so the per-frame WebSocket send above is never
        # blocked. Gated on the sender's foundry_enabled flag (FOUNDRY_ENABLED) so
        # the secondary sink is a real opt-in and a normal local run is untouched.
        if getattr(sender, "foundry_enabled", False):
            now = time.time()
            if now - last_write >= TELEMETRY_WRITE_INTERVAL_S:
                last_write = now
                write_telemetry(make_telemetry_row(
                    drone_id, packet.timestamp, packet.gps, packet.health,
                    packet.mission))
            # Enqueue detection rows only on frames where YOLO actually ran, so a
            # detection carried over between stride frames isn't re-written each frame.
            if ran_detection and detections:
                for det in detections:
                    write_detection(make_detection_row(
                        drone_id, packet.timestamp, det["confidence"], packet.gps))

        # The nav packet is a separate, gps-less wire format the dashboard routes
        # to its waypoint progress stat. It's broadcast on a stride so it doesn't
        # crowd the video frames on the primary WebSocket path.
        if nav_telemetry is not None:
            if frame_idx % config.NAV_BROADCAST_EVERY_N == 0:
                sender.send(make_nav_packet(drone_id, nav_telemetry))

        frame_idx += 1
        elapsed = time.time() - t_start
        time.sleep(max(0, frame_delay - elapsed))  # maintain real-time FPS

    cap.release()
    # Killing the thread is the demo's signal-lost trigger (README §9 Event 1).
    # The dashboard has no staleness timeout, so without a terminal packet the
    # tile/health/map would freeze on the last ONLINE state and never turn red.
    # Emit one final SIGNAL LOST / CRITICAL packet so the kill is reflected.
    sender.send(_build_signal_lost_packet(drone_id, frame_idx, last_frame_b64))
    print(f"[{drone_id}] producer stopped — emitted SIGNAL LOST.")


def launch_producers(sender):
    """Start all six producer threads. Returns the list of started threads."""
    # Start the Foundry batch-flush thread once, only when the sink is enabled.
    if getattr(sender, "foundry_enabled", False):
        start_foundry_flusher()
    threads = []
    for drone_id, path in config.VIDEO_PATHS.items():
        t = threading.Thread(
            target=drone_producer,
            args=(drone_id, path, sender, config.START_OFFSETS[drone_id]),
            daemon=True,
            name=drone_id,
        )
        threads.append(t)
        t.start()
    return threads
