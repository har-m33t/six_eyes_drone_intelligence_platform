"""DronePacket dataclass and packet builder.

The packet is the single wire format sent identically to both sinks
(WebSocket + Foundry) via dataclasses.asdict() -> JSON.
"""
import time
from dataclasses import dataclass, field

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


def build_packet(drone_id: str, frame_idx: int, detections: list) -> DronePacket:
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
    )
