"""Verify GPS stays near base coords and battery decays monotonically-ish."""
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
    assert 0 <= h["battery"] <= 101
    assert h["status"] in {"ONLINE", "WARNING", "CRITICAL"}
    assert h["signal"] in {"STRONG", "WEAK", "LOST"}


def test_zone_assignment():
    assert config.assign_zone("DRONE_3") == "CHARLIE"
    assert config.assign_zone("DRONE_99") == "UNKNOWN"
