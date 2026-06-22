/**
 * Code-review test suite — Module D · Task D1 (`useDeploySwarm`).
 *
 * Covers the happy path (vertex gating, hint ladder, deploy/clear/flash) AND a
 * set of "try to break it" cases that document the bugs found in the review
 * (see `.claude/module_d_review.md`). Bug-documenting cases are tagged
 * `[BUG D1-n]` and assert the CURRENT (buggy) behaviour so the suite stays green
 * and the regression is pinned; flip the assertion when the bug is fixed.
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

describe('useDeploySwarm — [BUG D1-1] resetCoverageOnDeploy mis-gates clear()', () => {
  it('disabling reset-on-DEPLOY ALSO silently disables reset-on-CLEAR', () => {
    // The single flag `resetCoverageOnDeploy` is (mis)used to gate the coverage
    // reset inside clear() too. An operator who only wants to *keep* coverage on
    // deploy unexpectedly loses the coverage wipe on CLEAR.
    useSwarmStore.setState({ globalCoveragePct: 73 });
    const { service } = makeService();
    const { result } = renderHook(() =>
      useDeploySwarm({ service, resetCoverageOnDeploy: false }),
    );

    act(() => result.current.onPerimeterDrawn(tri));
    act(() => result.current.clear());

    // Perimeter still clears…
    expect(result.current.vertexCount).toBe(0);
    // …but coverage is NOT reset (bug — name says "OnDeploy", behaviour leaks to clear).
    expect(useSwarmStore.getState().globalCoveragePct).toBe(73);
  });
});

describe('useDeploySwarm — [BUG D1-2] enable-gate vs deploy-gate use different sources', () => {
  it('button can be ENABLED while deploy() fails, because canDeploy reads perimeter but deploy() reads draw.getPolygon()', () => {
    const { service, sendCommand } = makeService(true);
    // Draw handle reports an EMPTY polygon (e.g. a draw.delete the perimeter
    // state hasn't caught up to), while the buffered perimeter still has 3.
    const draw = makeDraw(() => []);
    const { result } = renderHook(() => useDeploySwarm({ service, draw }));

    act(() => result.current.onPerimeterDrawn(tri));

    // The DEPLOY button is enabled (gate reads the buffered perimeter)…
    expect(result.current.canDeploy).toBe(true);

    act(() => result.current.deploy());

    // …yet deploy() validates the (empty) live geometry and refuses to send.
    expect(sendCommand).not.toHaveBeenCalled();
    expect(result.current.hint).toBe('NEED 3+ POINTS');
    expect(result.current.hintState).toBe('error');
  });
});

describe('useDeploySwarm — [BUG D1-3] no coordinate validation → false "MISSION SENT"', () => {
  it('sends a polygon with non-finite coords (NaN→null on the wire) yet claims success', () => {
    const { service, sendCommand } = makeService(true);
    const { result } = renderHook(() => useDeploySwarm({ service }));

    const dirty: LngLat[] = [
      [Number.NaN, Number.NaN],
      [Number.POSITIVE_INFINITY, 1],
      [2, 3],
    ];
    act(() => result.current.onPerimeterDrawn(dirty));

    // Length passes, so the button is armed and deploy proceeds.
    expect(result.current.canDeploy).toBe(true);
    act(() => result.current.deploy());

    expect(sendCommand).toHaveBeenCalledTimes(1);
    const [, payload] = sendCommand.mock.calls[0];
    // On the wire JSON.stringify coerces NaN/Infinity → null; the backend's
    // _is_valid_polygon then rejects them and plans an EMPTY mission — but the
    // operator was told the mission was sent successfully.
    expect(JSON.stringify(payload)).toContain('null');
    expect(result.current.hint).toBe('MISSION SENT — 3 VERTICES');
    expect(result.current.hintState).toBe('armed');
  });
});

describe('useDeploySwarm — [BUG D1-4] sticky success lets the same mission be re-fired', () => {
  it('DEPLOY stays enabled after a send, so a second click re-sends the identical mission', () => {
    const { service, sendCommand } = makeService(true);
    const { result } = renderHook(() => useDeploySwarm({ service }));

    act(() => result.current.onPerimeterDrawn(tri));
    act(() => result.current.deploy());
    act(() => result.current.deploy());

    // No geometry change between clicks, yet two identical missions go out.
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(result.current.canDeploy).toBe(true);
  });
});
