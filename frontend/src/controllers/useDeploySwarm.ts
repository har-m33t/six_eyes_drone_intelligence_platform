/**
 * Deploy-Swarm command integration (Module D · Task D1)
 * -----------------------------------------------------
 * The controller glue that wires the user-facing DEPLOY SWARM action to the
 * network layer. It is the orchestrator hook the Module-D interface contract
 * calls for: it links Module B (the Mapbox Draw polygon) to Module A (the
 * WebSocket command sender) without either side knowing about the other.
 *
 * Data path (strict interface boundaries — nothing reaches across them):
 *   Module B  ──onPerimeterDrawn([lng,lat]…)──▶  useDeploySwarm (here)
 *   useDeploySwarm  ──sendCommand('START_MISSION',{polygon})──▶  Module A
 *
 * This hook owns ONLY:
 *   • the latest drawn perimeter (fed in via the B-contract callback),
 *   • the derived button/hint UI state (mirrors legacy `refreshDeployControls`),
 *   • dispatching the START_MISSION envelope (mirrors legacy `deploySwarm`).
 * It does NOT touch Mapbox internals — it drives DRAW/CLEAR through the
 * `MapboxDrawHandle` (Module B's exported imperative handle) only.
 *
 * Reverse-engineered from `six_eyes_dashboard.html` §"Deploy Swarm: polygon
 * drawing + mission dispatch" (`getMissionPolygon` / `refreshDeployControls` /
 * `flashHint` / `deploySwarm`).
 *
 * Review fixes (2026-06-22, `.claude/module_d_review.md`):
 *   • D1-1: CLEAR always wipes coverage (was wrongly gated by the deploy flag).
 *   • D1-2: the enable-gate and `deploy()` now read the SAME polygon source, so
 *     the button can never be enabled while `deploy()` would refuse.
 *   • D1-3: every coordinate is validated finite before sending, so a junk
 *     polygon no longer reports a false "MISSION SENT".
 *   • D1-4: DEPLOY disarms after a successful send until the geometry changes,
 *     preventing an accidental double-dispatch of the same mission.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LngLat } from '../types/telemetry';
import type { MapboxDrawHandle } from '../map/useMapboxDraw';
import { webSocketService, type WebSocketService } from '../services/websocket';
import { useSwarmStore } from '../store/useSwarmStore';

// ──────────────────────────────────────────────────────────────────────────
// Public shape
// ──────────────────────────────────────────────────────────────────────────

/** Minimum vertices for a valid search polygon (legacy `enough = >= 3`). */
export const MIN_MISSION_VERTICES = 3;

/** How long an error/notice flash persists before reverting (legacy 1800ms). */
const FLASH_DURATION_MS = 1800;

/** Visual state of the deploy hint, mapped 1:1 to the legacy CSS modifiers. */
export type DeployHintState = 'idle' | 'armed' | 'error';

/**
 * A polygon is dispatchable only when it has enough vertices AND every
 * coordinate is finite. The finiteness gate mirrors the backend's
 * `_is_finite_number` check (`websocket_server._is_valid_polygon`): `JSON.stringify`
 * coerces `NaN`/`Infinity` → `null`, which the server rejects into an empty
 * mission — so we must refuse such a polygon up front rather than report a false
 * success (review bug D1-3).
 */
function allCoordsFinite(coords: LngLat[]): boolean {
  return coords.every(
    ([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat),
  );
}

function isDispatchablePolygon(coords: LngLat[]): boolean {
  return coords.length >= MIN_MISSION_VERTICES && allCoordsFinite(coords);
}

export interface UseDeploySwarmOptions {
  /**
   * Module B's imperative draw handle (from `useMapboxDraw`). `null` until the
   * map + draw control have mounted; DRAW/CLEAR are inert until then. Optional so
   * the hook can be unit-tested headless (perimeter fed straight via
   * `onPerimeterDrawn`). When present, `draw.getPolygon()` is the single source
   * of truth for BOTH the enable-gate and `deploy()` (review bug D1-2).
   */
  draw?: MapboxDrawHandle | null;
  /** Command sink. Defaults to the Module-A singleton; overridable for tests. */
  service?: WebSocketService;
  /**
   * Clear the coverage sweep when a mission is dispatched, reproducing the
   * legacy `clearCoverageTelemetry()` call inside `deploySwarm`. Default `true`.
   *
   * NOTE: this gates ONLY the on-DEPLOY reset. CLEAR always wipes coverage
   * regardless of this flag — "clear the search area" unconditionally means
   * "start over" (review bug D1-1).
   */
  resetCoverageOnDeploy?: boolean;
}

/** Everything the DEPLOY SWARM control group (DeployControls.tsx) binds to. */
export interface DeploySwarmController {
  /**
   * Module-B interface-contract sink. Pass this straight to
   * `TacticalMap` / `useMapboxDraw`'s `onPerimeterDrawn`; every draw/edit/delete
   * flows in here and refreshes the controls.
   */
  onPerimeterDrawn: (coordinates: LngLat[]) => void;

  /** Distinct vertices in the current polygon (closed ring already trimmed). */
  vertexCount: number;
  /**
   * `true` once the current polygon is dispatchable (≥ 3 finite vertices) AND it
   * has not already been deployed — the DEPLOY SWARM enable gate. Reads the same
   * polygon source `deploy()` uses, so the two never disagree.
   */
  canDeploy: boolean;
  /** `true` while any polygon exists — the CLEAR enable gate. */
  canClear: boolean;

  /** Operator-facing status line text (legacy `deployHint`). */
  hint: string;
  /** Drives the hint colour class (idle/armed/error). */
  hintState: DeployHintState;

  /** DRAW AREA → arm Mapbox Draw's polygon mode (clears any prior polygon). */
  startDrawing: () => void;
  /** CLEAR → drop the polygon (Module B) and reset local + coverage state. */
  clear: () => void;
  /** DEPLOY SWARM → validate and transmit START_MISSION. */
  deploy: () => void;
}

// ──────────────────────────────────────────────────────────────────────────
// Hook
// ──────────────────────────────────────────────────────────────────────────

/**
 * Wire the DEPLOY SWARM workflow. Returns a stable-ish controller the header
 * control group renders against; the host composes it as:
 *
 *   const controller = useDeploySwarm({ draw });
 *   <TacticalMap onPerimeterDrawn={controller.onPerimeterDrawn} … />
 *   <DeployControls controller={controller} />
 */
export function useDeploySwarm(
  options: UseDeploySwarmOptions = {},
): DeploySwarmController {
  const { draw = null, service = webSocketService, resetCoverageOnDeploy = true } =
    options;

  /** Latest drawn perimeter as open `[lng, lat]` vertices (Module B feeds it). */
  const [perimeter, setPerimeter] = useState<LngLat[]>([]);

  /**
   * `true` once the current polygon has been dispatched. Disarms DEPLOY until
   * the geometry changes, so a second click can't re-fire the identical mission
   * (review bug D1-4). Cleared by every geometry mutation below.
   */
  const [deployed, setDeployed] = useState(false);

  /**
   * Transient override of the derived hint — used both for error flashes
   * ("NEED 3+ POINTS") and the sticky "MISSION SENT" notice. Cleared on the next
   * geometry change so the count-driven hint takes back over, exactly like the
   * legacy `deployHint.textContent` writes that `refreshDeployControls` resets.
   */
  const [override, setOverride] = useState<{ text: string; state: DeployHintState } | null>(
    null,
  );
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFlashTimer = useCallback(() => {
    if (flashTimer.current !== null) {
      clearTimeout(flashTimer.current);
      flashTimer.current = null;
    }
  }, []);

  // Drop the override (and any pending revert) whenever the geometry changes.
  const resetOverride = useCallback(() => {
    clearFlashTimer();
    setOverride(null);
  }, [clearFlashTimer]);

  /** Show a transient error flash that auto-reverts to the derived hint. */
  const flash = useCallback(
    (text: string) => {
      clearFlashTimer();
      setOverride({ text, state: 'error' });
      flashTimer.current = setTimeout(() => {
        flashTimer.current = null;
        setOverride(null);
      }, FLASH_DURATION_MS);
    },
    [clearFlashTimer],
  );

  // Clean up the revert timer on unmount.
  useEffect(() => clearFlashTimer, [clearFlashTimer]);

  // ── Module-B sink ─────────────────────────────────────────────────────────

  const onPerimeterDrawn = useCallback(
    (coordinates: LngLat[]) => {
      resetOverride();
      setDeployed(false); // geometry changed → re-arm DEPLOY (D1-4)
      // Copy so a later mutation of the source array can't alias our state.
      setPerimeter(coordinates.map(([lng, lat]) => [lng, lat] as LngLat));
    },
    [resetOverride],
  );

  // ── Actions ─────────────────────────────────────────────────────────────

  const startDrawing = useCallback(() => {
    resetOverride();
    setDeployed(false);
    // Module B clears its own geometry; mirror that locally so the count resets
    // immediately even before the draw.delete event round-trips.
    setPerimeter([]);
    draw?.startDrawing();
  }, [draw, resetOverride]);

  const clear = useCallback(() => {
    resetOverride();
    setDeployed(false);
    setPerimeter([]);
    draw?.clear(); // emits onPerimeterDrawn([]) too — idempotent with the above
    // CLEAR always wipes coverage — "start over" is unconditional, independent of
    // the on-DEPLOY flag (review bug D1-1).
    useSwarmStore.getState().resetCoverage();
  }, [draw, resetOverride]);

  const deploy = useCallback(() => {
    // Already dispatched this exact polygon — require a geometry change to re-arm
    // rather than silently re-planning the swarm mid-flight (review bug D1-4).
    if (deployed) return;

    // Single source of truth: the live draw geometry when a handle is mounted,
    // else the buffered perimeter. The enable-gate below reads the SAME source,
    // so an enabled button always matches a sendable polygon (review bug D1-2).
    const polygon = draw?.getPolygon() ?? perimeter;

    if (polygon.length < MIN_MISSION_VERTICES) {
      flash('NEED 3+ POINTS');
      return;
    }
    // Reject non-finite coords up front so we never report a false "MISSION SENT"
    // for a polygon the backend will silently drop (review bug D1-3).
    if (!allCoordsFinite(polygon)) {
      flash('INVALID COORDS');
      return;
    }

    // Module A's typed sink. Returns false if the socket was not OPEN — the
    // service queues the frame and flushes it on reconnect, so (unlike the
    // legacy hard-drop on `WS OFFLINE`) the mission is not lost; we say so.
    const sent = service.sendCommand('START_MISSION', { polygon });
    setDeployed(true); // frame accepted (sent or queued) → disarm until re-drawn

    if (resetCoverageOnDeploy) useSwarmStore.getState().resetCoverage();

    clearFlashTimer();
    setOverride(
      sent
        ? { text: `MISSION SENT — ${polygon.length} VERTICES`, state: 'armed' }
        : { text: 'WS OFFLINE — QUEUED', state: 'error' },
    );
  }, [deployed, draw, perimeter, service, resetCoverageOnDeploy, flash, clearFlashTimer]);

  // ── Derived UI state (legacy `refreshDeployControls`) ──────────────────────

  // Read the SAME polygon source `deploy()` uses so the gate and the action can
  // never disagree (review bug D1-2). `perimeter` is still the React re-render
  // trigger — it updates from the same draw events `getPolygon()` reflects.
  const effectivePolygon = draw?.getPolygon() ?? perimeter;
  const vertexCount = effectivePolygon.length;
  const canClear = vertexCount > 0;
  const canDeploy = !deployed && isDispatchablePolygon(effectivePolygon);

  const { hint, hintState } = useMemo<{ hint: string; hintState: DeployHintState }>(() => {
    if (override) return { hint: override.text, hintState: override.state };
    if (vertexCount === 0) return { hint: 'DRAW SEARCH AREA ON MAP', hintState: 'idle' };
    if (canDeploy) return { hint: `${vertexCount} VERTICES — READY`, hintState: 'armed' };
    return { hint: `${vertexCount}/3 VERTICES`, hintState: 'idle' };
  }, [override, vertexCount, canDeploy]);

  return {
    onPerimeterDrawn,
    vertexCount,
    canDeploy,
    canClear,
    hint,
    hintState,
    startDrawing,
    clear,
    deploy,
  };
}
