"""Producer threads: one daemon thread per drone. Each loops its MP4 at
real-time FPS, runs YOLO detection, builds a packet, and hands it to the sender.
"""
import threading
import time

import cv2

from . import config
from .inference import load_model, run_detection
from .packet import build_packet

# Per-drone stop flags — set the Event to kill a drone (e.g. demo signal-lost).
stop_events = {drone_id: threading.Event() for drone_id in config.DRONE_IDS}


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
        packet = build_packet(drone_id, frame_idx, detections)
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
