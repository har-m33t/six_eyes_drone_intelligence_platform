"""Transport sinks.

PRIMARY — WebSocket: ``DualSinkSender`` broadcasts every DronePacket to the
dashboard. This is the live path and must never regress.

SECONDARY — Foundry REST: ``write_telemetry`` / ``write_detection`` enqueue
flat rows; a background flush thread lands them in two Foundry datasets using
Foundry's real ingestion flow — open transaction → upload a CSV file → commit.
Rows are batched (flushed on an interval) because a per-row transaction is both
rejected by the API and wildly expensive. Enqueue is non-blocking, so a slow or
failed Foundry write never blocks or delays the WebSocket frame send. Dataset
RIDs are read from the environment at call time.
"""
import asyncio
import atexit
import csv
import io
import os
import threading
import time
import urllib.parse
import uuid

import requests
from dotenv import load_dotenv

# config already loads .env, but load here too so these functions work even if
# foundry_client is imported/used without config (e.g. unit tests).
load_dotenv()

from .websocket_server import broadcast

_FOUNDRY_TIMEOUT_S = 8
# How often the background thread flushes buffered rows, and a hard size cap
# that forces an immediate flush so a detection burst can't grow unbounded.
_FLUSH_INTERVAL_S = float(os.getenv("FOUNDRY_FLUSH_INTERVAL_S", "5"))
_BATCH_MAX_ROWS = int(os.getenv("FOUNDRY_BATCH_MAX_ROWS", "1000"))


def _foundry_config(rid_env_var: str):
    """(url, token, rid) read fresh from the environment; values stripped."""
    return (
        (os.getenv("FOUNDRY_URL") or "").strip().rstrip("/"),
        (os.getenv("FOUNDRY_TOKEN") or "").strip(),
        (os.getenv(rid_env_var) or "").strip(),
    )


def _rows_to_csv(rows: list) -> bytes:
    """Serialize uniform dict rows to CSV bytes (header from the first row)."""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8")


def _abort(base: str, auth: dict, txn: str, label: str):
    try:
        requests.post(f"{base}/transactions/{txn}/abort", headers=auth,
                      timeout=_FOUNDRY_TIMEOUT_S)
    except requests.RequestException as e:
        print(f"[Foundry] {label} transaction abort failed: {e}")


def _abort_dangling(base: str, auth: dict, label: str):
    """Abort the branch's currently-open transaction, if any.

    A process killed mid-flush (Ctrl+C / timeout) leaves an OPEN transaction
    that blocks all future ingestion to that branch. Recover by aborting it.
    """
    try:
        br = requests.get(f"{base}/branches/master", headers=auth,
                          timeout=_FOUNDRY_TIMEOUT_S)
        txn = (br.json() or {}).get("transactionRid") if br.ok else None
        if not txn:
            return
        st = requests.get(f"{base}/transactions/{txn}", headers=auth,
                          timeout=_FOUNDRY_TIMEOUT_S)
        if st.ok and (st.json() or {}).get("status") == "OPEN":
            requests.post(f"{base}/transactions/{txn}/abort", headers=auth,
                          timeout=_FOUNDRY_TIMEOUT_S)
            print(f"[Foundry] {label} aborted a dangling open transaction ...{txn[-12:]}")
    except requests.RequestException as e:
        print(f"[Foundry] {label} dangling-transaction recovery failed: {e}")


def _open_transaction(base: str, auth: dict, label: str):
    """Open an APPEND transaction, returning its rid (or None on failure).

    On HTTP 409 (a transaction is already open on the branch — typically left by
    a prior run that died mid-flush) the dangling transaction is aborted and the
    open is retried once, so ingestion is self-healing across restarts.
    """
    r = requests.post(f"{base}/transactions", headers=auth,
                      json={"transactionType": "APPEND"}, timeout=_FOUNDRY_TIMEOUT_S)
    if r.status_code == 409:
        _abort_dangling(base, auth, label)
        r = requests.post(f"{base}/transactions", headers=auth,
                          json={"transactionType": "APPEND"}, timeout=_FOUNDRY_TIMEOUT_S)
    if not (200 <= r.status_code < 300):
        print(f"[Foundry] {label} open-transaction FAILED — "
              f"HTTP {r.status_code}: {(r.text or '').strip()[:300]}")
        return None
    txn = (r.json() or {}).get("rid")
    if not txn:
        print(f"[Foundry] {label} open-transaction returned no rid: "
              f"{(r.text or '').strip()[:200]}")
    return txn


def _ingest(rid_env_var: str, rows: list, label: str) -> bool:
    """Land a batch of rows via open transaction → upload CSV → commit.

    Returns True on a committed batch, False on any failure (aborting the open
    transaction so the dataset branch isn't left blocked). Never raises — a
    caller on the flush thread can't crash the process.
    """
    if not rows:
        return True

    url, token, rid = _foundry_config(rid_env_var)
    if not (url and token and rid):
        missing = [n for n, v in (("FOUNDRY_URL", url), ("FOUNDRY_TOKEN", token),
                                  (rid_env_var, rid)) if not v]
        print(f"[Foundry] {label} batch skipped — missing {', '.join(missing)} "
              f"({len(rows)} row(s) dropped)")
        return False

    base = f"{url}/api/v1/datasets/{rid}"
    auth = {"Authorization": f"Bearer {token}"}
    txn = None
    try:
        # 1) open an APPEND transaction (self-healing if a prior run left one open)
        txn = _open_transaction(base, auth, label)
        if not txn:
            return False

        # 2) upload the batch as a single CSV file inside the transaction
        fname = f"{label}/{int(time.time() * 1000)}_{uuid.uuid4().hex}.csv"
        enc = urllib.parse.quote(fname, safe="")
        up = requests.post(
            f"{base}/files:upload?filePath={enc}&transactionRid={txn}",
            headers={**auth, "Content-Type": "application/octet-stream"},
            data=_rows_to_csv(rows), timeout=_FOUNDRY_TIMEOUT_S)
        if not (200 <= up.status_code < 300):
            print(f"[Foundry] {label} upload FAILED — "
                  f"HTTP {up.status_code}: {(up.text or '').strip()[:300]}")
            _abort(base, auth, txn, label)
            return False

        # 3) commit
        cm = requests.post(f"{base}/transactions/{txn}/commit", headers=auth,
                           timeout=_FOUNDRY_TIMEOUT_S)
        if not (200 <= cm.status_code < 300):
            print(f"[Foundry] {label} commit FAILED — "
                  f"HTTP {cm.status_code}: {(cm.text or '').strip()[:300]}")
            _abort(base, auth, txn, label)
            return False

        print(f"[Foundry] {label} committed {len(rows)} row(s) (txn ...{txn[-12:]})")
        return True
    except requests.RequestException as e:
        print(f"[Foundry] {label} ingest FAILED — request error: {e}")
        if txn:
            _abort(base, auth, txn, label)
        return False


class _DatasetBatch:
    """Thread-safe buffer of rows for one dataset, flushed via _ingest."""

    def __init__(self, rid_env_var: str, label: str):
        self.rid_env_var = rid_env_var
        self.label = label
        self._rows = []
        self._buf_lock = threading.Lock()
        self._ingest_lock = threading.Lock()  # one open txn per branch at a time

    def add(self, row: dict):
        with self._buf_lock:
            self._rows.append(row)
            over = len(self._rows) >= _BATCH_MAX_ROWS
        if over:
            # Don't flush inline: add() runs on the producer (WS hot-path) thread,
            # and a flush does blocking HTTP (open→upload→commit). Wake the
            # background flush thread instead so the frame loop is never blocked
            # (foundary-task.md: a Foundry write must never delay the WS send).
            _flush_now.set()

    def flush(self) -> bool:
        # Serialize ingests for this dataset: Foundry allows only one open
        # transaction per branch, so two overlapping flushes would 409.
        with self._ingest_lock:
            with self._buf_lock:
                rows, self._rows = self._rows, []
            return _ingest(self.rid_env_var, rows, self.label)


_telemetry_batch = _DatasetBatch("TELEMETRY_DATASET_RID", "telemetry")
_detection_batch = _DatasetBatch("DETECTION_DATASET_RID", "detection")
_BATCHES = (_telemetry_batch, _detection_batch)

_flusher_started = False
_flusher_lock = threading.Lock()
# Set by a batch that has hit its size cap to force an early flush without
# blocking the producer thread that filled it.
_flush_now = threading.Event()


def _flush_loop():
    while True:
        # Wake on the interval OR as soon as a batch signals it is full.
        _flush_now.wait(_FLUSH_INTERVAL_S)
        _flush_now.clear()
        for batch in _BATCHES:
            batch.flush()


def start_foundry_flusher():
    """Start the background flush thread once (idempotent). Called by the
    producer when the Foundry sink is enabled."""
    global _flusher_started
    if _flusher_started:
        return
    with _flusher_lock:
        if not _flusher_started:
            threading.Thread(target=_flush_loop, daemon=True,
                             name="foundry-flush").start()
            _flusher_started = True


def flush_all() -> bool:
    """Flush every buffered batch now (shutdown / tests). True if all succeeded."""
    return all(batch.flush() for batch in _BATCHES)


atexit.register(flush_all)  # best-effort final flush of the last partial batch


def write_telemetry(row: dict) -> bool:
    """Enqueue one telemetry row for batched ingestion. Non-blocking; True once
    buffered (the actual commit happens on the flush thread)."""
    _telemetry_batch.add(row)
    return True


def write_detection(row: dict) -> bool:
    """Enqueue one detection row for batched ingestion. Non-blocking; True once
    buffered (the actual commit happens on the flush thread)."""
    _detection_batch.add(row)
    return True


class DualSinkSender:
    """Broadcasts each DronePacket to the dashboard over the WebSocket loop.

    The Foundry sink is no longer driven from here — the producer writes
    telemetry/detection rows directly (see producer.drone_producer). The
    ``foundry_enabled`` flag is retained so the producer and main can gate those
    writes and report status.
    """

    def __init__(self, ws_loop, foundry_enabled: bool = None):
        self.ws_loop = ws_loop
        # Imported lazily to keep this module importable without config.
        from .. import config
        self.foundry_enabled = (
            config.FOUNDRY_ENABLED if foundry_enabled is None else foundry_enabled
        )

    def send(self, packet):
        # PRIMARY — WebSocket broadcast onto the running asyncio loop. Keep the
        # Future and log any exception, so failures on the critical primary sink
        # aren't silently swallowed.
        future = asyncio.run_coroutine_threadsafe(broadcast(packet), self.ws_loop)
        future.add_done_callback(_log_broadcast_error)


def _log_broadcast_error(future):
    try:
        future.result()
    except Exception as e:  # noqa: BLE001 — diagnostic only, must not raise
        print(f"[WS] Broadcast failed: {e}")
