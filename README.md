# SIX-EYES - Drone Fleet Intelligence Dashboard

SIX-EYES is a local real-time drone swarm simulation and operator dashboard. A Python backend treats recorded MP4 files as live drone feeds, runs person detection, simulates GPS and health telemetry, accepts mission commands, and broadcasts packets over WebSocket. A rebased React + TypeScript + Vite frontend renders the live video wall, tactical map, coverage progress, fleet health, deploy controls, and mission intelligence panels.

## Current Status

- The active frontend is the React/Vite app in `frontend/`.
- `six_eyes_dashboard.html` is the legacy single-file dashboard. It remains useful as a behavior reference and for older regression tests, but it is not the primary frontend.
- The primary runtime transport is the local WebSocket server at `ws://localhost:8765`.
- The app runs locally. No external data platform is required for the current workflow.
- The backend streams continuously until interrupted with Ctrl+C.

## Architecture

| Area | Current implementation |
|---|---|
| Backend entry point | `src/main.py` starts the WebSocket server, registers mission handlers, warms inference, and launches producer threads. |
| Drone producers | `src/producer.py` runs one thread per drone, loops footage at real-time pacing, encodes JPEG frames, and emits packets. |
| Computer vision | `src/inference.py` loads YOLO and returns person detections with confidence and bounding boxes. |
| Telemetry packets | `src/packet.py` defines full drone packets and navigation telemetry packets. |
| Mission planning | `src/coverage_planner.py` builds lawnmower routes from a drawn polygon. `src/navigation.py` flies drones along assigned routes. |
| WebSocket transport | `src/transport/websocket_server.py` broadcasts telemetry and handles dashboard commands such as `START_MISSION` and `KILL_DRONE`. |
| React frontend | `frontend/src/` contains the Vite application, Zustand store, WebSocket service, video grid, tactical map, deploy controls, and mission panels. |
| Runtime config server | `src/dashboard_server.py` can serve `/runtime-config.js` for Mapbox token and WebSocket URL delivery, and can still serve the legacy HTML dashboard. |

## Data Flow

1. MP4 footage in `footage/` is opened by the Python producer threads.
2. Each producer reads frames at video FPS, runs YOLO on a configurable stride, and reuses the latest detections between inference frames.
3. Frames are downscaled and JPEG encoded into `frame_b64` for the dashboard video grid.
4. Each full drone packet includes drone identity, timestamp, frame index, detections, GPS, health, mission metadata, and optional video frame data.
5. The WebSocket server broadcasts packets to connected dashboards.
6. The React WebSocket service decodes incoming messages, stores packets in Zustand, and updates only the subscribed UI panels.
7. `VideoGrid` renders `frame_b64` as a JPEG data URL, matching the behavior of the original dashboard.
8. The operator can draw a search polygon in the React map and deploy the swarm. The frontend sends `START_MISSION`, the backend plans routes, and producers emit navigation telemetry for map coverage progress.

## Frontend Rebase

The current frontend is no longer a single inline script. It is a React 18 application built with TypeScript, Vite, Zustand, Mapbox GL, and Mapbox Draw.

Important frontend paths:

| Path | Purpose |
|---|---|
| `frontend/src/main.tsx` | Mounts React and opens the WebSocket connection. |
| `frontend/src/services/websocket.ts` | Owns socket lifecycle, reconnects, command queueing, and inbound packet ingestion. |
| `frontend/src/store/useSwarmStore.ts` | Stores drone packets, navigation telemetry, connection status, coverage, and fleet summary state. |
| `frontend/src/components/VideoGrid.tsx` | Renders the six-feed wall in canonical drone order. |
| `frontend/src/components/VideoFeed.tsx` | Renders live frames, offline state, replay fallback, and detection overlays. |
| `frontend/src/components/TacticalMap.tsx` | Renders Mapbox map, markers, mission polygon drawing, and coverage footprint. |
| `frontend/src/controllers/useDeploySwarm.ts` | Connects map drawing state to `START_MISSION` command dispatch. |
| `frontend/src/components/IntelPanel.tsx` | Summarizes current mission state from live frontend telemetry. |

## Features

- Six-drone live video grid with replay fallback before live frames arrive.
- Base64 JPEG frame rendering over WebSocket.
- Person detection badges and YOLO bounding-box overlay.
- Fleet health summary with battery, signal, and status.
- Tactical Mapbox view with drone markers and coverage footprint.
- Operator-drawn search polygon and deploy-swarm command flow.
- Waypoint-weighted coverage percentage from navigation telemetry.
- Keyboard kill control for the signal-lost demo path.
- Local mission intelligence panel derived from live dashboard state.

## Requirements

| Requirement | Notes |
|---|---|
| Python | Python 3.11 or newer. Current dependency pins support newer Python wheels. |
| Node.js | Node 18 or newer for Vite 5. |
| Video clips | Place H.264 MP4 files in `footage/`. Current backend config uses `drone_1.mp4`, `drone_2.mp4`, and `drone_3.mp4`, reusing them across six feeds with staggered offsets. |
| Mapbox token | Optional for non-map work, required for the live tactical map. Use `VITE_MAPBOX_ACCESS_TOKEN` in `frontend/.env.local` for Vite dev, or serve runtime config from the Python dashboard server. |

## Setup

1. From the repo root, create and activate a Python virtual environment, then install backend dependencies: `python -m venv .venv`, `.\.venv\Scripts\Activate.ps1`, and `pip install -r requirements.txt`.
2. Install frontend dependencies from `frontend/`: `npm install`.
3. Add footage clips under `footage/` using the names expected by `src/config.py`.
4. Configure Mapbox if you want the map to render. For Vite development, create `frontend/.env.local` and set `VITE_MAPBOX_ACCESS_TOKEN` to a public Mapbox token.

## Running Locally

Use two terminals:

1. Start the backend from the repo root with `python -m src.main`. This opens the WebSocket server on `ws://localhost:8765` and starts all producer threads.
2. Start the React frontend from `frontend/` with `npm run dev`. Open the Vite URL, usually `http://127.0.0.1:5173/`.

Optional: run `python -m src.dashboard_server` if you want `/runtime-config.js` served from `.env` or if you need to compare against the legacy dashboard at `http://localhost:8000/`.

## WebSocket Contract

The backend sends two inbound packet shapes to the dashboard.

| Packet | Purpose | Key fields |
|---|---|---|
| `DronePacket` | Full per-frame drone state and video frame. | `drone_id`, `timestamp`, `frame_idx`, `detections`, `gps`, `health`, `mission`, `frame_b64`. |
| `NavTelemetry` | Mission route progress and coverage footprint data. | `drone_id`, `timestamp`, `x`, `y`, `current_waypoint_idx`, `waypoints_remaining`, `mission_complete`, `coverage_active`. |

The frontend sends command frames back over the same socket.

| Command | Purpose |
|---|---|
| `START_MISSION` | Sends a drawn polygon as longitude/latitude vertices. The backend plans and injects routes into the running producers. |
| `KILL_DRONE` | Forces a target drone into the signal-lost demo path. |

## Useful Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `WS_HOST` and `WS_PORT` | Python backend | WebSocket bind host and port. Defaults to localhost and 8765. |
| `DASHBOARD_WS_URL` | Runtime config | Overrides the browser WebSocket URL when served through `/runtime-config.js`. |
| `MAPBOX_ACCESS_TOKEN` | Python runtime config server | Supplies the browser map token through `/runtime-config.js`. |
| `VITE_MAPBOX_ACCESS_TOKEN` | React/Vite frontend | Supplies the map token directly during Vite dev/build. |
| `YOLO_MODEL` | Backend inference | Selects the YOLO model file or model name. |
| `YOLO_IMGSZ` | Backend inference | Controls inference resolution. |
| `DETECT_EVERY_N` | Backend inference | Runs detection every Nth frame while video still streams every frame. |
| `VIDEO_STREAM_WIDTH` | Backend video stream | Downscales encoded dashboard frames. Set to `0` for telemetry-only mode. |
| `VIDEO_JPEG_QUALITY` | Backend video stream | Controls JPEG quality for WebSocket video frames. |
| `NAV_GEO_SPEED_DEG_S` | Mission navigation | Controls route speed for Mapbox longitude/latitude missions. |
| `NAV_GEO_TRANSIT_SPEED_DEG_S` | Mission navigation | Controls transit speed from hover point to route start. |

## Testing and Build

| Area | Command |
|---|---|
| Python tests | `python -m pytest tests -v` |
| Frontend tests | From `frontend/`, run `npm test -- --run` |
| Frontend production build | From `frontend/`, run `npm run build` |
| Frontend type check only | From `frontend/`, run `npm run typecheck` |

## Demo Notes

- Live video depends on `frame_b64` arriving in `DronePacket` messages. If `VIDEO_STREAM_WIDTH=0`, the dashboard will still receive telemetry, but live frame tiles will not switch from replay/placeholder to live images.
- Before a mission is deployed, drones hover near their simulated base positions and stream video plus health telemetry.
- Deploying a polygon starts route navigation and coverage telemetry.
- Killing `DRONE_3` through the UI or keyboard demo path sends the drone into `LOST` signal and `CRITICAL` status, which turns the relevant panels red.
- If Mapbox is not configured, the dashboard still mounts and the rest of the UI remains usable, but the map panel shows a fallback state.
