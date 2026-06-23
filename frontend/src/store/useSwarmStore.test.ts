/**
 * Module A · Task A2 — Zustand swarm store tests.
 *
 * Covers the documented contract (slice isolation, ingest routing, waypoint-
 * weighted coverage, alert de-dup, fleet summary) AND a set of adversarial
 * "try to break it" packets that expose robustness gaps. Each adversarial case
 * is labelled with the bug it demonstrates (see frontend-migration.md → "Task A
 * Review").
 *
 * The store actions/selectors are driven headlessly: actions via getState(),
 * selector hooks via React's runtime through @testing-library's renderHook.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useSwarmStore,
  useDrone,
  useDronePositions,
  useFleetSummary,
  useGlobalCoverage,
  type SwarmState,
} from './useSwarmStore';
import type { DronePacket, NavTelemetry } from '../types/telemetry';

const INITIAL: Partial<SwarmState> = {
  drones: {},
  coverage: {},
  globalCoveragePct: 0,
  connection: 'connecting',
  missionStartMs: null,
  seenAlerts: [],
  alertCount: 0,
};

beforeEach(() => {
  useSwarmStore.setState(INITIAL as SwarmState, false);
});

function drone(over: Partial<DronePacket> = {}): DronePacket {
  return {
    drone_id: 'DRONE_1',
    timestamp: 1,
    frame_idx: 0,
    detections: [],
    gps: { lat: 33.6, lng: -117.8, lon: -117.8, alt: 100 },
    health: { battery: 90, signal: 'STRONG', status: 'ONLINE', speed_ms: 5, temp_c: 30 },
    mission: { zone: 'ALPHA', coverage_pct: 0, elapsed_s: 0 },
    ...over,
  };
}

function nav(over: Partial<NavTelemetry> = {}): NavTelemetry {
  return {
    drone_id: 'DRONE_1',
    timestamp: 1,
    x: -117.8,
    y: 33.6,
    current_waypoint_idx: 0,
    waypoints_remaining: 0,
    mission_complete: false,
    ...over,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Happy-path contract
// ──────────────────────────────────────────────────────────────────────────

describe('applyDronePacket / slice isolation', () => {
  it('stores the latest packet per drone', () => {
    useSwarmStore.getState().applyDronePacket(drone({ drone_id: 'DRONE_2' }));
    expect(useSwarmStore.getState().drones.DRONE_2?.drone_id).toBe('DRONE_2');
  });

  it('updating one drone preserves the object identity of untouched drones', () => {
    const s = useSwarmStore.getState();
    const d1 = drone({ drone_id: 'DRONE_1' });
    s.applyDronePacket(d1);
    const ref1 = useSwarmStore.getState().drones.DRONE_1;

    s.applyDronePacket(drone({ drone_id: 'DRONE_3' }));
    // DRONE_1's stored object must be the SAME reference → its subscribers
    // (useDrone('DRONE_1')) do not re-render when DRONE_3 ticks.
    expect(useSwarmStore.getState().drones.DRONE_1).toBe(ref1);
  });

  it('sets missionStartMs on the first packet and never moves it after', () => {
    const s = useSwarmStore.getState();
    s.applyDronePacket(drone());
    const first = useSwarmStore.getState().missionStartMs;
    expect(first).not.toBeNull();
    s.applyDronePacket(drone({ timestamp: 999 }));
    expect(useSwarmStore.getState().missionStartMs).toBe(first);
  });
});

describe('ingest routing (A1 guard)', () => {
  it('routes a nav frame to coverage, never to drones', () => {
    useSwarmStore.getState().ingest(nav({ current_waypoint_idx: 1, waypoints_remaining: 1 }));
    expect(useSwarmStore.getState().drones.DRONE_1).toBeUndefined();
    expect(useSwarmStore.getState().coverage.DRONE_1).toEqual({ current: 1, total: 2 });
  });

  it('routes a full drone frame to drones, never to coverage', () => {
    useSwarmStore.getState().ingest(drone());
    expect(useSwarmStore.getState().drones.DRONE_1).toBeDefined();
    expect(useSwarmStore.getState().coverage.DRONE_1).toBeUndefined();
  });
});

describe('applyNavTelemetry / waypoint-weighted coverage', () => {
  it('weights long routes more than short ones (Σdone / Σtotal)', () => {
    const s = useSwarmStore.getState();
    s.applyNavTelemetry(nav({ drone_id: 'DRONE_1', current_waypoint_idx: 1, waypoints_remaining: 1 })); // 1/2
    s.applyNavTelemetry(nav({ drone_id: 'DRONE_2', current_waypoint_idx: 0, waypoints_remaining: 98 })); // 0/98
    // Σdone=1, Σtotal=100 → 1% (NOT the 25% a per-drone mean would give).
    expect(useSwarmStore.getState().globalCoveragePct).toBeCloseTo(1, 5);
  });

  it('treats mission_complete as fully searched even when counters read 0', () => {
    useSwarmStore.getState().applyNavTelemetry(
      nav({ current_waypoint_idx: 0, waypoints_remaining: 0, mission_complete: true }),
    );
    expect(useSwarmStore.getState().globalCoveragePct).toBe(100);
    expect(useSwarmStore.getState().coverage.DRONE_1).toEqual({ current: 1, total: 1 });
  });

  it('normalizes the drone id to upper-case (legacy parity)', () => {
    useSwarmStore.getState().applyNavTelemetry(
      nav({ drone_id: 'drone_4' as any, current_waypoint_idx: 2, waypoints_remaining: 0 }),
    );
    expect(useSwarmStore.getState().coverage.DRONE_4).toEqual({ current: 2, total: 2 });
  });
});

describe('alert de-duplication', () => {
  it('counts a CRITICAL alert once per (drone,status), not per frame', () => {
    const s = useSwarmStore.getState();
    const crit = drone({ health: { battery: 5, signal: 'STRONG', status: 'CRITICAL', speed_ms: 0, temp_c: 80 } });
    s.applyDronePacket(crit);
    s.applyDronePacket(crit);
    s.applyDronePacket(crit);
    expect(useSwarmStore.getState().alertCount).toBe(1);
  });

  it('counts a signal-LOST alert', () => {
    useSwarmStore.getState().applyDronePacket(
      drone({ health: { battery: 90, signal: 'LOST', status: 'ONLINE', speed_ms: 0, temp_c: 30 } }),
    );
    expect(useSwarmStore.getState().alertCount).toBe(1);
  });
});

describe('reset / clear actions', () => {
  it('resetCoverage drops coverage + global pct only', () => {
    const s = useSwarmStore.getState();
    s.applyNavTelemetry(nav({ current_waypoint_idx: 5, waypoints_remaining: 0 }));
    s.resetCoverage();
    expect(useSwarmStore.getState().coverage).toEqual({});
    expect(useSwarmStore.getState().globalCoveragePct).toBe(0);
  });

  it('clearMission wipes drones, coverage and alerts', () => {
    const s = useSwarmStore.getState();
    s.applyDronePacket(drone({ health: { battery: 5, signal: 'LOST', status: 'CRITICAL', speed_ms: 0, temp_c: 80 } }));
    s.clearMission();
    expect(useSwarmStore.getState().drones).toEqual({});
    expect(useSwarmStore.getState().alertCount).toBe(0);
  });

  // BUG A2-3 (documented): clearMission leaves missionStartMs (and connection)
  // untouched, so a "new search area deployed" keeps the OLD mission-clock epoch.
  // This test pins current behaviour; flip the expectation if intent changes.
  it('BUG A2-3: clearMission does NOT reset the mission clock', () => {
    const s = useSwarmStore.getState();
    s.applyDronePacket(drone());
    const before = useSwarmStore.getState().missionStartMs;
    expect(before).not.toBeNull();
    s.clearMission();
    expect(useSwarmStore.getState().missionStartMs).toBe(before); // still the old epoch
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Selector hooks (driven through React)
// ──────────────────────────────────────────────────────────────────────────

describe('selector hooks', () => {
  it('useDrone returns only that drone', () => {
    useSwarmStore.getState().applyDronePacket(drone({ drone_id: 'DRONE_5' }));
    const { result } = renderHook(() => useDrone('DRONE_5'));
    expect(result.current?.drone_id).toBe('DRONE_5');
  });

  // A2-0 (P0) FIXED: useDronePositions previously returned an array of FRESHLY-
  // BUILT element objects. `useShallow` only does a one-level compare (Object.is
  // per element), so new element objects never matched the previous snapshot, the
  // selector changed on every render, and useSyncExternalStore looped ("Maximum
  // update depth exceeded"). The fix is an identity-stable `toPosition` cache
  // (WeakMap keyed by packet), so an unchanged drone yields the SAME element
  // reference and the snapshot is stable. The hook now renders once and returns a
  // position per valid drone.
  it('A2-0 fixed: useDronePositions is stable (no loop) and returns one position per valid drone', () => {
    useSwarmStore.getState().applyDronePacket(drone({ drone_id: 'DRONE_1' }));
    const { result } = renderHook(() => useDronePositions());
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ id: 'DRONE_1', lng: -117.8, lat: 33.6 });
  });

  // The same packet object yields the SAME position reference (cache hit), which
  // is exactly what keeps `useShallow` stable across unrelated store writes.
  it('A2-0: identical packet → identical DronePosition reference', () => {
    const d = drone({ drone_id: 'DRONE_1' });
    useSwarmStore.getState().applyDronePacket(d);
    const { result, rerender } = renderHook(() => useDronePositions());
    const first = result.current;
    // A write that does NOT touch DRONE_1's packet must not change its element.
    useSwarmStore.getState().setConnection('live');
    rerender();
    expect(result.current).toBe(first); // shallow-equal array → same snapshot
  });

  // The junk-coords path does NOT loop — but only because it yields an EMPTY
  // array, and `shallow([], [])` is stable. So filtering happens to mask BUG
  // A2-0 precisely when there are zero valid drones.
  it('useDronePositions rejects junk coords (NaN / Infinity) — empty array is stable', () => {
    const s = useSwarmStore.getState();
    s.applyDronePacket(drone({ drone_id: 'DRONE_1', gps: { lat: NaN, lng: -117, lon: -117, alt: 0 } }));
    s.applyDronePacket(drone({ drone_id: 'DRONE_2', gps: { lat: 33, lng: Infinity, lon: Infinity, alt: 0 } }));
    const { result } = renderHook(() => useDronePositions());
    expect(result.current).toHaveLength(0);
  });

  it('useFleetSummary excludes CRITICAL/LOST from online and sums detections', () => {
    const s = useSwarmStore.getState();
    s.applyDronePacket(drone({ drone_id: 'DRONE_1' }));
    s.applyDronePacket(drone({ drone_id: 'DRONE_2', detections: [{ class: 'person', confidence: 0.9, bbox: [0, 0, 1, 1] }] }));
    s.applyDronePacket(drone({ drone_id: 'DRONE_3', health: { battery: 10, signal: 'LOST', status: 'CRITICAL', speed_ms: 0, temp_c: 70 } }));
    const { result } = renderHook(() => useFleetSummary());
    expect(result.current.online).toBe(2);
    expect(result.current.detections).toBe(1);
  });

  it('useGlobalCoverage reflects the weighted stat', () => {
    useSwarmStore.getState().applyNavTelemetry(nav({ current_waypoint_idx: 1, waypoints_remaining: 3 }));
    const { result } = renderHook(() => useGlobalCoverage());
    expect(result.current).toBeCloseTo(25, 5);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ADVERSARIAL — "try to break it"
// ──────────────────────────────────────────────────────────────────────────

describe('adversarial / robustness', () => {
  // A2-1a FIXED: a packet missing `health` is now IGNORED (no throw, not stored)
  // rather than crashing applyDronePacket. A malformed frame can't drive a panel,
  // so the store drops it and logs once instead of throwing per frame.
  it('A2-1a fixed: applyDronePacket ignores a packet missing health (no throw, not stored)', () => {
    const headless = { drone_id: 'DRONE_1', gps: { lat: 1, lng: 2, lon: 2, alt: 0 } } as unknown as DronePacket;
    expect(() => useSwarmStore.getState().applyDronePacket(headless)).not.toThrow();
    expect(useSwarmStore.getState().drones.DRONE_1).toBeUndefined();
  });

  // A2-1b FIXED: a packet whose `health` is present but partial (no `battery`) is
  // still stored, but is now EXCLUDED from the fleet average instead of poisoning
  // it to NaN. One malformed drone no longer corrupts the header battery readout.
  it('A2-1b fixed: a partial health block is excluded from avgBattery (no NaN)', () => {
    const s = useSwarmStore.getState();
    s.applyDronePacket(drone({ drone_id: 'DRONE_1' })); // battery 90
    s.applyDronePacket(
      { ...drone({ drone_id: 'DRONE_2' }), health: { status: 'ONLINE', signal: 'STRONG' } as any },
    );
    const { result } = renderHook(() => useFleetSummary());
    expect(Number.isNaN(result.current.avgBattery)).toBe(false);
    expect(result.current.avgBattery).toBe(90); // only DRONE_1's finite battery
  });

  // A2-1c FIXED: ingest() now object-guards before A1's `isNavTelemetry`, so a
  // non-object is ignored rather than throwing on the `in` operator.
  it('A2-1c fixed: ingest(non-object) is ignored and does not throw', () => {
    expect(() => useSwarmStore.getState().ingest(5 as any)).not.toThrow();
    expect(useSwarmStore.getState().drones).toEqual({});
  });

  it('empty nav (no reporting drones) keeps global coverage at 0, no divide-by-zero', () => {
    useSwarmStore.getState().applyNavTelemetry(nav({ current_waypoint_idx: 0, waypoints_remaining: 0 }));
    expect(useSwarmStore.getState().globalCoveragePct).toBe(0);
    expect(Number.isNaN(useSwarmStore.getState().globalCoveragePct)).toBe(false);
  });
});
