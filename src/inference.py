"""YOLOv8n person detection.

A single YOLO model is shared process-wide across all six producer threads.
Six independent models each paid their own load + first-inference warmup, which
serialized into a multi-second blank-dashboard window at startup (review
finding #9) and cost 6x the memory for no benefit. ultralytics reuses one
internal predictor per model, so concurrent inference on the shared instance is
serialized with a lock (review finding #8 — kept cheap by detecting on a frame
stride, see producer.DETECT_EVERY_N).
"""
import threading

from . import config

_model = None
_load_lock = threading.Lock()   # guards the one-time lazy load
_infer_lock = threading.Lock()  # serializes inference on the shared model


def load_model(weights: str = None):
    """Return the process-wide shared YOLO model, loading it once on first call.

    ultralytics is imported lazily so tests/tools can import this module without
    pulling it in until a model is actually needed. The first caller loads under
    a lock; the other five threads get the same instance.
    """
    global _model
    if _model is not None:
        return _model
    with _load_lock:
        if _model is None:
            from ultralytics import YOLO

            _model = YOLO(weights or config.YOLO_MODEL)
    return _model


def warmup():
    """Load and run one throwaway inference so the first real frame is fast.

    Call this once before launching producers: ultralytics fuses layers and
    allocates buffers on the first inference, which otherwise lands on the first
    live frame and leaves every dashboard tile blank for seconds at start.
    """
    import numpy as np

    run_detection(load_model(), np.zeros((480, 640, 3), dtype=np.uint8))


def run_detection(model, frame) -> list:
    """Return a list of {class, confidence, bbox} dicts for detected persons.

    Inference (and the result parsing that reads the shared predictor's output)
    is serialized: every producer thread shares one model instance.
    """
    with _infer_lock:
        results = model(frame, verbose=False, imgsz=config.YOLO_IMGSZ)
        detections = []
        for box in results[0].boxes:
            if int(box.cls) == config.PERSON_CLASS_ID:
                detections.append({
                    "class": "person",
                    "confidence": round(float(box.conf), 3),
                    "bbox": [int(x) for x in box.xyxy[0].tolist()],  # [x1, y1, x2, y2]
                })
    return detections
