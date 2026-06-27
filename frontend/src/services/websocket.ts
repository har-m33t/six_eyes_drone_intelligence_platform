/**
 * SIX-EYES async WebSocket service (Module A · Task A3)
 * -----------------------------------------------------
 * A standalone connection manager that owns the entire socket lifecycle for the
 * dashboard:
 *
 *   • connect / disconnect                                          (lifecycle)
 *   • exponential-backoff reconnection with jitter                (resilience)
 *   • inbound frames mapped straight onto the Zustand store        (Module A·A2)
 *   • a type-safe outbound `.sendCommand(cmd, payload)` API       (Interface §19)
 *
 * Interface boundaries (parallel-migration contract)
 * --------------------------------------------------
 * This module is independent of React. It consumes exactly two contracts:
 *   • Task A1 (`../types/telemetry`) — the inbound `InboundPacket` shapes and the
 *     typed outbound command envelope (`CommandType` / `CommandPayload<C>`).
 *   • Task A2 (`../store/useSwarmStore`) — the write surface. Per A2's documented
 *     boundary, inbound frames are handed to `useSwarmStore.getState().ingest()`
 *     (which auto-routes drone vs. nav packets via A1's guard), and lifecycle
 *     changes drive `setConnection()`. The store is read fresh each call so a
 *     hot-reloaded store is never left stale.
 *
 * The Module-D consumers (`useDeploySwarm`, `useKeyboardControls`) drive the
 * outbound side through the `webSocketService` singleton's `.sendCommand()`.
 *
 * Reverse-engineered from the legacy `six_eyes_dashboard.html` `connect()` /
 * `ws.onmessage` block, preserving its reconnect-on-close and drone/nav
 * multiplexing behaviour.
 */

import type {
  CommandPayload,
  CommandType,
  InboundPacket,
} from '../types/telemetry';
import { useSwarmStore, type ConnectionStatus } from '../store/useSwarmStore';

// ──────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────

export interface WebSocketServiceOptions {
  /** Override the socket URL. Defaults to the runtime-config / localhost chain. */
  url?: string;
  /** First reconnect delay in ms (default 1000). */
  baseReconnectDelayMs?: number;
  /** Backoff ceiling in ms (default 30000). */
  maxReconnectDelayMs?: number;
}

const DEFAULT_WS_URL = 'ws://localhost:8765';
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;

/**
 * Resolve the socket URL the same way the legacy dashboard did: prefer the
 * server-generated runtime config (`window.SIX_EYES_CONFIG.WS_URL`), then fall
 * back to localhost. Read via a local cast off `globalThis` so this module never
 * augments the global `Window` type — Module B (`TacticalMap`) owns that
 * ambient declaration, and a second differing one would clash (TS2717).
 */
function resolveDefaultUrl(): string {
  const cfg = (globalThis as { SIX_EYES_CONFIG?: { WS_URL?: string } }).SIX_EYES_CONFIG;
  if (typeof cfg?.WS_URL === 'string' && cfg.WS_URL.length > 0) return cfg.WS_URL;
  return DEFAULT_WS_URL;
}

// ──────────────────────────────────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────────────────────────────────

export class WebSocketService {
  private readonly url: string;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;

  private socket: WebSocket | null = null;

  private status: ConnectionStatus = 'closed';
  /** Reconnect attempts since the last successful OPEN — drives backoff growth. */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by `disconnect()` so a deliberate close never schedules a reconnect. */
  private manualClose = false;

  /**
   * Commands issued while the socket is not OPEN are buffered here and flushed
   * in order on the next OPEN, so a `DEPLOY SWARM` fired during a reconnect blip
   * is not silently dropped (the Module-D consumers rely on this — they report
   * "QUEUED" rather than the legacy hard "WS OFFLINE" drop). Bounded so a socket
   * that never comes up cannot grow this without limit.
   */
  private readonly outboundQueue: string[] = [];
  private static readonly MAX_QUEUED_COMMANDS = 32;

  constructor(options: WebSocketServiceOptions = {}) {
    this.url = options.url ?? resolveDefaultUrl();
    this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_DELAY_MS;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Open the socket (idempotent — a no-op if already open/connecting). */
  connect(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    // A non-OPEN/CONNECTING socket may still be lingering in CLOSING state with
    // our handlers attached. Tear it down first so its late `onclose` can't null
    // out the new socket below and trigger a spurious extra reconnect.
    if (this.socket) {
      this.teardownSocket(this.socket);
      this.socket = null;
    }

    this.manualClose = false;
    this.clearReconnectTimer();
    this.setStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    try {
      this.socket = new WebSocket(this.url);
      // Python's `websockets` server normally sends text frames, but keeping the
      // browser in ArrayBuffer mode lets us decode any binary JSON frame instead
      // of silently dropping it before the video packet reaches the store.
      this.socket.binaryType = 'arraybuffer';
    } catch (err) {
      // The constructor throws on a malformed URL — treat like any drop so the
      // backoff loop keeps trying rather than wedging the dashboard.
      console.error('[WS] Failed to open socket:', err);
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = this.handleOpen;
    this.socket.onclose = this.handleClose;
    this.socket.onerror = this.handleError;
    this.socket.onmessage = this.handleMessage;
  }

  /** Close the socket and stop reconnecting. Safe to call repeatedly. */
  disconnect(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    // A deliberate disconnect discards buffered commands — they belong to the
    // session being torn down and must not silently replay on a later connect().
    this.outboundQueue.length = 0;

    if (this.socket) {
      this.teardownSocket(this.socket);
      this.socket = null;
    }
    this.setStatus('closed');
  }

  /** Current lifecycle state (mirrors what the store last received). */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  /**
   * Send a typed command over the socket, serialised as the legacy flat
   * `{ command, ...payload }` envelope the Python router reads top-level
   * (`websocket_server._dispatch_command`). Type-safe per command:
   *   sendCommand('START_MISSION', { polygon })
   *   sendCommand('KILL_DRONE',    { drone_id })
   *
   * Returns true if sent immediately, false if the socket was not OPEN — in
   * which case the frame is queued and flushed on the next OPEN.
   */
  sendCommand<C extends CommandType>(command: C, payload: CommandPayload<C>): boolean {
    const frame = JSON.stringify({ command, ...payload });

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(frame);
      return true;
    }

    if (this.outboundQueue.length >= WebSocketService.MAX_QUEUED_COMMANDS) {
      this.outboundQueue.shift(); // drop the oldest to bound memory
    }
    this.outboundQueue.push(frame);
    console.warn(`[WS] Socket not open; queued command ${command} (will send on reconnect).`);
    return false;
  }

  // ── Socket event handlers (bound as arrow fns to preserve `this`) ───────────

  private handleOpen = (): void => {
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.setStatus('live');
    this.flushOutboundQueue();
  };

  private handleClose = (event: CloseEvent): void => {
    this.socket = null;
    if (this.manualClose) return; // deliberate disconnect() — stay closed
    console.warn(`[WS] Connection closed (code ${event.code}); scheduling reconnect.`);
    this.scheduleReconnect();
  };

  private handleError = (): void => {
    // The browser fires `error` then `close`; force a close so a single backoff
    // path (handleClose) owns reconnection, mirroring the legacy `ws.close()`.
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
    }
  };

  private handleMessage = (event: MessageEvent): void => {
    const data = event.data;
    if (typeof data === 'string') {
      this.ingestRawMessage(data);
      return;
    }

    void this.decodeMessageData(data)
      .then((raw) => {
        if (raw !== null) this.ingestRawMessage(raw);
      })
      .catch((err) => {
        console.warn('[WS] Ignoring unreadable server message.', err);
      });
  };

  private ingestRawMessage(raw: string): void {
    let packet: InboundPacket;
    try {
      packet = JSON.parse(raw) as InboundPacket;
    } catch {
      console.warn('[WS] Ignoring non-JSON server message.');
      return;
    }
    if (typeof packet !== 'object' || packet === null) return;

    // Hand straight to the A2 store, which auto-routes drone vs. nav frames via
    // A1's `isNavTelemetry` guard. A store fault must never kill the socket loop.
    try {
      useSwarmStore.getState().ingest(packet);
    } catch (err) {
      console.error('[WS] Store rejected packet:', err);
    }
  }

  private async decodeMessageData(data: unknown): Promise<string | null> {
    if (isArrayBufferLike(data) || ArrayBuffer.isView(data)) {
      return new TextDecoder().decode(data);
    }
    if (isBlobLike(data)) {
      if (typeof data.text === 'function') return data.text();
      if (typeof data.arrayBuffer === 'function') {
        return new TextDecoder().decode(await data.arrayBuffer());
      }
      return readBlobAsText(data);
    }
    console.warn('[WS] Ignoring unsupported server message type.');
    return null;
  }

  // ── Reconnection (exponential backoff + jitter) ─────────────────────────────

  private scheduleReconnect(): void {
    if (this.manualClose || this.reconnectTimer !== null) return;

    const delay = this.nextReconnectDelay();
    this.reconnectAttempts += 1;
    this.setStatus('reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Exponential backoff: base · 2^attempts, capped at the ceiling, with ±20%
   * full jitter so a fleet of reconnecting clients does not stampede the server
   * in lockstep. The result is clamped to `[0, maxReconnectDelayMs]` so positive
   * jitter at the ceiling can never push the delay past it.
   */
  private nextReconnectDelay(): number {
    const exponential = this.baseReconnectDelayMs * 2 ** this.reconnectAttempts;
    const capped = Math.min(exponential, this.maxReconnectDelayMs);
    const jitter = capped * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.round(capped + jitter);
    return Math.min(this.maxReconnectDelayMs, Math.max(0, delay));
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private flushOutboundQueue(): void {
    while (this.outboundQueue.length > 0) {
      // Re-check liveness each iteration: a send() can synchronously transition
      // the socket out of OPEN, so peek-then-shift avoids dropping the frame we
      // could not send (it stays queued for the next OPEN).
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      const frame = this.outboundQueue[0];
      this.socket.send(frame);
      this.outboundQueue.shift();
    }
  }

  /** Detach our handlers from a socket and close it. Used by connect/disconnect. */
  private teardownSocket(socket: WebSocket): void {
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try {
      socket.close();
    } catch {
      /* already closing/closed — nothing to do */
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    try {
      useSwarmStore.getState().setConnection(status);
    } catch (err) {
      console.error('[WS] Store rejected connection status:', err);
    }
  }
}

function isArrayBufferLike(data: unknown): data is ArrayBuffer {
  return Object.prototype.toString.call(data) === '[object ArrayBuffer]';
}

type BlobLike = Blob & {
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

function isBlobLike(data: unknown): data is BlobLike {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { size?: unknown }).size === 'number' &&
    typeof (data as { type?: unknown }).type === 'string'
  );
}

function readBlobAsText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(blob);
  });
}

/**
 * Process-wide singleton — the global instance the rest of the app imports
 * (Module A interface contract). The app root wires it up:
 *
 *   import { webSocketService } from '../services/websocket';
 *   webSocketService.connect();   // store actions are called via getState()
 */
export const webSocketService = new WebSocketService();
