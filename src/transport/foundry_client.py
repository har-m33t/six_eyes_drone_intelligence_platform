"""Secondary transport: fire-and-forget Foundry REST push, plus the
DualSinkSender that fans each packet out to both sinks.

Design contract: the Foundry path must NEVER block or fail the WebSocket
path. It runs on its own short-lived thread and swallows all exceptions.
"""
import asyncio
import threading
from dataclasses import asdict

import requests

from .. import config
from .websocket_server import broadcast


def push_to_foundry(packet):
    """Fire-and-forget — runs in a background thread, never blocks the caller."""
    def _push():
        try:
            # Drop the base64 video frame: it's for the dashboard (WebSocket)
            # only. The telemetry dataset (README §4.4) has no video column, and
            # shipping frames over this REST POST would bloat it pointlessly.
            payload = {k: v for k, v in asdict(packet).items() if k != "frame_b64"}
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
            print(f"[Foundry] Push failed: {e}")

    threading.Thread(target=_push, daemon=True).start()


class DualSinkSender:
    """Fans a packet out to the WebSocket loop (primary) and Foundry (secondary)."""

    def __init__(self, ws_loop, foundry_enabled: bool = None):
        self.ws_loop = ws_loop
        self.foundry_enabled = (
            config.FOUNDRY_ENABLED if foundry_enabled is None else foundry_enabled
        )

    def send(self, packet):
        # PRIMARY — WebSocket broadcast onto the running asyncio loop.
        asyncio.run_coroutine_threadsafe(broadcast(packet), self.ws_loop)

        # SECONDARY — Foundry, async and best-effort.
        if self.foundry_enabled:
            push_to_foundry(packet)
