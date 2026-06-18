"""Producer threads: one daemon thread per drone. Each loops its MP4 at
real-time FPS, runs YOLO detection, builds a packet, and hands it to the sender.
"""
import base64
import threading
import time

import cv2

from . import config
from .inference import load_model, run_detection
from .packet import build_packet

# Per-drone stop flags — set the Event to kill a drone (e.g. demo signal-lost).
stop_events = {drone_id: threading.Event() for drone_id in config.DRONE_IDS}


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


def drone_producer(drone_id, video_path, sender, start_offset=0):
    model = load_model()
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_delay = 1.0 / fps
    frame_idx = 0

    if start_offset > 0:
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_offset)

    stop = stop_events[drone_id]
    while not stop.is_set():
        t_start = time.time()
        ret, frame = cap.read()
        if not ret:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # loop video
            continue

        detections = run_detection(model, frame)
        frame_b64 = encode_frame_b64(frame)
        packet = build_packet(drone_id, frame_idx, detections, frame_b64=frame_b64)
        sender.send(packet)

        frame_idx += 1
        elapsed = time.time() - t_start
        time.sleep(max(0, frame_delay - elapsed))  # maintain real-time FPS

    cap.release()
    print(f"[{drone_id}] producer stopped.")


def launch_producers(sender):
    """Start all six producer threads. Returns the list of started threads."""
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
