"""Transport-layer behavior: broadcast failures on the primary sink must be
surfaced (logged), not silently swallowed.
"""
from concurrent.futures import Future

from src.transport import foundry_client


def test_log_broadcast_error_reports_failure(capsys):
    fut = Future()
    fut.set_exception(RuntimeError("ws down"))
    foundry_client._log_broadcast_error(fut)  # must not raise
    out = capsys.readouterr().out
    assert "Broadcast failed" in out
    assert "ws down" in out


def test_log_broadcast_error_silent_on_success(capsys):
    fut = Future()
    fut.set_result(None)
    foundry_client._log_broadcast_error(fut)
    assert "Broadcast failed" not in capsys.readouterr().out
