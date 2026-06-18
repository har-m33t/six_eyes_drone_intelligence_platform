"""Secondary transport: best-effort Foundry REST push, plus the DualSinkSender
that fans each packet out to both sinks.

Design contract: the Foundry path must NEVER block or fail the WebSocket path.
It runs on a single background worker draining a bounded queue and swallows all
exceptions. A bounded queue (drop-on-full) gives natural backpressure: Foundry
is the best-effort secondary sink, so shedding telemetry under load is correct
and keeps the enqueue non-blocking.
"""
import asyncio
import queue
import threading
import time
from dataclasses import asdict

import requests

from .. import config
from .websocket_server import broadcast

# Bounded backlog of telemetry payloads awaiting POST. Sized for a few seconds
# of six-drone traffic (~150-180 packets/s). On overflow we drop rather than
# block, because the WebSocket path (primary) must never be stalled by Foundry.
_QUEUE_MAXSIZE = 512
_ERROR_LOG_INTERVAL_S = 10  # throttle identical failure spam to one line / 10s


class _FoundryWorker:
    """A single daemon thread that drains the payload queue and POSTs to Foundry.

    Replaces the old thread-per-packet model, which spawned ~150-180 threads/sec
    across six drones and — against an unreachable host — piled up hundreds of
    concurrent 5s-blocking requests while flooding the console with one failure
    line per packet.
    """

    def __init__(self):
        self._q = queue.Queue(maxsize=_QUEUE_MAXSIZE)
        self._thread = None
        self._start_lock = threading.Lock()
        self._dropped = 0
        self._last_error_log = 0.0

    def submit(self, payload):
        """Non-blocking enqueue; drops under backpressure, never blocks."""
        self._ensure_started()
        try:
            self._q.put_nowait(payload)
        except queue.Full:
            self._dropped += 1  # shed telemetry rather than stall the caller

    def _ensure_started(self):
        if self._thread is not None:
            return
        with self._start_lock:
            if self._thread is None:
                t = threading.Thread(target=self._run, daemon=True,
                                     name="foundry-worker")
                t.start()
                self._thread = t

    def _run(self):
        while True:
            payload = self._q.get()
            try:
                requests.post(
                    f"{config.FOUNDRY_URL}/api/v1/datasets/{config.DATASET_RID}/transactions",
                    headers={
                        "Authorization": f"Bearer {config.FOUNDRY_TOKEN}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                    timeout=5,
                )
            except Exception as e:  # noqa: BLE001 — secondary sink must not crash producer
                self._log_error(e)

    def _log_error(self, e):
        now = time.time()
        if now - self._last_error_log < _ERROR_LOG_INTERVAL_S:
            return
        dropped = f" ({self._dropped} dropped under backpressure)" if self._dropped else ""
        print(f"[Foundry] Push failing: {e}{dropped}")
        self._last_error_log = now


_worker = _FoundryWorker()


def push_to_foundry(packet):
    """Best-effort: enqueue a packet's telemetry for the background Foundry worker.

    Drops the base64 video frame: it's for the dashboard (WebSocket) only. The
    telemetry dataset (README §4.4) has no video column, and shipping frames over
    this REST POST would bloat it pointlessly. Non-blocking: never blocks or fails
    the WebSocket path.
    """
    payload = {k: v for k, v in asdict(packet).items() if k != "frame_b64"}
    _worker.submit(payload)


class DualSinkSender:
    """Fans a packet out to the WebSocket loop (primary) and Foundry (secondary)."""

    def __init__(self, ws_loop, foundry_enabled: bool = None):
        self.ws_loop = ws_loop
        self.foundry_enabled = (
            config.FOUNDRY_ENABLED if foundry_enabled is None else foundry_enabled
        )

    def send(self, packet):
        # PRIMARY — WebSocket broadcast onto the running asyncio loop. Keep the
        # Future and log any exception, so failures on the critical primary sink
        # aren't silently swallowed.
        future = asyncio.run_coroutine_threadsafe(broadcast(packet), self.ws_loop)
        future.add_done_callback(_log_broadcast_error)

        # SECONDARY — Foundry, async and best-effort.
        if self.foundry_enabled:
            push_to_foundry(packet)


def _log_broadcast_error(future):
    try:
        future.result()
    except Exception as e:  # noqa: BLE001 — diagnostic only, must not raise
        print(f"[WS] Broadcast failed: {e}")
