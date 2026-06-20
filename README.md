# SIX-EYES — Drone Fleet Intelligence Dashboard (Palanitr Build Challenge)
## Project Specification v1.0
 
---
 
## 1. Project Overview
 
SIX-EYES is an end-to-end drone swarm intelligence dashboard built on Palantir Foundry and AIP. It simulates a real-time search and rescue operation commanded by a military drone operator, where six drones simultaneously stream telemetry, video, and computer vision data into a unified operational dashboard. An AIP agent continuously monitors all six feeds and delivers concise situational intelligence to the operator.
 
### Problem Statement
Military and emergency search and rescue operators managing drone swarms face information overload. Six drones simultaneously transmitting GPS, health, and video data — with CV detections firing independently across all feeds — creates more events than a human can process manually. Operators miss critical signals: a drone losing connection, a person detected in a far corner of the grid, battery reaching critical levels.
 
### Solution
SIX-EYES aggregates all telemetry into a single dashboard and delegates the monitoring and synthesis task to an AIP intelligence agent, which generates continuous situational updates. The operator shifts from watching six screens to reacting to one intelligently distilled feed.
 
### Target Users
Military drone operators and search and rescue commanders managing multi-drone swarm operations.
 
### Operational Decisions the System Informs
- Which drone to redirect when another loses signal
- Which zone to prioritize when a person is detected
- When to recall a drone for battery swap
- What happened in the last 30 seconds across all six feeds
---
 
## 2. System Architecture
 
### Architecture Overview
 
```
[Pre-recorded MP4 files x6]
         |
         v
[Producer Process — 6 Python threads]
    |- OpenCV frame reader (real-time FPS)
    |- YOLOv8n ONNX inference (person detection)
    |- Packet builder (7-field telemetry)
    |- Shared mission clock (MISSION_START sync)
         |
         |-- PRIMARY (solid) -----> [WebSocket Server ws://localhost:8765]
         |                                   |
         |                                   v
         |                        [Web Dashboard — Foundry Slate]
         |                            |- 6-feed video grid
         |                            |- GPS map (lat/lon traces)
         |                            |- Drone health panel
         |                            |- AI agent status strip  <---+
         |                                                           |
         |-- SECONDARY (async) --> [Foundry REST API]               |
                                        |                           |
                                        v                           |
                                  [Foundry Datasets]                |
                                        |                           |
                                        v                           |
                                  [Transform Pipeline]              |
                                        |                           |
                                        v                           |
                                  [AIP Agent] ----------------------+
                                  (every 30s + event-driven)
```
 
### Data Flow Summary
1. Six MP4 files play back at native FPS, treated as live drone feeds
2. Each frame is processed by YOLOv8n ONNX — bounding boxes extracted for persons
3. Detections are merged with simulated GPS and health data into a DronePacket
4. Each packet is sent to two sinks simultaneously:
   - WebSocket server (primary, low-latency, drives live dashboard)
   - Foundry REST API (secondary, async, persists for AIP agent context)
5. The Foundry Slate dashboard receives WebSocket packets and renders video, map, and health panels
6. The AIP agent reads the Foundry dataset every 30 seconds (and immediately on alert events) and generates a 2-3 sentence situational update
7. The update appears in the AI agent strip at the bottom of the dashboard
---
 
## 3. Technology Stack
 
| Layer | Technology | Reason |
|---|---|---|
| Language | Python 3.11+ | Threading, async, ecosystem |
| Video processing | OpenCV (cv2) | Frame-by-frame read, FPS pacing |
| CV inference | YOLOv8n via Ultralytics | Fast, accurate, ONNX-exportable |
| Model format | ONNX Runtime | Framework-agnostic inference |
| Transport (primary) | WebSocket (asyncio + websockets library) | Push-based, low latency, no polling |
| Transport (secondary) | HTTP REST (requests library) | Foundry dataset ingestion |
| Dashboard | Foundry Slate | Native Palantir, dataset-bindable |
| Data persistence | Palantir Foundry Datasets | Structured telemetry storage |
| Transform pipeline | Foundry Pipeline Builder | Alert rules, aggregations |
| Intelligence agent | Palantir AIP (AIP Studio) | Native LLM agent on Foundry data |
| Footage source | Pexels / Pixabay aerial clips | Free, no license issues |
 
---
 
## 4. Component Specifications
 
### 4.1 Pre-recorded Drone Footage (Data Source)
 
- Six MP4 video files representing one drone feed each
- Target resolution: 1280x720 (720p)
- Target FPS: 24 or 30
- Codec: H.264 / MP4 container (OpenCV reads natively)
- Minimum duration: 60 seconds per clip (loops continuously)
- Content: aerial footage showing open terrain, ideally with human movement visible
- Sourcing: Pexels.com or Pixabay.com aerial drone clips (free, no license restrictions for demos)
- Can reuse 2-3 clips across 6 drones with staggered start offsets to appear distinct
File naming convention:
```
footage/
  drone_1.mp4
  drone_2.mp4
  drone_3.mp4
  drone_4.mp4
  drone_5.mp4
  drone_6.mp4
```
 
### 4.2 Producer Process
 
One Python thread per drone. Each thread runs independently and continuously until the mission is ended.
 
#### OpenCV Frame Reader
```python
cap = cv2.VideoCapture(video_path)
fps = cap.get(cv2.CAP_PROP_FPS)
frame_delay = 1.0 / fps
 
# Optional: stagger start position per drone
cap.set(cv2.CAP_PROP_POS_FRAMES, start_offset)
 
while True:
    t_start = time.time()
    ret, frame = cap.read()
    if not ret:
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # loop video
        continue
 
    # ... process frame ...
 
    elapsed = time.time() - t_start
    time.sleep(max(0, frame_delay - elapsed))  # maintain real-time FPS
```
 
#### YOLOv8n ONNX Inference
```python
from ultralytics import YOLO
 
model = YOLO("yolov8n.pt")  # loads once at thread start
 
def run_detection(frame):
    results = model(frame, verbose=False)
    detections = []
    for box in results[0].boxes:
        if int(box.cls) == 0:  # class 0 = person
            detections.append({
                "class": "person",
                "confidence": round(float(box.conf), 3),
                "bbox": [int(x) for x in box.xyxy[0].tolist()]  # [x1, y1, x2, y2]
            })
    return detections
```
 
Model selection rationale: YOLOv8n (nano) chosen for inference speed across 6 parallel threads. In production, YOLOv8s or YOLOv8m would be preferred for higher recall — missing a person in a search and rescue context is a high-cost error.
 
#### GPS Simulator
```python
import math, time
 
MISSION_START = time.time()  # shared across all threads
 
DRONE_PATTERNS = {
    "DRONE_1": {"lat_amp": 0.003, "lon_amp": 0.002, "lat_freq": 0.08, "lon_freq": 0.05},
    "DRONE_2": {"lat_amp": -0.002, "lon_amp": 0.003, "lat_freq": 0.06, "lon_freq": 0.09},
    "DRONE_3": {"lat_amp": 0.004, "lon_amp": -0.002, "lat_freq": 0.10, "lon_freq": 0.07},
    "DRONE_4": {"lat_amp": -0.003, "lon_amp": -0.003, "lat_freq": 0.07, "lon_freq": 0.06},
    "DRONE_5": {"lat_amp": 0.002, "lon_amp": 0.004, "lat_freq": 0.09, "lon_freq": 0.08},
    "DRONE_6": {"lat_amp": -0.004, "lon_amp": 0.001, "lat_freq": 0.05, "lon_freq": 0.10},
}
 
BASE_LAT = 34.0522
BASE_LON = -118.2437
 
def simulate_gps(drone_id):
    elapsed = time.time() - MISSION_START
    p = DRONE_PATTERNS[drone_id]
    return {
        "lat": round(BASE_LAT + p["lat_amp"] * math.sin(elapsed * p["lat_freq"]), 6),
        "lon": round(BASE_LON + p["lon_amp"] * math.cos(elapsed * p["lon_freq"]), 6),
        "alt": round(75 + random.uniform(-5, 5), 1)
    }
```
 
#### Health Simulator
```python
def simulate_health(drone_id, frame_idx):
    elapsed = time.time() - MISSION_START
    battery = max(0, round(100 - (elapsed / 60) * 5 + random.uniform(-1, 1), 1))
 
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
        "temp_c": round(random.uniform(35, 55), 1)
    }
```
 
#### DronePacket Dataclass
```python
from dataclasses import dataclass, asdict
 
@dataclass
class DronePacket:
    drone_id: str           # "DRONE_1" through "DRONE_6"
    timestamp: float        # Unix timestamp (time.time())
    frame_idx: int          # Frame number since mission start (for video sync)
    detections: list        # List of {class, confidence, bbox} dicts
    gps: dict               # {lat, lon, alt}
    health: dict            # {battery, signal, status, speed_ms, temp_c}
    mission: dict           # {zone, coverage_pct, elapsed_s}
 
def build_packet(drone_id, frame_idx, detections):
    elapsed = time.time() - MISSION_START
    return DronePacket(
        drone_id=drone_id,
        timestamp=time.time(),
        frame_idx=frame_idx,
        detections=detections,
        gps=simulate_gps(drone_id),
        health=simulate_health(drone_id, frame_idx),
        mission={
            "zone": assign_zone(drone_id),
            "coverage_pct": min(100, round(elapsed / 120 * 100, 1)),
            "elapsed_s": round(elapsed, 1)
        }
    )
```
 
#### Zone Assignment
```python
ZONES = {
    "DRONE_1": "ALPHA",   "DRONE_2": "BRAVO",
    "DRONE_3": "CHARLIE", "DRONE_4": "DELTA",
    "DRONE_5": "ECHO",    "DRONE_6": "FOXTROT"
}
 
def assign_zone(drone_id):
    return ZONES.get(drone_id, "UNKNOWN")
```
 
#### Full Producer Thread
```python
import threading
 
def drone_producer(drone_id, video_path, sender, start_offset=0):
    model = YOLO("yolov8n.pt")
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_delay = 1.0 / fps
    frame_idx = 0
 
    if start_offset > 0:
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_offset)
 
    while True:
        t_start = time.time()
        ret, frame = cap.read()
        if not ret:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            continue
 
        detections = run_detection(model, frame)
        packet = build_packet(drone_id, frame_idx, detections)
        sender.send(packet)
 
        frame_idx += 1
        elapsed = time.time() - t_start
        time.sleep(max(0, frame_delay - elapsed))
 
    cap.release()
 
# Launch all 6 threads
VIDEO_PATHS = {
    "DRONE_1": "footage/drone_1.mp4",
    "DRONE_2": "footage/drone_2.mp4",
    "DRONE_3": "footage/drone_3.mp4",
    "DRONE_4": "footage/drone_4.mp4",
    "DRONE_5": "footage/drone_5.mp4",
    "DRONE_6": "footage/drone_6.mp4",
}
 
START_OFFSETS = {
    "DRONE_1": 0,   "DRONE_2": 150, "DRONE_3": 300,
    "DRONE_4": 450, "DRONE_5": 600, "DRONE_6": 720
}
 
threads = []
for drone_id, path in VIDEO_PATHS.items():
    t = threading.Thread(
        target=drone_producer,
        args=(drone_id, path, sender, START_OFFSETS[drone_id]),
        daemon=True
    )
    threads.append(t)
    t.start()
```
 
### 4.3 Transport Layer
 
#### WebSocket Server (Primary)
```python
import asyncio
import websockets
import json
from dataclasses import asdict
 
CLIENTS = set()
 
async def register(websocket):
    CLIENTS.add(websocket)
    try:
        await websocket.wait_closed()
    finally:
        CLIENTS.remove(websocket)
 
async def broadcast(packet: DronePacket):
    if CLIENTS:
        message = json.dumps(asdict(packet))
        await asyncio.gather(*[client.send(message) for client in CLIENTS])
 
async def main():
    async with websockets.serve(register, "localhost", 8765):
        await asyncio.Future()  # run forever
 
asyncio.run(main())
```
 
- Address: ws://localhost:8765
- Protocol: JSON-encoded DronePacket (via dataclasses.asdict())
- Pattern: broadcast to all connected clients
- Latency target: < 100ms from packet build to dashboard render
#### Foundry REST API (Secondary / Async)
```python
import requests
import threading
 
FOUNDRY_URL = "https://your-instance.palantirfoundry.com"
FOUNDRY_TOKEN = "your_bearer_token"
DATASET_RID = "ri.foundry.main.dataset.your-dataset-rid"
 
def push_to_foundry(packet: DronePacket):
    """Fire-and-forget — runs in background thread, does not block WebSocket."""
    def _push():
        try:
            requests.post(
                f"{FOUNDRY_URL}/api/v1/datasets/{DATASET_RID}/transactions",
                headers={"Authorization": f"Bearer {FOUNDRY_TOKEN}",
                         "Content-Type": "application/json"},
                json=asdict(packet),
                timeout=5
            )
        except Exception as e:
            print(f"[Foundry] Push failed: {e}")
 
    threading.Thread(target=_push, daemon=True).start()
```
 
#### Dual-Sink Sender
```python
class DualSinkSender:
    def __init__(self, ws_loop, foundry_enabled=True):
        self.ws_loop = ws_loop
        self.foundry_enabled = foundry_enabled
 
    def send(self, packet: DronePacket):
        # WebSocket: async broadcast
        asyncio.run_coroutine_threadsafe(broadcast(packet), self.ws_loop)
 
        # Foundry: fire-and-forget background thread
        if self.foundry_enabled:
            push_to_foundry(packet)
```
 
### 4.4 Foundry Dataset Schema
 
Dataset name: six_eyes_telemetry
 
| Column | Type | Description |
|---|---|---|
| drone_id | String | DRONE_1 through DRONE_6 |
| timestamp | Double | Unix timestamp |
| frame_idx | Integer | Frame number since mission start |
| detection_count | Integer | Number of persons detected this frame |
| detection_confidence_max | Double | Highest confidence detection (0-1) |
| lat | Double | GPS latitude |
| lon | Double | GPS longitude |
| alt | Double | Altitude in meters |
| battery | Double | Battery percentage (0-100) |
| signal | String | STRONG / WEAK / LOST |
| status | String | ONLINE / WARNING / CRITICAL |
| speed_ms | Double | Speed in m/s |
| zone | String | ALPHA / BRAVO / CHARLIE / DELTA / ECHO / FOXTROT |
| coverage_pct | Double | Zone coverage percentage |
| elapsed_s | Double | Seconds since mission start |
 
### 4.5 Foundry Transform Pipeline
 
Three transforms run on the raw telemetry dataset:
 
Transform 1 — Alert Flags
```
battery < 20 -> battery_alert = TRUE
signal = "LOST" -> connection_alert = TRUE
detection_count > 0 -> person_detected = TRUE
detection_count > 2 -> mass_detection_alert = TRUE
```
 
Transform 2 — Per-Drone Latest State
Group by drone_id, take latest row by timestamp. Produces a 6-row live state table used by AIP agent.
 
Transform 3 — Mission Summary
Aggregate across all drones: total detections, drones online, average battery, zones covered.
 
### 4.6 AIP Agent
 
Trigger conditions:
- Scheduled: every 30 seconds
- Immediate event: any connection_alert = TRUE
- Immediate event: any mass_detection_alert = TRUE
- Immediate event: any drone battery < 10
System prompt:
```
You are SIX-EYES Mission Intelligence, the AI operations officer for a six-drone
search and rescue mission. You receive real-time telemetry from all six drones.
 
Your role is to generate concise 2-3 sentence situational updates for the human
operator. You must:
- Flag critical events immediately (signal loss, battery critical, mass detection)
- Recommend operational actions (redirect drone, return to base, prioritize zone)
- Maintain awareness of zone coverage and mission progress
 
Rules:
- Never be verbose. 2-3 sentences maximum.
- Prioritize the most critical event first.
- Always include confidence level for detections.
- Human is always in command — you recommend, never command.
- If all systems are nominal, give a brief status summary.
 
Current telemetry snapshot:
{telemetry_json}
 
Latest alert flags:
{alert_flags}
```
 
Example output:
"DRONE_3 has lost signal in Zone CHARLIE — recommend redirecting DRONE_4 from Zone DELTA to provide coverage. Battery on DRONE_1 is at 14%, approaching critical threshold — consider return-to-base. Two persons detected by DRONE_2 in Zone BRAVO at 87% confidence; Zone BRAVO should be prioritized."
 
Human-in-the-loop constraint: The agent informs and recommends only. It does not autonomously redirect drones. All actions require operator confirmation. This is a deliberate design decision.
 
### 4.7 Web Dashboard — Foundry Slate
 
Layout:
```
+------------------------------------------------------------------+
|  VIDEO FEEDS (2x3 grid)         |  GPS MAP      |  HEALTH       |
|  +------+ +------+             |               |  D1  ||||  78% |
|  | D1   | | D2   |             |  *D1  *D2     |  D2  ||||  65% |
|  +------+ +------+             |    *D3        |  D3  ||    32% |
|  +------+ +------+             |  *D4  *D5 *D6 |  D4  ||||  81% |
|  | D3   | | D4   |             |               |  D5  |||   55% |
|  +------+ +------+             |               |  D6  ||||  72% |
|  +------+ +------+             |               |               |
|  | D5   | | D6   |             |               |               |
|  +------+ +------+             |               |               |
+------------------------------------------------------------------+
|  AI AGENT:  "DRONE_3 signal lost in Zone CHARLIE —              |
|  recommend redirecting DRONE_4. Battery on DRONE_1 at 14%."     |
+------------------------------------------------------------------+
```
 
Panel Specifications:
 
Video Grid Panel:
- 2x3 grid of video players (D1-D6)
- Each video plays the corresponding MP4 file
- Bounding box overlay synchronized via frame_idx from WebSocket packet
- Player labeled with drone_id and zone name
GPS Map Panel:
- Slate Map widget
- 6 drone markers at current lat/lon from live telemetry dataset
- Color-coded by status: green = ONLINE, amber = WARNING, red = LOST
- Path trace shows recent movement (last 60 seconds of positions)
- Auto-refreshes from dataset every 5 seconds
Drone Health Panel:
- Table or card grid, one row per drone
- Columns: Drone ID, Zone, Battery (progress bar), Signal (badge), Status (badge), Speed, Temp
- Battery bar: green > 50%, amber 20-50%, red < 20%
- Signal badge: green STRONG, amber WEAK, red LOST
- Auto-refreshes every 5 seconds
AI Agent Strip:
- Full-width text panel at bottom of dashboard
- Displays latest AIP agent output
- Shows timestamp of last update
- Auto-refreshes when Foundry AIP output dataset updates
- Background: subtle amber tint on WARNING state, red tint on CRITICAL
---
 
## 5. Project File Structure
 
```
six-eyes/
├── README.md
├── requirements.txt
├── .env                        # FOUNDRY_TOKEN, FOUNDRY_URL, DATASET_RID
|
├── footage/
│   ├── drone_1.mp4
│   ├── drone_2.mp4
│   ├── drone_3.mp4
│   ├── drone_4.mp4
│   ├── drone_5.mp4
│   └── drone_6.mp4
|
├── src/
│   ├── main.py                 # Entry point — launches all threads + WS server
│   ├── dashboard_server.py     # Serves dashboard + env-backed runtime config
│   ├── producer.py             # drone_producer() + thread orchestration
│   ├── inference.py            # YOLOv8n model load + run_detection()
│   ├── simulators.py           # simulate_gps(), simulate_health()
│   ├── packet.py               # DronePacket dataclass + build_packet()
│   ├── transport/
│   │   ├── websocket_server.py # asyncio WS server + broadcast()
│   │   └── foundry_client.py   # push_to_foundry() + DualSinkSender
│   └── config.py               # VIDEO_PATHS, ZONES, PATTERNS, BASE_COORDS
|
└── tests/
    ├── test_inference.py       # Verify YOLO fires on sample frames
    ├── test_simulators.py      # Verify GPS paths, health decay
    └── ws_client_test.py       # Connect to WS, print received packets
```
 
---
 
## 6. Dependencies
 
```
# requirements.txt
opencv-python==4.9.0.80
ultralytics==8.2.0
websockets==12.0
requests==2.31.0
numpy==1.26.4
python-dotenv==1.0.0
```
 
---
 
## 7. Environment Variables
 
```
# .env
FOUNDRY_URL=https://your-instance.palantirfoundry.com
FOUNDRY_TOKEN=your_bearer_token_here
MAPBOX_ACCESS_TOKEN=your_restricted_mapbox_public_token_here
DATASET_RID=ri.foundry.main.dataset.your-dataset-rid
WS_HOST=localhost
WS_PORT=8765
DASHBOARD_HOST=localhost
DASHBOARD_PORT=8000
DASHBOARD_WS_URL=ws://localhost:8765
NAV_GEO_SPEED_DEG_S=0.00005
MISSION_DURATION_S=600
```

Run the dashboard through the local config server so `MAPBOX_ACCESS_TOKEN` is
loaded from `.env` instead of being hardcoded in `six_eyes_dashboard.html`:

```
python -m src.dashboard_server
```
 
---
 
## 8. Key Architecture Decisions and Rationale
 
| Decision | Choice | Rationale |
|---|---|---|
| Transport (primary) | WebSocket | Push-based, no polling lag, true real-time feel for demo |
| Transport (secondary) | REST to Foundry | Foundry's native ingestion pattern, async so it does not block WS |
| CV model | YOLOv8n ONNX | Speed across 6 threads; ONNX runs without PyTorch at inference time |
| Model size | Nano (n) | 6 parallel inference threads on CPU — larger models would bottleneck |
| Video source | Pre-recorded MP4 | Avoids real drone requirement; OpenCV loop is indistinguishable from live |
| FPS pacing | Manual sleep() | OpenCV reads faster than real-time without throttling |
| Drone desync | Start offset per thread | Makes 6 feeds look genuinely independent |
| Agent autonomy | Inform + recommend only | Human-in-the-loop is mandatory for military SAR; deliberate design choice |
| Agent cadence | 30s + event-driven | Balances operational rhythm with immediate critical event response |
| Foundry Slate vs custom React | Slate | Native Palantir — reviewers are FDEs who know the platform |
 
---
 
## 9. Simulated Demo Events
 
These events must be rehearsable and triggerable on-demand during the demo recording.
 
### Event 1 — Drone Signal Lost
Trigger: Kill DRONE_3 thread mid-mission (e.g., after 60 seconds)
 
Expected behavior:
- DRONE_3 health.signal -> "LOST", health.status -> "CRITICAL"
- GPS map: DRONE_3 marker turns red
- Health panel: DRONE_3 row shows red LOST badge
- AIP agent fires immediately (within 5 seconds): generates alert mentioning DRONE_3, Zone CHARLIE, recommends DRONE_4 redirection
- AI strip updates with the recommendation
Implementation:
```python
# In demo script — kill DRONE_3 after 60s
time.sleep(60)
stop_events["DRONE_3"].set()  # use threading.Event() flag per thread
```
 
### Event 2 — Person Detected
Trigger: YOLO fires on footage with a visible person in frame (natural)
 
Expected behavior:
- detection_count > 0 for the drone capturing the person
- Dashboard video grid: bounding box visible on that drone's feed
- AIP agent flags in next update: drone_id, zone, confidence score
- Operator can see exactly which zone to dispatch ground team
Implementation: Use footage known to have people in frame. Verify YOLO detects them during the test phase (Step 3 of build plan).
 
### Event 3 — Battery Critical
Trigger: Organic — occurs naturally as battery simulator decays over time (~20 minutes at default rate). Can be accelerated for demo by increasing drain rate.
 
Expected behavior:
- Battery hits < 20%: status -> WARNING, amber badge
- Battery hits < 10%: status -> CRITICAL, AIP agent recommends RTB (return to base)
---
 
