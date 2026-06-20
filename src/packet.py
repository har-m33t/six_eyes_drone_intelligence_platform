"""DronePacket dataclass and packet builder.

The packet is the single wire format sent identically to both sinks
(WebSocket + Foundry) via dataclasses.asdict() -> JSON.
"""
import time
import uuid
from dataclasses import asdict, dataclass, field

from . import config
from .simulators import simulate_gps, simulate_health


@dataclass
class DronePacket:
    drone_id: str            # "DRONE_1" through "DRONE_6"
    timestamp: float         # Unix timestamp (time.time())
    frame_idx: int           # Frame number since mission start (video sync)
    detections: list         # List of {class, confidence, bbox} dicts
    gps: dict                # {lat, lon, alt}
    health: dict             # {battery, signal, status, speed_ms, temp_c}
    mission: dict = field(default_factory=dict)  # {zone, coverage_pct, elapsed_s}
    frame_b64: str = None     # base64 JPEG of the frame (dashboard video); WS-only


def build_packet(drone_id: str, frame_idx: int, detections: list,
                 frame_b64: str = None) -> DronePacket:
    elapsed = time.time() - config.MISSION_START
    return DronePacket(
        drone_id=drone_id,
        timestamp=time.time(),
        frame_idx=frame_idx,
        detections=detections,
        gps=simulate_gps(drone_id),
        health=simulate_health(drone_id, frame_idx),
        mission={
            "zone": config.assign_zone(drone_id),
            "coverage_pct": min(100, round(elapsed / 120 * 100, 1)),
            "elapsed_s": round(elapsed, 1),
        },
        frame_b64=frame_b64,
    )


# --- Navigation telemetry ---------------------------------------------------
# A second, lightweight wire packet broadcast once a drone is flying its Deploy
# Swarm route (Task 3). It is intentionally distinct from DronePacket: it carries
# raw SIM_WORLD (x, y) sweep coordinates + waypoint progress and NO gps/health/
# detections. The dashboard routes on exactly that shape — see isNavTelemetry()
# in six_eyes_dashboard.html (keys on `current_waypoint_idx` / x+y without gps) —
# to paint the coverage footprint and the live "% SEARCHED" stat. Same asdict()
# -> JSON broadcast path as DronePacket, so the transport is untouched.

@dataclass
class NavTelemetry:
    drone_id: str            # "DRONE_1" through "DRONE_6"
    timestamp: float         # Unix timestamp (time.time())
    x: float                 # SIM_WORLD x of the drone along its sweep
    y: float                 # SIM_WORLD y of the drone along its sweep
    current_waypoint_idx: int   # waypoints reached so far
    waypoints_remaining: int    # waypoints still ahead on this route
    mission_complete: bool      # whole assigned route flown


def make_nav_packet(drone_id: str, telemetry: dict) -> NavTelemetry:
    """Stamp a navigator's drone-agnostic telemetry dict with identity/time."""
    return NavTelemetry(
        drone_id=drone_id,
        timestamp=time.time(),
        x=telemetry["x"],
        y=telemetry["y"],
        current_waypoint_idx=telemetry["current_waypoint_idx"],
        waypoints_remaining=telemetry["waypoints_remaining"],
        mission_complete=telemetry["mission_complete"],
    )


# --- Foundry rows -----------------------------------------------------------
# Flat, column-shaped rows for the two real Foundry datasets (see
# .claude/foundary-task.md). These are ADDITIVE and independent of DronePacket
# (the WebSocket wire format) — built from the same gps/health/mission data the
# packet already carries, so nothing is recomputed.

@dataclass
class TelemetryRow:
    drone_id: str
    timestamp: float
    lat: float
    lon: float
    alt: float
    battery: float
    signal: str
    status: str
    speed_ms: float
    zone: str
    coverage_pct: float


@dataclass
class DetectionRow:
    detection_id: str   # uuid4 string
    drone_id: str
    timestamp: float
    confidence: float
    lat: float
    lon: float


def make_telemetry_row(drone_id: str, timestamp: float, gps: dict,
                       health: dict, mission: dict) -> dict:
    """Build a flat telemetry row (plain dict) from data already on the packet."""
    return asdict(TelemetryRow(
        drone_id=drone_id,
        timestamp=timestamp,
        lat=gps["lat"],
        lon=gps["lon"],
        alt=gps["alt"],
        battery=health["battery"],
        signal=health["signal"],
        status=health["status"],
        speed_ms=health["speed_ms"],
        zone=mission["zone"],
        coverage_pct=mission["coverage_pct"],
    ))


def make_detection_row(drone_id: str, timestamp: float, confidence: float,
                       gps: dict) -> dict:
    """Build a flat detection row (plain dict) with a fresh uuid4 detection_id."""
    return asdict(DetectionRow(
        detection_id=str(uuid.uuid4()),
        drone_id=drone_id,
        timestamp=timestamp,
        confidence=confidence,
        lat=gps["lat"],
        lon=gps["lon"],
    ))
