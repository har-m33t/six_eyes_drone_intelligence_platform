/**
 * SIX-EYES global keyboard controls (Module D · Task D2)
 * ------------------------------------------------------
 * A single global `keydown` listener that maps presentation hot-keys to outbound
 * WebSocket commands. Right now it owns exactly one binding — the demo "kill
 * switch":
 *
 *   K  →  webSocketService.sendCommand('KILL_DRONE', { drone_id: 'DRONE_3' })
 *
 * This is a rehearsed presentation control (README §9 "signal-lost" scenario):
 * the operator presses `K` on stage to force a drone OFFLINE and trigger the
 * SIGNAL-LOST overlay (Task C2) live, without touching the producer.
 *
 * "Thread-safe" in a browser
 * --------------------------
 * The DOM event loop is single-threaded, so there is no true concurrency to
 * guard against — but the spec's "thread-safe target frame" intent maps onto two
 * real hazards we DO defend against here:
 *   1. Key auto-repeat: holding `K` fires `keydown` continuously. We drop
 *      `event.repeat` frames AND re-entrancy is impossible because we send
 *      exactly once per physical press (see the `inFlight` latch below), so a
 *      single press never floods the socket with dozens of KILL frames.
 *   2. Text entry: the binding is suppressed while focus is in an editable
 *      element (input / textarea / contenteditable / select), so typing a "k"
 *      into the (future) deploy-notes field never kills a drone.
 *
 * Module-D decoupling
 * -------------------
 * The hook talks ONLY to the Module-A `webSocketService` singleton (the same
 * `.sendCommand(cmd, payload)` surface Task D1 uses for DEPLOY SWARM). It holds
 * no React state and renders nothing — it is an orchestrator hook, per the
 * Module D interface contract, so it can be dropped into any top-level component
 * (e.g. `App`/`main.tsx`) to wire the key handlers without layout impact.
 */

import { useEffect, useRef } from 'react';
import type { DroneId } from '../types/telemetry';
import { webSocketService, type WebSocketService } from '../services/websocket';

// ──────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────

/** Default kill-switch binding for the live demo: `K` → `DRONE_3`. */
const DEFAULT_KILL_KEY = 'k';
const DEFAULT_KILL_TARGET: DroneId = 'DRONE_3';

export interface KeyboardControlsOptions {
  /**
   * Master switch — set `false` to suspend all bindings (e.g. while a modal owns
   * the keyboard). Defaults to `true`.
   */
  enabled?: boolean;
  /**
   * Key (matched case-insensitively against `KeyboardEvent.key`) that fires the
   * kill switch. Defaults to `'k'`.
   */
  killKey?: string;
  /** Drone the kill switch targets. Defaults to `DRONE_3` (the rehearsed demo). */
  killTarget?: DroneId;
  /**
   * Service override — defaults to the global `webSocketService` singleton.
   * Injectable so the hook can be unit-tested against a fake sender without
   * touching the real socket.
   */
  service?: WebSocketService;
  /**
   * Optional side-channel fired AFTER a kill frame is dispatched (e.g. to flash
   * a banner / log to the intel panel). Receives the targeted drone id and
   * whether the frame went out immediately (`true`) or was queued for the next
   * reconnect (`false`, mirroring `sendCommand`'s return).
   */
  onKill?: (target: DroneId, sent: boolean) => void;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * True when the event originates from an element that legitimately consumes
 * keystrokes, so a hot-key must NOT hijack it. Covers `<input>`, `<textarea>`,
 * `<select>`, and any `contenteditable` host.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

// ──────────────────────────────────────────────────────────────────────────
// Hook
// ──────────────────────────────────────────────────────────────────────────

/**
 * Install the global presentation key bindings for the lifetime of the calling
 * component. Mount this once near the app root.
 *
 *   function App() {
 *     useKeyboardControls();            // K → KILL_DRONE DRONE_3
 *     return <DashboardShell … />;
 *   }
 *
 * The listener is attached to `window` on mount and removed on unmount. Option
 * changes are read through a ref, so updating `onKill`/`killTarget` never
 * detaches and re-attaches the listener (no missed keystrokes mid-press).
 */
export function useKeyboardControls(options: KeyboardControlsOptions = {}): void {
  // Latest options, read live inside the (stable) listener so we can keep a
  // single long-lived handler instead of re-binding on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Per-press latch: set on the keydown that sends a frame, cleared on keyup
  // (or blur). Guarantees ONE kill frame per physical press even if the browser
  // somehow delivers a non-`repeat` keydown burst.
  const inFlightRef = useRef(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const {
        enabled = true,
        killKey = DEFAULT_KILL_KEY,
        killTarget = DEFAULT_KILL_TARGET,
        service = webSocketService,
        onKill,
      } = optionsRef.current;

      if (!enabled) return;
      // Ignore auto-repeat, text-entry contexts, and modifier combos so we never
      // shadow browser/OS shortcuts (Ctrl/Cmd/Alt + K).
      if (event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (event.key.toLowerCase() !== killKey.toLowerCase()) return;

      // One frame per press: bail if this press already fired.
      if (inFlightRef.current) return;
      inFlightRef.current = true;

      event.preventDefault();
      const sent = service.sendCommand('KILL_DRONE', { drone_id: killTarget });
      onKill?.(killTarget, sent);
    };

    // Release the latch when the key comes up (or focus leaves the window mid-
    // press) so the NEXT deliberate press can fire again.
    const releaseLatch = (event: KeyboardEvent): void => {
      const { killKey = DEFAULT_KILL_KEY } = optionsRef.current;
      if (event.key.toLowerCase() === killKey.toLowerCase()) {
        inFlightRef.current = false;
      }
    };
    const clearLatch = (): void => {
      inFlightRef.current = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', releaseLatch);
    window.addEventListener('blur', clearLatch);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', releaseLatch);
      window.removeEventListener('blur', clearLatch);
    };
  }, []);
}

export default useKeyboardControls;
