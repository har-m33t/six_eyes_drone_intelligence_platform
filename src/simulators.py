"""GPS and health simulators. All time-derived values reference the shared
config.MISSION_START so the six feeds stay synchronized.
"""
import math
import random
import time

from . import config


def simulate_gps(drone_id: str) -> dict:
    elapsed = time.time() - config.MISSION_START
    p = config.DRONE_PATTERNS[drone_id]
    lat = round(config.BASE_LAT + p["lat_amp"] * math.sin(elapsed * p["lat_freq"]), 6)
    lng = round(config.BASE_LON + p["lon_amp"] * math.cos(elapsed * p["lon_freq"]), 6)
    return {
        "lat": lat,
        "lng": lng,
        "lon": lng,  # backwards-compatible alias for older dashboard/tests
        "alt": round(75 + random.uniform(-5, 5), 1),
    }


def simulate_health(drone_id: str, frame_idx: int) -> dict:
    elapsed = time.time() - config.MISSION_START
    battery = max(0, min(100, round(100 - (elapsed / 60) * 5 + random.uniform(-1, 1), 1)))

    if battery < 10:
        signal = "LOST"
        status = "CRITICAL"
    elif battery < 20:
        signal = random.choice(["WEAK", "WEAK", "STRONG"])
        status = "WARNING"
    else:
        signal = random.choice(["STRONG", "STRONG", "STRONG", "WEAK"])
        status = "ONLINE"

    return {
        "battery": battery,
        "signal": signal,
        "status": status,
        "speed_ms": round(random.uniform(8, 18), 1),
        "temp_c": round(random.uniform(35, 55), 1),
    }
