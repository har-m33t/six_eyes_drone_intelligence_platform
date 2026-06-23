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
 * Bounding a held key — "exactly one frame per press" (review BUG D2-1)
 * --------------------------------------------------------------------
 * The DOM event loop is single-threaded, so there is no true concurrency, but
 * holding `K` can flood the socket with KILL frames. Two independent platforms
 * produce auto-repeat differently and the hook must bound BOTH:
 *   • Windows / macOS / Chromium: a held key fires a *keydown burst* with NO
 *     interleaved keyup, and (usually) `event.repeat === true`.
 *   • X11 / Linux: auto-repeat synthesises a `keyup`+`keydown` pair for every
 *     repeat and frequently does NOT set `event.repeat`.
 * An earlier design released a per-press latch on `keyup`, which the X11 keyup
 * defeated — so the original "exactly once" guarantee did not hold there. This
 * version guards on two orthogonal facts instead:
 *   1. PRESS TRANSITION — a `pressed` set tracks physically-down kill keys, so a
 *      keydown burst with no keyup (Windows/macOS) fires only on the up→down edge.
 *   2. TIME DEBOUNCE — re-fires within `killDebounceMs` of the last dispatch are
 *      dropped, which bounds the X11 keyup/keydown flood the press-set can't see.
 * `keyup` only clears the pressed set (keyed on the RAW event key, never on a
 * re-read of `killKey`), so reconfiguring `killKey` mid-press can no longer wedge
 * the switch (review BUG D2-2).
 *
 * Text entry: the binding is suppressed while focus is in an editable element
 * (input / textarea / contenteditable / select), so typing a "k" into the
 * (future) deploy-notes field never kills a drone.
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
/**
 * Default minimum gap between two kill dispatches. Long enough to swallow an
 * auto-repeat burst (typical repeat rate is 30–60 ms) yet short enough that a
 * deliberate second press feels instant.
 */
const DEFAULT_KILL_DEBOUNCE_MS = 300;

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
   * Minimum milliseconds between two kill dispatches. Re-fires inside this window
   * are dropped, which bounds auto-repeat floods on every platform regardless of
   * whether the OS emits interleaved `keyup`s. Defaults to 300 ms.
   */
  killDebounceMs?: number;
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

  // Physically-down kill keys (lower-cased). Lets a keydown burst with no keyup
  // fire only on the up→down edge — the press-transition half of the D2-1 fix.
  const pressedRef = useRef<Set<string>>(new Set());
  // Timestamp (ms) of the last dispatched kill, for the debounce half of D2-1.
  const lastFireRef = useRef<number>(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const {
        enabled = true,
        killKey = DEFAULT_KILL_KEY,
        killTarget = DEFAULT_KILL_TARGET,
        killDebounceMs = DEFAULT_KILL_DEBOUNCE_MS,
        service = webSocketService,
        onKill,
      } = optionsRef.current;

      if (!enabled) return;
      // Ignore explicit auto-repeat, text-entry contexts, and modifier combos so
      // we never shadow browser/OS shortcuts (Ctrl/Cmd/Alt + K).
      if (event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      const key = event.key.toLowerCase();
      if (key !== killKey.toLowerCase()) return;

      // PRESS TRANSITION: already physically down ⇒ this is an auto-repeat
      // keydown with no interleaved keyup (Windows/macOS). Drop it.
      if (pressedRef.current.has(key)) return;
      pressedRef.current.add(key);

      // TIME DEBOUNCE: bounds the X11 keyup/keydown auto-repeat shape that the
      // press set can't catch, and any other rapid re-fire.
      const now = Date.now();
      if (now - lastFireRef.current < killDebounceMs) return;
      lastFireRef.current = now;

      event.preventDefault();
      const sent = service.sendCommand('KILL_DRONE', { drone_id: killTarget });
      onKill?.(killTarget, sent);
    };

    // Clear the physically-down flag on release. Keyed on the RAW event key (not
    // a re-read of `killKey`), so changing `killKey` mid-press cannot wedge the
    // switch (BUG D2-2). `blur` clears everything in case a keyup is missed
    // while the window is unfocused.
    const handleKeyUp = (event: KeyboardEvent): void => {
      pressedRef.current.delete(event.key.toLowerCase());
    };
    const handleBlur = (): void => {
      pressedRef.current.clear();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);
}

export default useKeyboardControls;
