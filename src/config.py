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

# Inference resolution. YOLO scales detections back to full-frame coordinates,
# so this only trades accuracy for speed, not bbox placement. 416 is the floor
# that still reliably detects people on the footage (320 missed everyone in
# benchmarking) while running ~1.8x faster than the 640 default — the lever that
# lets six CPU-bound feeds approach real-time (review finding #8).
YOLO_IMGSZ = int(os.getenv("YOLO_IMGSZ", "416"))

# Run YOLO every Nth frame per drone and reuse the last result on the frames in
# between; video still streams every frame. Six CPU YOLO streams can't infer
# every frame in real time, so this is the main throughput lever — at 25 fps a
# stride of 4 refreshes detections ~6x/s, imperceptible for the demo. Set to 1
# to detect every frame (slow-motion playback on CPU).
DETECT_EVERY_N = int(os.getenv("DETECT_EVERY_N", "4"))

# --- Video streaming --------------------------------------------------------
# Each frame is downscaled and JPEG-encoded to base64 (packet.frame_b64) for the
# dashboard video grid. Frames are kept small so the primary WebSocket path stays
# under its <100ms latency budget with six feeds in flight; the dashboard tiles
# are small (2x3 grid, object-fit: cover) so full resolution is wasted bytes.
# Set VIDEO_STREAM_WIDTH=0 to disable encoding (telemetry-only, no live video).
VIDEO_STREAM_WIDTH = int(os.getenv("VIDEO_STREAM_WIDTH", "640"))
VIDEO_JPEG_QUALITY = int(os.getenv("VIDEO_JPEG_QUALITY", "70"))

# --- Transport (WebSocket primary) ------------------------------------------
WS_HOST = os.getenv("WS_HOST", "localhost")
WS_PORT = int(os.getenv("WS_PORT", "8765"))

# --- Dashboard ---------------------------------------------------------------
# Mapbox GL JS runs in the browser, so the token must be delivered at runtime by
# the local dashboard server rather than hardcoded into six_eyes_dashboard.html.
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")
DASHBOARD_HOST = os.getenv("DASHBOARD_HOST", "localhost")
DASHBOARD_PORT = int(os.getenv("DASHBOARD_PORT", "8000"))
DASHBOARD_WS_URL = os.getenv("DASHBOARD_WS_URL", "")

# --- Transport (Foundry REST secondary) -------------------------------------
FOUNDRY_URL = os.getenv("FOUNDRY_URL", "")
FOUNDRY_TOKEN = os.getenv("FOUNDRY_TOKEN", "")
DATASET_RID = os.getenv("DATASET_RID", "")
FOUNDRY_ENABLED = os.getenv("FOUNDRY_ENABLED", "true").lower() == "true"

# --- Navigation (Deploy Swarm — Task 3) -------------------------------------
# When the operator deploys a search polygon, each producer thread flies its
# assigned boustrophedon route via WaypointNavigator. Speed is in SIM_WORLD
# units/second (the planner's (x, y) space; the dashboard maps 0..1000 onto the
# coverage canvas) and tick(dt) integrates against real wall-clock dt, so motion
# is frame-rate independent. Tuned so a swept route is visibly traversed in-demo.
NAV_SPEED_UNITS_S = float(os.getenv("NAV_SPEED_UNITS_S", "40"))
# Small Mapbox routes use real-world lng/lat degrees instead of SIM_WORLD units.
# navigation.py auto-scales those default-speed routes to this visible demo time
# so a city-scale polygon does not complete in a single producer tick.
NAV_GEO_ROUTE_DURATION_S = float(os.getenv("NAV_GEO_ROUTE_DURATION_S", "45"))
# A drone is ticked every frame, but nav-telemetry is broadcast only every Nth
# frame to keep the primary WebSocket path light (six feeds plus their video
# already share it). ~8-10 Hz/drone is smooth motion on the map.
NAV_BROADCAST_EVERY_N = int(os.getenv("NAV_BROADCAST_EVERY_N", "3"))

# --- Mission ----------------------------------------------------------------
MISSION_DURATION_S = int(os.getenv("MISSION_DURATION_S", "600"))


def assign_zone(drone_id: str) -> str:
    return ZONES.get(drone_id, "UNKNOWN")
