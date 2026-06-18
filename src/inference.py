"""YOLOv8n person detection. One model instance is loaded per producer thread."""
from . import config


def load_model(weights: str = None):
    """Load a YOLO model. Imported lazily so tests/tools can import this
    module without pulling in ultralytics until a model is actually needed.
    """
    from ultralytics import YOLO

    return YOLO(weights or config.YOLO_MODEL)


def run_detection(model, frame) -> list:
    """Return a list of {class, confidence, bbox} dicts for detected persons."""
    results = model(frame, verbose=False)
    detections = []
    for box in results[0].boxes:
        if int(box.cls) == config.PERSON_CLASS_ID:
            detections.append({
                "class": "person",
                "confidence": round(float(box.conf), 3),
                "bbox": [int(x) for x in box.xyxy[0].tolist()],  # [x1, y1, x2, y2]
            })
    return detections
