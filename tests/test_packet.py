"""Packet wire-format integrity.

build_packet -> dataclasses.asdict -> json.dumps is the single wire format sent
identically to both sinks. These tests pin its shape and JSON-serializability
without requiring YOLO (detections are passed in synthetically).
"""
import json
from dataclasses import asdict

from src import config
from src.packet import DronePacket, build_packet


SAMPLE_DETECTIONS = [
    {"class": "person", "confidence": 0.88, "bbox": [10, 20, 110, 220]},
]


def test_build_packet_schema():
    p = build_packet("DRONE_1", frame_idx=5, detections=SAMPLE_DETECTIONS)
    assert isinstance(p, DronePacket)
    assert p.drone_id == "DRONE_1"
    assert p.frame_idx == 5
    assert p.detections == SAMPLE_DETECTIONS
    assert set(p.gps) == {"lat", "lng", "lon", "alt"}
    assert p.gps["lng"] == p.gps["lon"]
    assert set(p.health) == {"battery", "signal", "status", "speed_ms", "temp_c"}
    assert set(p.mission) == {"zone", "coverage_pct", "elapsed_s"}
    assert p.mission["zone"] == config.assign_zone("DRONE_1")


def test_packet_is_json_serializable():
    """Both sinks serialize via asdict() -> json; every field must round-trip."""
    p = build_packet("DRONE_2", frame_idx=0, detections=SAMPLE_DETECTIONS)
    raw = json.dumps(asdict(p))
    back = json.loads(raw)
    assert back["drone_id"] == "DRONE_2"
    assert back["detections"][0]["class"] == "person"
    # Nested dicts survive the round-trip as dicts (Foundry flattens these later).
    assert isinstance(back["gps"], dict)
    assert isinstance(back["health"], dict)


def test_build_packet_accepts_mapbox_gps_override():
    gps = {"lat": 33.68, "lng": -117.82, "lon": -117.82, "alt": 75.0}
    p = build_packet("DRONE_1", frame_idx=0, detections=[], gps_override=gps)

    assert p.gps == gps


def test_empty_detections_is_valid():
    p = build_packet("DRONE_3", frame_idx=1, detections=[])
    assert p.detections == []
    json.dumps(asdict(p))  # must not raise


def test_coverage_pct_bounded():
    p = build_packet("DRONE_1", frame_idx=0, detections=[])
    assert 0 <= p.mission["coverage_pct"] <= 100
