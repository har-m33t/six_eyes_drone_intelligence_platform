"""Foundry sink: row factories + batched open→upload→commit ingestion.

These exercise the secondary sink in isolation (requests mocked), so no live
Foundry instance is needed. The contract: rows are buffered by write_*, then
landed as a batch via open transaction → upload CSV → commit; _ingest returns
True only on a committed batch, aborts the transaction on any failure, skips
cleanly when config is missing, and never raises.
"""
import csv
import io

import pytest

from src.packet import make_detection_row, make_telemetry_row
from src.transport import foundry_client


GPS = {"lat": 34.05, "lon": -118.24, "alt": 75.0}
HEALTH = {"battery": 88.0, "signal": "STRONG", "status": "ONLINE",
          "speed_ms": 12.0, "temp_c": 40.0}
MISSION = {"zone": "ALPHA", "coverage_pct": 12.5, "elapsed_s": 15.0}


class _Resp:
    def __init__(self, status_code, text="", payload=None):
        self.status_code = status_code
        self.text = text
        self._payload = payload or {}

    @property
    def ok(self):
        return 200 <= self.status_code < 400

    def json(self):
        return self._payload


def _router(calls, *, open_status=200, upload_status=200, commit_status=200,
            txn="ri.foundry.main.transaction.test"):
    """Fake requests.post that emulates the three-step ingestion by URL."""
    def post(url, headers=None, json=None, data=None, timeout=None):
        calls.append({"url": url, "json": json, "data": data, "timeout": timeout})
        if url.endswith("/transactions"):
            return _Resp(open_status, payload={"rid": txn})
        if "/files:upload" in url:
            return _Resp(upload_status)
        if url.endswith("/commit"):
            return _Resp(commit_status)
        if url.endswith("/abort"):
            return _Resp(200)
        return _Resp(404, "unexpected url")
    return post


@pytest.fixture
def foundry_env(monkeypatch):
    monkeypatch.setenv("FOUNDRY_URL", "https://foundry.example.com/")
    monkeypatch.setenv("FOUNDRY_TOKEN", "tok")
    monkeypatch.setenv("TELEMETRY_DATASET_RID", "ri.telemetry")
    monkeypatch.setenv("DETECTION_DATASET_RID", "ri.detection")


# --- row factories ----------------------------------------------------------

def test_make_telemetry_row_is_flat_dict_without_video():
    row = make_telemetry_row("DRONE_1", 1000.0, GPS, HEALTH, MISSION)
    assert row == {
        "drone_id": "DRONE_1", "timestamp": 1000.0,
        "lat": 34.05, "lon": -118.24, "alt": 75.0,
        "battery": 88.0, "signal": "STRONG", "status": "ONLINE",
        "speed_ms": 12.0, "zone": "ALPHA", "coverage_pct": 12.5,
    }
    assert "frame_b64" not in row


def test_make_detection_row_has_unique_uuid_and_gps():
    r1 = make_detection_row("DRONE_2", 1000.0, 0.91, GPS)
    r2 = make_detection_row("DRONE_2", 1000.0, 0.91, GPS)
    assert r1["detection_id"] != r2["detection_id"]  # fresh uuid4 each call
    assert len(r1["detection_id"]) == 36
    assert r1["drone_id"] == "DRONE_2"
    assert r1["confidence"] == 0.91
    assert r1["lat"] == GPS["lat"] and r1["lon"] == GPS["lon"]


# --- batched ingestion ------------------------------------------------------

def test_ingest_opens_uploads_commits_csv(foundry_env, monkeypatch):
    calls = []
    monkeypatch.setattr(foundry_client.requests, "post", _router(calls))
    rows = [make_telemetry_row("DRONE_1", 1000.0, GPS, HEALTH, MISSION),
            make_telemetry_row("DRONE_2", 1001.0, GPS, HEALTH, MISSION)]

    assert foundry_client._ingest("TELEMETRY_DATASET_RID", rows, "telemetry") is True

    steps = [c["url"] for c in calls]
    # open → upload → commit, against the right dataset, no trailing-slash dup.
    assert steps[0] == "https://foundry.example.com/api/v1/datasets/ri.telemetry/transactions"
    assert calls[0]["json"] == {"transactionType": "APPEND"}
    assert "/files:upload?filePath=" in steps[1] and "transactionRid=ri.foundry" in steps[1]
    assert steps[2].endswith("/transactions/ri.foundry.main.transaction.test/commit")
    assert not any(u.endswith("/abort") for u in steps)

    # The uploaded body is a CSV with a header row + one line per telemetry row.
    parsed = list(csv.DictReader(io.StringIO(calls[1]["data"].decode("utf-8"))))
    assert [r["drone_id"] for r in parsed] == ["DRONE_1", "DRONE_2"]
    assert parsed[0]["battery"] == "88.0"


def test_ingest_uses_detection_rid(foundry_env, monkeypatch):
    calls = []
    monkeypatch.setattr(foundry_client.requests, "post", _router(calls))
    foundry_client._ingest("DETECTION_DATASET_RID", [{"detection_id": "x"}], "detection")
    assert "ri.detection" in calls[0]["url"]


def test_ingest_aborts_on_upload_failure(foundry_env, monkeypatch):
    calls = []
    monkeypatch.setattr(foundry_client.requests, "post",
                        _router(calls, upload_status=500))
    assert foundry_client._ingest("TELEMETRY_DATASET_RID", [{"a": 1}], "telemetry") is False
    assert any(c["url"].endswith("/abort") for c in calls)  # transaction cleaned up
    assert not any(c["url"].endswith("/commit") for c in calls)


def test_ingest_false_on_open_failure_and_no_upload(foundry_env, monkeypatch):
    calls = []
    monkeypatch.setattr(foundry_client.requests, "post",
                        _router(calls, open_status=403))
    assert foundry_client._ingest("TELEMETRY_DATASET_RID", [{"a": 1}], "telemetry") is False
    assert not any("/files:upload" in c["url"] for c in calls)


def test_ingest_recovers_from_dangling_open_transaction(foundry_env, monkeypatch):
    """A 409 (open txn from a prior crash) is aborted, then the open is retried."""
    calls = []
    state = {"open_attempts": 0}

    def post(url, headers=None, json=None, data=None, timeout=None):
        calls.append(url)
        if url.endswith("/transactions"):
            state["open_attempts"] += 1
            if state["open_attempts"] == 1:
                return _Resp(409, '{"errorName":"OpenTransactionAlreadyExists"}')
            return _Resp(200, payload={"rid": "ri.foundry.main.transaction.new"})
        if "/files:upload" in url:
            return _Resp(200)
        if url.endswith("/commit") or url.endswith("/abort"):
            return _Resp(200)
        return _Resp(404)

    def get(url, headers=None, timeout=None):
        if url.endswith("/branches/master"):
            return _Resp(200, payload={"transactionRid": "ri.foundry.main.transaction.stuck"})
        if url.endswith("/transactions/ri.foundry.main.transaction.stuck"):
            return _Resp(200, payload={"status": "OPEN"})
        return _Resp(404)

    monkeypatch.setattr(foundry_client.requests, "post", post)
    monkeypatch.setattr(foundry_client.requests, "get", get)

    assert foundry_client._ingest("TELEMETRY_DATASET_RID", [{"a": 1}], "telemetry") is True
    assert state["open_attempts"] == 2  # retried after recovery
    assert any(u.endswith("/transactions/ri.foundry.main.transaction.stuck/abort")
               for u in calls)  # dangling txn was aborted


def test_ingest_false_on_request_exception(foundry_env, monkeypatch):
    def boom(*a, **k):
        raise foundry_client.requests.RequestException("connection refused")
    monkeypatch.setattr(foundry_client.requests, "post", boom)
    assert foundry_client._ingest("TELEMETRY_DATASET_RID", [{"a": 1}], "telemetry") is False


def test_ingest_skips_when_rid_missing(monkeypatch):
    monkeypatch.setenv("FOUNDRY_URL", "https://foundry.example.com")
    monkeypatch.setenv("FOUNDRY_TOKEN", "tok")
    monkeypatch.delenv("TELEMETRY_DATASET_RID", raising=False)
    monkeypatch.setattr(foundry_client.requests, "post",
                        lambda *a, **k: pytest.fail("must not POST without RID"))
    assert foundry_client._ingest("TELEMETRY_DATASET_RID", [{"a": 1}], "telemetry") is False


def test_ingest_empty_batch_is_noop(monkeypatch):
    monkeypatch.setattr(foundry_client.requests, "post",
                        lambda *a, **k: pytest.fail("must not POST for empty batch"))
    assert foundry_client._ingest("TELEMETRY_DATASET_RID", [], "telemetry") is True


# --- enqueue + flush --------------------------------------------------------

def test_write_buffers_then_flush_ingests(foundry_env, monkeypatch):
    calls = []
    monkeypatch.setattr(foundry_client.requests, "post", _router(calls))
    batch = foundry_client._DatasetBatch("TELEMETRY_DATASET_RID", "telemetry")

    batch.add({"a": 1})
    batch.add({"a": 2})
    assert calls == []  # nothing sent until flush

    assert batch.flush() is True
    assert [c["url"] for c in calls][0].endswith("/transactions")  # open happened
    assert batch.flush() is True and len(calls) == 3  # buffer drained; no new I/O


def test_add_over_cap_signals_flush_without_blocking(monkeypatch):
    """Hitting the size cap must wake the background flush thread, not POST
    inline on the caller (producer/WS hot-path) thread."""
    monkeypatch.setattr(foundry_client.requests, "post",
                        lambda *a, **k: pytest.fail("add() must not POST inline"))
    foundry_client._flush_now.clear()
    batch = foundry_client._DatasetBatch("TELEMETRY_DATASET_RID", "telemetry")
    for i in range(foundry_client._BATCH_MAX_ROWS):
        batch.add({"a": i})
    assert foundry_client._flush_now.is_set()                 # flush thread signaled
    assert len(batch._rows) == foundry_client._BATCH_MAX_ROWS  # still buffered, not lost
    foundry_client._flush_now.clear()


def test_write_telemetry_and_detection_enqueue_true():
    foundry_client._telemetry_batch._rows.clear()
    foundry_client._detection_batch._rows.clear()
    assert foundry_client.write_telemetry({"a": 1}) is True
    assert foundry_client.write_detection({"detection_id": "x"}) is True
    assert foundry_client._telemetry_batch._rows == [{"a": 1}]
    assert foundry_client._detection_batch._rows == [{"detection_id": "x"}]
    foundry_client._telemetry_batch._rows.clear()
    foundry_client._detection_batch._rows.clear()
