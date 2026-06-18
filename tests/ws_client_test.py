"""Manual WebSocket client: connect to the running server and print packets.

Usage:  python tests/ws_client_test.py
"""
import asyncio
import json

import websockets


async def main(uri="ws://localhost:8765"):
    async with websockets.connect(uri) as ws:
        print(f"Connected to {uri}. Waiting for packets...")
        async for message in ws:
            packet = json.loads(message)
            dets = len(packet.get("detections", []))
            health = packet.get("health", {})
            print(
                f"{packet['drone_id']} frame={packet['frame_idx']} "
                f"dets={dets} batt={health.get('battery')} "
                f"signal={health.get('signal')}"
            )


if __name__ == "__main__":
    asyncio.run(main())
