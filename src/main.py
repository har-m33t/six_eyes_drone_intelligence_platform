"""Entry point: starts the WebSocket server on its own asyncio loop, wires up
the DualSinkSender, and launches the six producer threads.

Run with:  python -m src.main   (or python src/main.py)
"""
import asyncio
import threading
import time

from . import config
from .producer import launch_producers
from .transport.foundry_client import DualSinkSender
from .transport.websocket_server import serve_forever


def _run_ws_loop(loop):
    asyncio.set_event_loop(loop)
    loop.run_until_complete(serve_forever())


def main():
    # Run the asyncio WebSocket server in a dedicated thread and hand its loop
    # to the (synchronous) producer threads via run_coroutine_threadsafe.
    ws_loop = asyncio.new_event_loop()
    ws_thread = threading.Thread(target=_run_ws_loop, args=(ws_loop,), daemon=True)
    ws_thread.start()
    time.sleep(0.5)  # let the server bind before producers start broadcasting

    sender = DualSinkSender(ws_loop)
    print(f"[main] Foundry sink: {'enabled' if sender.foundry_enabled else 'disabled'}")

    launch_producers(sender)
    print("[main] Six drone producers running. Ctrl+C to stop.")

    try:
        time.sleep(config.MISSION_DURATION_S)
    except KeyboardInterrupt:
        print("\n[main] Mission ended by operator.")


if __name__ == "__main__":
    main()
