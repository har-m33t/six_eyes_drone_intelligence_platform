/**
 * Code-review test suite — Module D · Task D1 (`useDeploySwarm`).
 *
 * Covers the happy path (vertex gating, hint ladder, deploy/clear/flash) AND the
 * "try to break it" cases from the review (see `.claude/module_d_review.md`).
 * The `[BUG D1-n]` cases were originally pinned to the buggy behaviour; the bugs
 * are now FIXED (2026-06-22) and these cases assert the corrected behaviour, so
 * they double as regression guards.
 *
 *   cd frontend && npm install && npm test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useDeploySwarm, MIN_MISSION_VERTICES } from './useDeploySwarm';
import type { MapboxDrawHandle } from '../map/useMapboxDraw';
import type { WebSocketService } from '../services/websocket';
import type { LngLat } from '../types/telemetry';
import { useSwarmStore } from '../store/useSwarmStore';

// ── Fakes ───────────────────────────────────────────────────────────────────

function makeService(sendResult = true) {
  const sendCommand = vi.fn(() => sendResult);
  return { service: { sendCommand } as unknown as WebSocketService, sendCommand };
}

/** A fake Mapbox draw handle whose `getPolygon()` is fully controllable. */
function makeDraw(getPolygon: () => LngLat[]): MapboxDrawHandle {
  return {
    startDrawing: vi.fn(),
    clear: vi.fn(),
    getPolygon: vi.fn(getPolygon),
    instance: null,
  };
}

const tri: LngLat[] = [
  [0, 0],
  [1, 0],
  [1, 1],
];

beforeEach(() => {
  // Reset shared store between tests so coverage assertions are isolated.
  useSwarmStore.setState({ coverage: {}, globalCoveragePct: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ── Happy path ────────────────────────────────────────────────────────────

describe('useDeploySwarm — vertex gating & hint ladder', () => {
  it('starts idle with no polygon', () => {
    const { service } = makeService();
    const { result } = renderHook(() => useDeploySwarm({ service }));

    expect(result.current.vertexCount).toBe(0);
    expect(result.current.canDeploy).toBe(false);
    expect(result.current.canClear).toBe(false);
    expect(result.current.hint).toBe('DRAW SEARCH AREA ON MAP');
    expect(result.current.hintState).toBe('idle');
  });

  it('shows the partial-count idle hint below the minimum', () => {
    const { service } = makeService();
    const { result } = renderHook(() => useDeploySwarm({ service }));

    act(() => result.current.onPerimeterDrawn([[0, 0], [1, 1]]));

    expect(result.current.vertexCount).toBe(2);
    expect(result.current.canDeploy).toBe(false);
    expect(result.current.canClear).toBe(true);
    expect(result.current.hint).toBe('2/3 VERTICES');
    expect(result.current.hintState).toBe('idle');
  });

  it('arms once the minimum vertices are present', () => {
    const { service } = makeService();
    const { result } = renderHook(() => useDeploySwarm({ service }));

    act(() => result.current.onPerimeterDrawn(tri));

    expect(result.current.canDeploy).toBe(true);
    expect(result.current.hint).toBe('3 VERTICES — READY');
    expect(result.current.hintState).toBe('armed');
    expect(MIN_MISSION_VERTICES).toBe(3);
  });
});

describe('useDeploySwarm — deploy', () => {
  it('sends START_MISSION with the buffered perimeter and reports success', () => {
    const { service, sendCommand } = makeService(true);
    const { result } = renderHook(() => useDeploySwarm({ service }));

    act(() => result.current.onPerimeterDrawn(tri));
    act(() => result.current.deploy());

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith('START_MISSION', { polygon: tri });
    expect(result.current.hint).toBe('MISSION SENT — 3 VERTICES');
    expect(result.current.hintState).toBe('armed');
  });

  it('prefers the live draw geometry over the buffered perimeter', () => {
    const { service, sendCommand } = makeService(true);
    const live: LngLat[] = [[5, 5], [6, 5], [6, 6], [5, 6]];
    const draw = makeDraw(() => live);
    const { result } = renderHook(() => useDeploySwarm({ service, draw }));

    // Buffer a *different* (smaller) perimeter; deploy must trust draw.getPolygon.
    act(() => result.current.onPerimeterDrawn(tri));
    act(() => result.current.deploy());

    expect(sendCommand).toHaveBeenCalledWith('START_MISSION', { polygon: live });
    expect(result.current.hint).toBe('MISSION SENT — 4 VERTICES');
  });

  it('surfaces a QUEUED notice when the socket is offline (sendCommand → false)', () => {
    const { service, sendCommand } = makeService(false);
    const { result } = renderHook(() => useDeploySwarm({ service }));

    act(() => result.current.onPerimeterDrawn(tri));
    act(() => result.current.deploy());

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(result.current.hint).toBe('WS OFFLINE — QUEUED');
    expect(result.current.hintState).toBe('error');
  });

  it('flashes an error and reverts after the flash window on too-few vertices', () => {
    vi.useFakeTimers();
    const { service, sendCommand } = makeService(true);
    const { result } = renderHook(() => useDeploySwarm({ service }));

    act(() => result.current.onPerimeterDrawn([[0, 0], [1, 1]]));
    act(() => result.current.deploy());

    expect(sendCommand).not.toHaveBeenCalled();
    expect(result.current.hint).toBe('NEED 3+ POINTS');
    expect(result.current.hintState).toBe('error');

    act(() => {
      vi.advanceTimersByTime(1800);
    });

    // Reverts to the count-driven idle hint.
    expect(result.current.hint).toBe('2/3 VERTICES');
    expect(result.current.hintState).toBe('idle');
  });
});

describe('useDeploySwarm — clear & coverage reset', () => {
  it('clears the perimeter and resets coverage by default', () => {
    useSwarmStore.setState({ globalCoveragePct: 42 });
    const { service } = makeService();
    const { result } = renderHook(() => useDeploySwarm({ service }));

    act(() => result.current.onPerimeterDrawn(tri));
    act(() => result.current.clear());

    expect(result.current.vertexCount).toBe(0);
    expect(result.current.canClear).toBe(false);
    expect(useSwarmStore.getState().globalCoveragePct).toBe(0);
  });
});

// ── Break attempts / bug documentation ──────────────────────────────────────

describe('useDeploySwarm — [BUG D1-1 FIXED] clear() wipes coverage unconditionally', () => {
  it('CLEAR resets coverage even when resetCoverageOnDeploy is false', () => {
    // `resetCoverageOnDeploy:false` keeps coverage across a DEPLOY, but CLEAR
    // means "start over" and must always wipe coverage regardless of the flag.
    useSwarmStore.setState({ globalCoveragePct: 73 });
    const { service } = makeService();
    const { result } = renderHook(() =>
      useDeploySwarm({ service, resetCoverageOnDeploy: false }),
    );

    act(() => result.current.onPerimeterDrawn(tri));
    act(() => result.current.clear());

    // Perimeter clears…
    expect(result.current.vertexCount).toBe(0);
    // …and coverage is reset, unconditionally (fixed: flag only gates on-DEPLOY).
    expect(useSwarmStore.getState().globalCoveragePct).toBe(0);
  });
});

describe('useDeploySwarm — [BUG D1-2 FIXED] enable-gate and deploy() read the same source', () => {
  it('button is DISABLED whenever deploy() would refuse, because both read draw.getPolygon()', () => {
    const { service, sendCommand } = makeService(true);
    // Draw handle reports an EMPTY polygon (e.g. a draw.delete the perimeter
    // state hasn't caught up to), while the buffered perimeter still has 3.
    const draw = makeDraw(() => []);
    const { result } = renderHook(() => useDeploySwarm({ service, draw }));

    act(() => result.current.onPerimeterDrawn(tri));

    // The gate now reads the live draw geometry too, so it agrees with deploy().
    expect(result.current.canDeploy).toBe(false);

    act(() => result.current.deploy());

    // deploy() validates the (empty) live geometry and refuses to send.
    expect(sendCommand).not.toHaveBeenCalled();
    expect(result.current.hint).toBe('NEED 3+ POINTS');
    expect(result.current.hintState).toBe('error');
  });
});

describe('useDeploySwarm — [BUG D1-3 FIXED] non-finite coords are rejected, no false "MISSION SENT"', () => {
  it('refuses to send a polygon with NaN/Infinity coords and flashes an error', () => {
    const { service, sendCommand } = makeService(true);
    const { result } = renderHook(() => useDeploySwarm({ service }));

    const dirty: LngLat[] = [
      [Number.NaN, Number.NaN],
      [Number.POSITIVE_INFINITY, 1],
      [2, 3],
    ];
    act(() => result.current.onPerimeterDrawn(dirty));

    // Length passes but a coord is non-finite, so the button is NOT armed.
    expect(result.current.canDeploy).toBe(false);
    act(() => result.current.deploy());

    // Nothing goes on the wire (would have been coerced to null and dropped by
    // the backend's _is_valid_polygon); the operator gets an honest error.
    expect(sendCommand).not.toHaveBeenCalled();
    expect(result.current.hint).toBe('INVALID COORDS');
    expect(result.current.hintState).toBe('error');
  });
});

describe('useDeploySwarm — [BUG D1-4 FIXED] DEPLOY disarms after a send', () => {
  it('a second deploy() with no geometry change does NOT re-send the mission', () => {
    const { service, sendCommand } = makeService(true);
    const { result } = renderHook(() => useDeploySwarm({ service }));

    act(() => result.current.onPerimeterDrawn(tri));
    act(() => result.current.deploy());
    act(() => result.current.deploy());

    // Exactly one mission goes out; DEPLOY is disarmed until the geometry changes.
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(result.current.canDeploy).toBe(false);
  });

  it('re-arms once the operator redraws (geometry change clears the latch)', () => {
    const { service, sendCommand } = makeService(true);
    const { result } = renderHook(() => useDeploySwarm({ service }));

    act(() => result.current.onPerimeterDrawn(tri));
    act(() => result.current.deploy());
    expect(result.current.canDeploy).toBe(false);

    // A fresh perimeter re-arms DEPLOY and a new mission can be sent.
    act(() => result.current.onPerimeterDrawn([[2, 2], [3, 2], [3, 3]]));
    expect(result.current.canDeploy).toBe(true);
    act(() => result.current.deploy());
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });
});
