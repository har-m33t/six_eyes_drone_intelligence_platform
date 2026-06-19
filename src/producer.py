"""Producer threads: one daemon thread per drone. Each loops its MP4 at
real-time FPS, runs YOLO detection, builds a packet, and hands it to the sender.
"""
import base64
import threading
import time

import cv2

from . import config
from .inference import load_model, run_detection
from .packet import build_packet, make_detection_row, make_telemetry_row
from .transport.foundry_client import (
    start_foundry_flusher, write_detection, write_telemetry)

# Per-drone stop flags — set the Event to kill a drone (e.g. demo signal-lost).
stop_events = {drone_id: threading.Event() for drone_id in config.DRONE_IDS}

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
        frame_b64 = encode_frame_b64(frame)
        last_frame_b64 = frame_b64
        packet = build_packet(drone_id, frame_idx, detections, frame_b64=frame_b64)
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
