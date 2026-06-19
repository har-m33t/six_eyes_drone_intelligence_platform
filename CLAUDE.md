# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current State

This repository currently contains **only the specification** (`README.md`). None of the source code, `requirements.txt`, `footage/`, or `tests/` described below exist yet — they are the planned implementation. When building, follow the file layout and signatures defined in `README.md` (the spec is authoritative and detailed, including reference code for every component).

## What This Project Is

SIX-EYES is a drone-swarm intelligence dashboard demo built on Palantir Foundry + AIP. Six pre-recorded MP4 files are treated as six live drone feeds. A Python producer runs CV inference + simulated telemetry per drone and fans each packet out to two sinks. A Foundry Slate dashboard renders the live view; an AIP agent synthesizes situational updates. It is a **demo/simulation** — there are no real drones; GPS and health are mathematically simulated, video is looped MP4.

## Commands

Once implemented per the spec:

```bash
pip install -r requirements.txt        # opencv-python, ultralytics, websockets, requests, numpy, python-dotenv
python src/main.py                     # launches 6 producer threads + WebSocket server (entry point)

# pytest must run with plugin autoload disabled — a global ROS2 / Python 3.8 install on
# PYTHONPATH injects broken pytest plugins that crash collection (see pytest.ini).
# PowerShell:  $env:PYTEST_DISABLE_PLUGIN_AUTOLOAD=1; python -m pytest tests/
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest tests/                     # run all tests
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest tests/test_inference.py    # run a single test file
python tests/ws_client_test.py         # manual WS client: connect to ws://localhost:8765 and print packets
```

Requires a `.env` file (see README §7): `FOUNDRY_URL`, `FOUNDRY_TOKEN`, `DATASET_RID`, `WS_HOST`, `WS_PORT`, `MISSION_DURATION_S`. The Foundry sink can be disabled (`foundry_enabled=False` on the sender) to run the dashboard locally without a Foundry instance.

## Architecture — The Big Picture

The non-obvious design centers on a **dual-sink fan-out** with a deliberate priority split. Read these together to understand the data path:

1. **Producer threads** (`src/producer.py`) — one daemon thread per drone, six total. Each loops its MP4 via OpenCV, paces itself toward real-time FPS with a manual `time.sleep()`, runs YOLOv8n person detection (`src/inference.py`), merges detections with simulated GPS + health (`src/simulators.py`) into a `DronePacket` (`src/packet.py`), and hands it to the sender. The six threads **share one YOLO model** (loaded + warmed once in `main()`); inference is serialized with a lock and runs on a frame stride (`config.DETECT_EVERY_N`) because on CPU, inference — not OpenCV decode — is the throughput limiter for six concurrent feeds, so the real-time sleep rarely engages and playback runs somewhat below real-time.

2. **Dual sink** with different guarantees. The fan-out is **split across two owners** (changed from the original single-junction design — see note):
   - **PRIMARY — WebSocket**, via `DualSinkSender.send()` (`src/transport/foundry_client.py` → `websocket_server.py`): every `DronePacket`, every frame, broadcast to all dashboard clients via `asyncio.run_coroutine_threadsafe`. Drives the live dashboard, must stay <100ms latency. This path is untouched by the Foundry sink.
   - **SECONDARY — Foundry REST**, driven from the **producer** (not the sender): `producer.drone_producer` builds flat `TelemetryRow`/`DetectionRow` dicts (`src/packet.py`) from data already on the packet and calls `write_telemetry`/`write_detection` (`foundry_client.py`). Those are **non-blocking enqueues**; a single background flush thread batches rows and lands them via Foundry's real ingestion flow (open APPEND transaction → upload CSV → commit) into two datasets (`TELEMETRY_DATASET_RID`, `DETECTION_DATASET_RID`). It **must never block or fail the WebSocket path** — enqueue is non-blocking, all I/O is on the flush thread, and every step swallows/loggs errors with HTTP status. Gated by `FOUNDRY_ENABLED`.

   > **Architecture change (2026-06-19):** previously `DualSinkSender` was the single junction doing both sinks (`push_to_foundry`, thread-per-packet). The Foundry sink was moved out of the sender into the producer + a batched flush thread (per `.claude/foundary-task.md`); `push_to_foundry`/`_FoundryWorker` are gone. The WebSocket path and `DronePacket` wire format are unchanged.

3. **Shared mission clock**: `MISSION_START = time.time()` is set once and shared across all threads. GPS sinusoids, battery decay, and `elapsed_s` all derive from it, so the six feeds stay time-synchronized. Drone independence is faked via per-drone `START_OFFSETS` (video) and distinct `DRONE_PATTERNS` (GPS amplitude/frequency).

4. **Foundry side** (configured in Foundry, not this repo): raw telemetry dataset → three transforms (alert flags, per-drone latest state, mission summary) → AIP agent. The agent fires every 30s **and** event-driven on `connection_alert`, `mass_detection_alert`, or battery <10. Its output is **inform/recommend only** — human-in-the-loop is a hard design constraint (military SAR); the agent never commands drones.

### Threading & async boundary

This is the trickiest part to get right: producer code is **synchronous threaded** (6 threads), but the WebSocket server is **asyncio**. They communicate across the boundary via `asyncio.run_coroutine_threadsafe(broadcast(packet), ws_loop)`. The sender must hold a reference to the running WS event loop. Foundry writes are enqueued (non-blocking) from the producer threads and drained by **one** background flush thread — independent of the WS loop and never thread-per-write.

## Key Conventions

- **Drone IDs** are `DRONE_1`..`DRONE_6` everywhere (packet field, dataset key, config maps).
- **Zones** map 1:1 to drones: ALPHA, BRAVO, CHARLIE, DELTA, ECHO, FOXTROT (`src/config.py`).
- **Packet wire format**: `DronePacket` dataclass serialized with `dataclasses.asdict()` → JSON, identical payload to both sinks. The Foundry dataset schema (README §4.4) flattens nested `detections`/`gps`/`health` into columns (e.g. `detection_count`, `detection_confidence_max`) — that flattening happens on ingestion, not in the packet.
- **YOLO person filter**: only `box.cls == 0` (COCO class 0 = person) is kept.
- **Config lives in `src/config.py`**: `VIDEO_PATHS`, `START_OFFSETS`, `ZONES`, `DRONE_PATTERNS`, `BASE_LAT/BASE_LON`. Prefer editing config over hardcoding in producer/simulator code.

## Demo Events (must stay triggerable)

Three rehearsed demo scenarios drive design choices (README §9): signal-lost (kill a thread via a per-drone `threading.Event` flag), person-detected (YOLO fires on footage with visible people), battery-critical (organic decay, accelerable by raising drain rate). Keep these reproducible when modifying the producer or simulators.
