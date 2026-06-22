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

export interface UseDeploySwarmOptions {
  /**
   * Module B's imperative draw handle (from `useMapboxDraw`). `null` until the
   * map + draw control have mounted; DRAW/CLEAR are inert until then. Optional so
   * the hook can be unit-tested headless (perimeter fed straight via
   * `onPerimeterDrawn`).
   */
  draw?: MapboxDrawHandle | null;
  /** Command sink. Defaults to the Module-A singleton; overridable for tests. */
  service?: WebSocketService;
  /**
   * Clear the coverage sweep when a mission is dispatched, reproducing the
   * legacy `clearCoverageTelemetry()` call inside `deploySwarm`. Default `true`.
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
  /** `true` once ≥ 3 vertices exist — the DEPLOY SWARM enable gate. */
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
      // Copy so a later mutation of the source array can't alias our state.
      setPerimeter(coordinates.map(([lng, lat]) => [lng, lat] as LngLat));
    },
    [resetOverride],
  );

  // ── Actions ─────────────────────────────────────────────────────────────

  const startDrawing = useCallback(() => {
    resetOverride();
    // Module B clears its own geometry; mirror that locally so the count resets
    // immediately even before the draw.delete event round-trips.
    setPerimeter([]);
    draw?.startDrawing();
  }, [draw, resetOverride]);

  const clear = useCallback(() => {
    resetOverride();
    setPerimeter([]);
    draw?.clear(); // emits onPerimeterDrawn([]) too — idempotent with the above
    if (resetCoverageOnDeploy) useSwarmStore.getState().resetCoverage();
  }, [draw, resetOverride, resetCoverageOnDeploy]);

  const deploy = useCallback(() => {
    // Trust the live draw geometry if available, else the buffered perimeter.
    const polygon = draw?.getPolygon() ?? perimeter;

    if (polygon.length < MIN_MISSION_VERTICES) {
      flash('NEED 3+ POINTS');
      return;
    }

    // Module A's typed sink. Returns false if the socket was not OPEN — the
    // service queues the frame and flushes it on reconnect, so (unlike the
    // legacy hard-drop on `WS OFFLINE`) the mission is not lost; we say so.
    const sent = service.sendCommand('START_MISSION', { polygon });

    if (resetCoverageOnDeploy) useSwarmStore.getState().resetCoverage();

    clearFlashTimer();
    setOverride(
      sent
        ? { text: `MISSION SENT — ${polygon.length} VERTICES`, state: 'armed' }
        : { text: 'WS OFFLINE — QUEUED', state: 'error' },
    );
  }, [draw, perimeter, service, resetCoverageOnDeploy, flash, clearFlashTimer]);

  // ── Derived UI state (legacy `refreshDeployControls`) ──────────────────────

  const vertexCount = perimeter.length;
  const canDeploy = vertexCount >= MIN_MISSION_VERTICES;
  const canClear = vertexCount > 0;

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
