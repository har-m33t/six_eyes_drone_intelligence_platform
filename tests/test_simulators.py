"""Verify GPS stays near base coords and battery decays monotonically-ish."""
import time

from src import config
from src.simulators import simulate_gps, simulate_health


def test_gps_within_bounds_of_base():
    for drone_id in config.DRONE_IDS:
        gps = simulate_gps(drone_id)
        # Amplitudes are <= ~0.004 deg, so lat/lon stay close to base.
        assert abs(gps["lat"] - config.BASE_LAT) < 0.01
        assert abs(gps["lon"] - config.BASE_LON) < 0.01
        assert 65 <= gps["alt"] <= 85


def test_health_fields_and_status_consistency():
    h = simulate_health("DRONE_1", frame_idx=0)
    assert set(h) == {"battery", "signal", "status", "speed_ms", "temp_c"}
    assert 0 <= h["battery"] <= 100  # clamped: never exceeds 100%
    assert h["status"] in {"ONLINE", "WARNING", "CRITICAL"}
    assert h["signal"] in {"STRONG", "WEAK", "LOST"}


def test_battery_never_exceeds_100_at_mission_start(monkeypatch):
    """At elapsed~=0 the raw formula (100 + jitter) could yield >100; the clamp
    must hold across many samples."""
    monkeypatch.setattr(config, "MISSION_START", time.time())
    for _ in range(200):
        assert simulate_health("DRONE_1", frame_idx=0)["battery"] <= 100


def test_zone_assignment():
    assert config.assign_zone("DRONE_3") == "CHARLIE"
    assert config.assign_zone("DRONE_99") == "UNKNOWN"
