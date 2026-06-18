"""Central configuration: drone maps, GPS patterns, transport + Foundry settings.

Prefer editing constants here over hardcoding in producer/simulator code.
"""
import os
import time

from dotenv import load_dotenv

load_dotenv()

# Shared mission clock — set once at import, referenced by all producer threads
# and simulators so the six feeds stay time-synchronized.
MISSION_START = time.time()

# --- Drone identity ---------------------------------------------------------
DRONE_IDS = [f"DRONE_{i}" for i in range(1, 7)]

ZONES = {
    "DRONE_1": "ALPHA",   "DRONE_2": "BRAVO",
    "DRONE_3": "CHARLIE", "DRONE_4": "DELTA",
    "DRONE_5": "ECHO",    "DRONE_6": "FOXTROT",
}

VIDEO_PATHS = {
    "DRONE_1": "footage/drone_1.mp4",
    "DRONE_2": "footage/drone_2.mp4",
    "DRONE_3": "footage/drone_1.mp4",  # reused, desynced via START_OFFSETS
    "DRONE_4": "footage/drone_2.mp4",  # reused, desynced via START_OFFSETS
    "DRONE_5": "footage/drone_3.mp4",
    "DRONE_6": "footage/drone_2.mp4",  # reused, desynced via START_OFFSETS
}

# Per-drone video start frame — makes the six feeds look genuinely independent.
# Each offset must stay below the frame count of that drone's assigned clip, and
# drones sharing a clip must use distinct offsets, or the desync is lost (the
# producer seeks past EOF, gets no frame, and loops back to 0 — see test_footage).
# Current clips: drone_1.mp4=460f, drone_2.mp4=298f, drone_3.mp4=552f.
START_OFFSETS = {
    "DRONE_1": 0,    # drone_1.mp4 (460f)
    "DRONE_2": 60,   # drone_2.mp4 (298f)
    "DRONE_3": 230,  # drone_1.mp4 — desynced from DRONE_1
    "DRONE_4": 140,  # drone_2.mp4 — desynced from DRONE_2/DRONE_6
    "DRONE_5": 250,  # drone_3.mp4 (552f)
    "DRONE_6": 220,  # drone_2.mp4 — desynced from DRONE_2/DRONE_4
}

# --- GPS simulation ---------------------------------------------------------
BASE_LAT = 34.0522
BASE_LON = -118.2437

DRONE_PATTERNS = {
    "DRONE_1": {"lat_amp": 0.003, "lon_amp": 0.002, "lat_freq": 0.08, "lon_freq": 0.05},
    "DRONE_2": {"lat_amp": -0.002, "lon_amp": 0.003, "lat_freq": 0.06, "lon_freq": 0.09},
    "DRONE_3": {"lat_amp": 0.004, "lon_amp": -0.002, "lat_freq": 0.10, "lon_freq": 0.07},
    "DRONE_4": {"lat_amp": -0.003, "lon_amp": -0.003, "lat_freq": 0.07, "lon_freq": 0.06},
    "DRONE_5": {"lat_amp": 0.002, "lon_amp": 0.004, "lat_freq": 0.09, "lon_freq": 0.08},
    "DRONE_6": {"lat_amp": -0.004, "lon_amp": 0.001, "lat_freq": 0.05, "lon_freq": 0.10},
}

# --- Inference --------------------------------------------------------------
YOLO_MODEL = os.getenv("YOLO_MODEL", "yolov8n.pt")
PERSON_CLASS_ID = 0  # COCO class 0 = person

# --- Transport (WebSocket primary) ------------------------------------------
WS_HOST = os.getenv("WS_HOST", "localhost")
WS_PORT = int(os.getenv("WS_PORT", "8765"))

# --- Transport (Foundry REST secondary) -------------------------------------
FOUNDRY_URL = os.getenv("FOUNDRY_URL", "")
FOUNDRY_TOKEN = os.getenv("FOUNDRY_TOKEN", "")
DATASET_RID = os.getenv("DATASET_RID", "")
FOUNDRY_ENABLED = os.getenv("FOUNDRY_ENABLED", "true").lower() == "true"

# --- Mission ----------------------------------------------------------------
MISSION_DURATION_S = int(os.getenv("MISSION_DURATION_S", "600"))


def assign_zone(drone_id: str) -> str:
    return ZONES.get(drone_id, "UNKNOWN")
