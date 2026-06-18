"""Primary transport: asyncio WebSocket server that broadcasts every packet
to all connected dashboard clients.

The producer threads are synchronous; they reach this asyncio loop via
asyncio.run_coroutine_threadsafe() in foundry_client.DualSinkSender.
"""
import asyncio
import json
from dataclasses import asdict

import websockets

from .. import config

CLIENTS = set()


async def register(websocket):
    CLIENTS.add(websocket)
    try:
        await websocket.wait_closed()
    finally:
        CLIENTS.discard(websocket)


async def broadcast(packet):
    if CLIENTS:
        message = json.dumps(asdict(packet))
        await asyncio.gather(
            *[client.send(message) for client in CLIENTS],
            return_exceptions=True,
        )


async def serve_forever(host: str = None, port: int = None):
    host = host or config.WS_HOST
    port = port or config.WS_PORT
    async with websockets.serve(register, host, port):
        print(f"[WS] Serving on ws://{host}:{port}")
        await asyncio.Future()  # run forever
