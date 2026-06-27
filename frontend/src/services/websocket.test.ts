/**
 * Module A · Task A3 — WebSocket service tests.
 *
 * Drives the service against a controllable fake WebSocket (jsdom has none).
 * Covers lifecycle, exponential backoff + jitter, the offline command queue,
 * store wiring, and adversarial cases — including the stale-socket race
 * (A3-1, now fixed): connect() tears down any lingering CLOSING socket so its
 * delayed onclose can no longer orphan a newer socket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waitFor } from '@testing-library/dom';
import { WebSocketService } from './websocket';
import { useSwarmStore } from '../store/useSwarmStore';

// ── Controllable fake WebSocket ──────────────────────────────────────────────
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closeCalls++;
    this.readyState = MockWebSocket.CLOSING;
  }
  // ── test drivers ──
  drvOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  drvMessage(data: unknown) {
    this.onmessage?.({ data });
  }
  drvClose(code = 1006) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }
  drvError() {
    this.onerror?.();
  }
}

const last = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];

beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as any).WebSocket = MockWebSocket;
  useSwarmStore.setState({ connection: 'connecting' } as any, false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('connect() opens one socket and goes live on open', () => {
    const svc = new WebSocketService({ url: 'ws://x' });
    svc.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(svc.getStatus()).toBe('connecting');
    last().drvOpen();
    expect(svc.getStatus()).toBe('live');
    expect(useSwarmStore.getState().connection).toBe('live');
  });

  it('connect() is idempotent while OPEN/CONNECTING', () => {
    const svc = new WebSocketService({ url: 'ws://x' });
    svc.connect();
    svc.connect(); // still CONNECTING → no second socket
    last().drvOpen();
    svc.connect(); // OPEN → no third socket
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('disconnect() closes the socket and suppresses reconnect', () => {
    vi.useFakeTimers();
    const svc = new WebSocketService({ url: 'ws://x' });
    svc.connect();
    last().drvOpen();
    svc.disconnect();
    expect(svc.getStatus()).toBe('closed');
    last().drvClose(); // a stray close after manual disconnect
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1); // no reconnect
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Inbound → store
// ──────────────────────────────────────────────────────────────────────────

describe('inbound message handling', () => {
  it('routes a drone frame into the store', () => {
    const svc = new WebSocketService({ url: 'ws://x' });
    svc.connect();
    last().drvOpen();
    last().drvMessage(
      JSON.stringify({
        drone_id: 'DRONE_1',
        timestamp: 1,
        frame_idx: 0,
        detections: [],
        gps: { lat: 1, lng: 2, lon: 2, alt: 0 },
        health: { battery: 90, signal: 'STRONG', status: 'ONLINE', speed_ms: 0, temp_c: 30 },
        mission: { zone: 'ALPHA', coverage_pct: 0, elapsed_s: 0 },
      }),
    );
    expect(useSwarmStore.getState().drones.DRONE_1).toBeDefined();
  });

  it('ignores non-JSON frames without throwing', () => {
    const svc = new WebSocketService({ url: 'ws://x' });
    svc.connect();
    last().drvOpen();
    expect(() => last().drvMessage('<<not json>>')).not.toThrow();
  });

  it('routes an ArrayBuffer JSON drone frame with frame_b64 into the store', async () => {
    const svc = new WebSocketService({ url: 'ws://x' });
    svc.connect();
    last().drvOpen();
    const raw = JSON.stringify({
      drone_id: 'DRONE_3',
      timestamp: 1,
      frame_idx: 12,
      detections: [],
      gps: { lat: 1, lng: 2, lon: 2, alt: 0 },
      health: { battery: 90, signal: 'STRONG', status: 'ONLINE', speed_ms: 0, temp_c: 30 },
      mission: { zone: 'CHARLIE', coverage_pct: 0, elapsed_s: 0 },
      frame_b64: 'QUJD',
    });
    last().drvMessage(new TextEncoder().encode(raw).buffer);
    await waitFor(() => {
      expect(useSwarmStore.getState().drones.DRONE_3?.frame_b64).toBe('QUJD');
    });
  });

  it('routes a Blob JSON drone frame with frame_b64 into the store', async () => {
    const svc = new WebSocketService({ url: 'ws://x' });
    svc.connect();
    last().drvOpen();
    const raw = JSON.stringify({
      drone_id: 'DRONE_4',
      timestamp: 1,
      frame_idx: 13,
      detections: [],
      gps: { lat: 1, lng: 2, lon: 2, alt: 0 },
      health: { battery: 90, signal: 'STRONG', status: 'ONLINE', speed_ms: 0, temp_c: 30 },
      mission: { zone: 'DELTA', coverage_pct: 0, elapsed_s: 0 },
      frame_b64: 'REVG',
    });
    last().drvMessage(new Blob([raw], { type: 'application/json' }));
    await waitFor(() => {
      expect(useSwarmStore.getState().drones.DRONE_4?.frame_b64).toBe('REVG');
    });
  });

  // A malformed-but-JSON frame makes the store's ingest throw; the service must
  // swallow it so the socket loop keeps running (BUG A2-1 is contained here).
  it('survives a store fault on a malformed frame (socket stays usable)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const svc = new WebSocketService({ url: 'ws://x' });
    svc.connect();
    last().drvOpen();
    expect(() => last().drvMessage(JSON.stringify({ drone_id: 'DRONE_1' }))).not.toThrow();
    // socket still OPEN and a subsequent good frame is processed
    last().drvMessage(
      JSON.stringify({
        drone_id: 'DRONE_2', timestamp: 1, frame_idx: 0, detections: [],
        gps: { lat: 1, lng: 2, lon: 2, alt: 0 },
        health: { battery: 90, signal: 'STRONG', status: 'ONLINE', speed_ms: 0, temp_c: 30 },
        mission: { zone: 'BRAVO', coverage_pct: 0, elapsed_s: 0 },
      }),
    );
    expect(useSwarmStore.getState().drones.DRONE_2).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Outbound queue
// ──────────────────────────────────────────────────────────────────────────

describe('outbound command queue', () => {
  it('sends immediately when OPEN', () => {
    const svc = new WebSocketService({ url: 'ws://x' });
    svc.connect();
    last().drvOpen();
    const ok = svc.sendCommand('KILL_DRONE', { drone_id: 'DRONE_3' });
    expect(ok).toBe(true);
    expect(JSON.parse(last().sent[0])).toEqual({ command: 'KILL_DRONE', drone_id: 'DRONE_3' });
  });

  it('queues while not OPEN and flushes in order on next open', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = new WebSocketService({ url: 'ws://x' });
    svc.connect(); // CONNECTING, not OPEN
    expect(svc.sendCommand('START_MISSION', { polygon: [[0, 0], [1, 0], [1, 1]] })).toBe(false);
    expect(svc.sendCommand('KILL_DRONE', { drone_id: 'DRONE_3' })).toBe(false);
    last().drvOpen();
    expect(last().sent.map((s) => JSON.parse(s).command)).toEqual(['START_MISSION', 'KILL_DRONE']);
  });

  it('bounds the queue to 32, dropping the oldest', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = new WebSocketService({ url: 'ws://x' });
    svc.connect();
    for (let i = 0; i < 40; i++) svc.sendCommand('KILL_DRONE', { drone_id: `DRONE_${i}` as any });
    last().drvOpen();
    expect(last().sent).toHaveLength(32);
    // oldest (DRONE_0..DRONE_7) dropped; first surviving is DRONE_8
    expect(JSON.parse(last().sent[0]).drone_id).toBe('DRONE_8');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Reconnection (exponential backoff + jitter)
// ──────────────────────────────────────────────────────────────────────────

describe('reconnection backoff', () => {
  it('grows base·2^n, capped, and reconnects through the timer', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter → 0 (deterministic)
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const svc = new WebSocketService({ url: 'ws://x', baseReconnectDelayMs: 1000, maxReconnectDelayMs: 30000 });
    svc.connect();
    last().drvOpen(); // attempts reset to 0

    last().drvClose(); // drop #1 → delay base·2^0 = 1000
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1000);
    expect(svc.getStatus()).toBe('reconnecting');

    vi.advanceTimersByTime(1000); // reconnect → new socket
    last().drvClose(); // drop #2 → 1000·2^1 = 2000
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 2000);

    vi.advanceTimersByTime(2000);
    last().drvClose(); // drop #3 → 4000
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 4000);
  });

  it('caps the delay at maxReconnectDelayMs', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const svc = new WebSocketService({ url: 'ws://x', baseReconnectDelayMs: 1000, maxReconnectDelayMs: 5000 });
    svc.connect();
    last().drvOpen();
    // force several drops; delay must never exceed the 5000 cap
    for (let i = 0; i < 6; i++) {
      last().drvClose();
      const calls = setTimeoutSpy.mock.calls;
      const lastDelay = calls[calls.length - 1][1] as number;
      expect(lastDelay).toBeLessThanOrEqual(5000);
      vi.advanceTimersByTime(lastDelay);
    }
  });

  it('error forces a close so a single backoff path owns reconnect', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = new WebSocketService({ url: 'ws://x' });
    svc.connect();
    const sock = last();
    sock.drvOpen();
    sock.drvError();
    expect(sock.closeCalls).toBe(1); // handleError → socket.close()
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ADVERSARIAL — stale-socket race
// ──────────────────────────────────────────────────────────────────────────

describe('adversarial / stale-socket race', () => {
  // A3-1 (FIXED): the connect() idempotency guard only short-circuits on
  // OPEN/CONNECTING, so it can still be entered while a previous socket is
  // CLOSING (the window after handleError's close() but before its onclose).
  // connect() now tears that lingering socket down first — detaching its four
  // handlers and closing it — before creating the new one. So the old socket's
  // delayed onclose is a no-op (handler detached) and can no longer null
  // `this.socket` (the new socket) nor schedule a spurious reconnect.
  // See websocket.ts connect() + teardownSocket().
  it('A3-1: a CLOSING socket\'s delayed onclose cannot orphan a newer socket', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const svc = new WebSocketService({ url: 'ws://x', baseReconnectDelayMs: 1000 });
    svc.connect();
    const sock0 = last(); // instance 0
    sock0.drvOpen();

    // error → handleError closes sock0 (now CLOSING) but onclose has NOT fired
    sock0.drvError();
    expect(sock0.readyState).toBe(MockWebSocket.CLOSING);

    // a consumer calls connect() during the CLOSING window. connect() tears
    // sock0 down (detaches handlers + closes it) and dials a fresh socket →
    // instance 1. attempts were reset on sock0's open, so this is a clean
    // 'connecting', not a 'reconnecting'.
    svc.connect();
    const sock1 = last();
    expect(sock1).not.toBe(sock0);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(svc.getStatus()).toBe('connecting');

    // NOW sock0's delayed onclose finally fires — but its handler was detached
    // by the teardown, so it is a no-op: this.socket (== sock1) is untouched and
    // NO reconnect is scheduled.
    sock0.drvClose();

    expect(svc.getStatus()).toBe('connecting'); // NOT 'reconnecting'
    vi.advanceTimersByTime(60_000);

    // No third socket; sock1 remains the single managed connection and was
    // never closed. sock0 was closed by the teardown (≥1 close call).
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(sock1.closeCalls).toBe(0);
    expect(sock0.closeCalls).toBeGreaterThanOrEqual(1);

    // sock1 is fully managed: opening it drives the store live as normal.
    sock1.drvOpen();
    expect(svc.getStatus()).toBe('live');
  });
});
