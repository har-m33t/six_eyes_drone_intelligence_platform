"""Entry point: starts the WebSocket server on its own asyncio loop, wires up
the DualSinkSender, and launches the six producer threads.

Run with:  python -m src.main   (or python src/main.py)
"""
import asyncio
import os
import sys
import threading
import time

# Support both invocations the docs advertise: `python -m src.main` (package
# context already set) and `python src/main.py` (run as a loose script, which
# has no package context). Putting the project root on sys.path and importing
# via the absolute `src` package makes the latter work too — without it the
# relative `from . import config` raises ImportError.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import config
from src.inference import warmup
from src.producer import launch_producers
from src.transport.foundry_client import DualSinkSender
from src.transport.websocket_server import serve_forever


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

    # Load + warm the shared YOLO model once, before producers start. Otherwise
    # the first-inference warmup lands on the first live frame of all six feeds
    # at once and leaves every dashboard tile blank for several seconds.
    print("[main] Loading detection model...")
    warmup()
    print("[main] Model ready.")

    launch_producers(sender)
    print("[main] Six drone producers running. Ctrl+C to stop.")

    try:
        time.sleep(config.MISSION_DURATION_S)
    except KeyboardInterrupt:
        print("\n[main] Mission ended by operator.")


if __name__ == "__main__":
    main()
