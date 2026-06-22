/**
 * Module A · Task A3 — WebSocket service tests.
 *
 * Drives the service against a controllable fake WebSocket (jsdom has none).
 * Covers lifecycle, exponential backoff + jitter, the offline command queue,
 * store wiring, and adversarial cases — including the stale-socket race
 * (BUG A3-1) where a CLOSING socket's delayed onclose orphans a newer socket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  onmessage: ((e: { data: string }) => void) | null = null;
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
  drvMessage(data: string) {
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
      const lastDelay = setTimeoutSpy.mock.calls.at(-1)![1] as number;
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
  // BUG A3-1: the connect() idempotency guard only short-circuits on
  // OPEN/CONNECTING, and handleClose/handleOpen never verify the event came from
  // the CURRENT socket. If connect() runs while a previous socket is still
  // CLOSING (the window after handleError's close() but before its onclose),
  // a new socket is created; the OLD socket's delayed onclose then nulls
  // `this.socket` (which now points at the NEW socket) and schedules yet another
  // reconnect — orphaning the live socket and leaking a connection.
  it('BUG A3-1: a CLOSING socket\'s delayed onclose orphans a newer socket', () => {
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

    // a consumer calls connect() during the CLOSING window (guard lets it
    // through because CLOSING is neither OPEN nor CONNECTING) → instance 1
    svc.connect();
    const sock1 = last();
    expect(sock1).not.toBe(sock0);
    expect(MockWebSocket.instances).toHaveLength(2);

    // NOW sock0's delayed onclose finally fires. A correct service would ignore
    // it (it is not the current socket). This one nulls this.socket (== sock1)
    // and schedules a reconnect.
    sock0.drvClose();

    // Symptom: a reconnect was scheduled even though sock1 is alive & connecting.
    expect(svc.getStatus()).toBe('reconnecting');
    vi.advanceTimersByTime(1000);

    // → a THIRD socket is spun up, and sock1 was never closed: it is leaked.
    expect(MockWebSocket.instances).toHaveLength(3);
    expect(sock1.closeCalls).toBe(0); // orphaned, still open, unmanaged
  });
});
