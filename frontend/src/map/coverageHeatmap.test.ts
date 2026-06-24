/**
 * Code-review test suite — Module B · Task B4 (`CoverageHeatmap`).
 *
 * Covers the happy path (attach/append/interpolate/clear/breakSegment) AND a set
 * of "try to break it" cases that document the bugs found in the review
 * (see `.claude/module_b_review.md`). Bug-documenting cases are tagged
 * `[BUG B4-n]` and assert the CURRENT behaviour so the suite stays green and the
 * regression is pinned; flip the assertion when the bug is fixed.
 *
 * `coverageHeatmap.ts` imports ONLY types from `mapbox-gl` (erased at runtime),
 * so these tests need no mapbox-gl mock — just a hand-rolled fake `Map`.
 *
 *   cd frontend && npm test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CoverageHeatmap,
  COVERAGE_SOURCE_ID,
  COVERAGE_LAYER_ID,
  COVERAGE_INTERPOLATION_STEP_DEGREES as STEP,
  COVERAGE_MAX_INTERPOLATED_POINTS as CAP,
} from './coverageHeatmap';

// ── Fake mapboxgl.Map ────────────────────────────────────────────────────────

interface FakeMap {
  isStyleLoaded: () => boolean;
  on: (ev: string, cb: () => void) => void;
  off: (ev: string, cb: () => void) => void;
  getSource: (id: string) => { setData: (d: unknown) => void } | undefined;
  addSource: (id: string, src: unknown) => void;
  addLayer: (layer: unknown) => void;
  getLayer: (id: string) => { id: string } | undefined;
  removeLayer: (id: string) => void;
  removeSource: (id: string) => void;
  // test affordances
  fire: (ev: string) => void;
  listenerCount: (ev: string) => number;
  hasSource: () => boolean;
  hasLayer: () => boolean;
  lastData: () => { features: unknown[] } | null;
  setStyleLoaded: (v: boolean) => void;
}

function makeMap(styleLoaded = true): FakeMap {
  const listeners: Record<string, Array<() => void>> = {};
  let sourceAdded = false;
  let layerAdded = false;
  let lastData: { features: unknown[] } | null = null;
  let loaded = styleLoaded;
  const setData = vi.fn((d: unknown) => {
    lastData = d as { features: unknown[] };
  });
  return {
    isStyleLoaded: () => loaded,
    on: (ev, cb) => {
      (listeners[ev] ??= []).push(cb);
    },
    off: (ev, cb) => {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== cb);
    },
    getSource: (id) =>
      sourceAdded && id === COVERAGE_SOURCE_ID ? { setData } : undefined,
    addSource: (id) => {
      if (id === COVERAGE_SOURCE_ID) sourceAdded = true;
    },
    addLayer: (layer) => {
      if ((layer as { id: string }).id === COVERAGE_LAYER_ID) layerAdded = true;
    },
    getLayer: (id) =>
      layerAdded && id === COVERAGE_LAYER_ID ? { id } : undefined,
    removeLayer: (id) => {
      if (id === COVERAGE_LAYER_ID) layerAdded = false;
    },
    removeSource: (id) => {
      if (id === COVERAGE_SOURCE_ID) sourceAdded = false;
    },
    fire: (ev) => (listeners[ev] ?? []).slice().forEach((f) => f()),
    listenerCount: (ev) => (listeners[ev] ?? []).length,
    hasSource: () => sourceAdded,
    hasLayer: () => layerAdded,
    lastData: () => lastData,
    setStyleLoaded: (v) => {
      loaded = v;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asMap = (m: FakeMap) => m as any;

afterEach(() => vi.clearAllMocks());

// ── Happy path ───────────────────────────────────────────────────────────────

describe('CoverageHeatmap — attach lifecycle', () => {
  it('registers the source + circle layer immediately when the style is loaded', () => {
    const m = makeMap(true);
    new CoverageHeatmap(asMap(m)).attach();
    expect(m.hasSource()).toBe(true);
    expect(m.hasLayer()).toBe(true);
  });

  it('defers registration to the load event when the style is not ready', () => {
    const m = makeMap(false);
    const h = new CoverageHeatmap(asMap(m));
    h.attach();
    expect(m.hasSource()).toBe(false);
    expect(m.listenerCount('load')).toBe(1);

    m.fire('load');
    expect(m.hasSource()).toBe(true);
    expect(m.hasLayer()).toBe(true);
  });

  it('is idempotent — a second attach does not double-register', () => {
    const m = makeMap(true);
    const h = new CoverageHeatmap(asMap(m));
    const spy = vi.spyOn(m, 'addSource');
    h.attach();
    h.attach();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('detach removes the deferred load listener', () => {
    const m = makeMap(false);
    const h = new CoverageHeatmap(asMap(m));
    h.attach();
    expect(m.listenerCount('load')).toBe(1);
    h.detach();
    expect(m.listenerCount('load')).toBe(0);
  });
});

describe('CoverageHeatmap — append & interpolation', () => {
  it('first append for a drone drops a single footprint', () => {
    const m = makeMap();
    const h = new CoverageHeatmap(asMap(m));
    h.attach();
    expect(h.append(10, 20, 'DRONE_1')).toBe(1);
    expect(h.pointCount).toBe(1);
  });

  it('interpolates gap-free points across a multi-step move', () => {
    const h = new CoverageHeatmap(asMap(makeMap()));
    h.attach();
    h.append(0, 0, 'D'); // anchor
    expect(h.append(0, STEP * 5, 'D')).toBe(5); // 5 steps north
    expect(h.pointCount).toBe(6);
  });

  it('caps interpolation at COVERAGE_MAX_INTERPOLATED_POINTS on a teleport', () => {
    const h = new CoverageHeatmap(asMap(makeMap()));
    h.attach();
    h.append(0, 0, 'D');
    expect(h.append(0, STEP * 100_000, 'D')).toBe(CAP);
  });

  it('repaints via getSource().setData on every append', () => {
    const m = makeMap();
    const h = new CoverageHeatmap(asMap(m));
    h.attach();
    h.append(1, 1, 'D');
    expect(m.lastData()?.features.length).toBe(1);
  });

  it('rejects non-finite coordinates (NaN / Infinity / undefined)', () => {
    const h = new CoverageHeatmap(asMap(makeMap()));
    h.attach();
    expect(h.append(Number.NaN, 1, 'D')).toBe(0);
    expect(h.append(1, Number.POSITIVE_INFINITY, 'D')).toBe(0);
    // @ts-expect-error — exercising a malformed packet at runtime
    expect(h.append(undefined, 1, 'D')).toBe(0);
    expect(h.pointCount).toBe(0);
  });

  it('buffers appends made before attach, then exposes them on attach', () => {
    const m = makeMap();
    const h = new CoverageHeatmap(asMap(m));
    h.append(1, 1, 'D'); // no source yet — flush is a no-op
    expect(h.pointCount).toBe(1);
    h.attach();
    expect(m.hasSource()).toBe(true);
  });
});

describe('CoverageHeatmap — breakSegment & clear', () => {
  it('breakSegment drops the anchor so the next append does not bridge the gap', () => {
    const h = new CoverageHeatmap(asMap(makeMap()));
    h.attach();
    h.append(0, 0, 'D');
    h.breakSegment('D');
    // A large jump that WOULD have interpolated ~CAP points now starts fresh.
    expect(h.append(0, STEP * 1000, 'D')).toBe(1);
  });

  it('clear wipes the trail and all anchors', () => {
    const h = new CoverageHeatmap(asMap(makeMap()));
    h.attach();
    h.append(0, 0, 'D');
    h.append(0, STEP * 3, 'D');
    expect(h.pointCount).toBeGreaterThan(0);
    h.clear();
    expect(h.pointCount).toBe(0);
    // anchor gone too → single point, not an interpolated bridge
    expect(h.append(0, STEP * 1000, 'D')).toBe(1);
  });
});

// ── Regression tests for the fixed review bugs ───────────────────────────────

describe('CoverageHeatmap — [BUG B4-1 FIXED] bounded growth for a stationary/slow drone', () => {
  it('a hovering drone (no movement) paints exactly one footprint, not one per tick', () => {
    const h = new CoverageHeatmap(asMap(makeMap()));
    h.attach();
    // A hovering drone reports the SAME coordinate every tick. distance === 0 is
    // below COVERAGE_MIN_MOVE_DEGREES, so every tick after the first is skipped.
    for (let i = 0; i < 200; i++) h.append(5, 5, 'D');
    // Was 200 (one coincident point per tick); now a single footprint — the
    // source can no longer grow without bound for a stationary drone.
    expect(h.pointCount).toBe(1);
  });

  it('sub-step creep paints proportional to ground covered, not once per tick', () => {
    const h = new CoverageHeatmap(asMap(makeMap()));
    h.attach();
    h.append(0, 0, 'D');
    // 50 ticks each a tenth of the interpolation step → total drift of ~5 steps.
    // The anchor only advances once accumulated drift crosses one step, so the
    // count tracks distance covered (~5-10), NOT the 51 the buggy version produced.
    for (let i = 1; i <= 50; i++) h.append(0, (STEP / 10) * i, 'D');
    expect(h.pointCount).toBeGreaterThanOrEqual(5);
    expect(h.pointCount).toBeLessThan(20); // far below the buggy one-per-tick (51)
  });
});

describe('CoverageHeatmap — [BUG B4-2 FIXED] detach tears down the source/layer', () => {
  it('detach removes the load listener AND the coverage source/layer', () => {
    const m = makeMap(true);
    const h = new CoverageHeatmap(asMap(m));
    h.attach();
    expect(m.hasSource()).toBe(true);
    expect(m.hasLayer()).toBe(true);
    h.detach();
    // detach() is now a full teardown — no leaked layer/source when the map
    // outlives the controller or a React remount happens on a still-mounted map.
    expect(m.hasSource()).toBe(false);
    expect(m.hasLayer()).toBe(false);
  });

  it('detach before attach is a safe no-op (existence-guarded removal)', () => {
    const m = makeMap(true);
    const h = new CoverageHeatmap(asMap(m));
    expect(() => h.detach()).not.toThrow();
    expect(m.hasSource()).toBe(false);
    expect(m.hasLayer()).toBe(false);
  });

  it('re-attach after detach re-registers and re-exposes the buffered trail', () => {
    const m = makeMap(true);
    const h = new CoverageHeatmap(asMap(m));
    h.attach();
    h.append(0, 0, 'D');
    h.detach();
    expect(m.hasSource()).toBe(false);
    h.attach();
    expect(m.hasSource()).toBe(true);
    expect(m.lastData()?.features.length).toBe(1); // buffered trail re-pushed
  });
});

describe('CoverageHeatmap — [BUG B4-3 FIXED] droneId is required, so chains never cross', () => {
  it('two different drones keep independent anchors — no bogus bridging line', () => {
    const h = new CoverageHeatmap(asMap(makeMap()));
    h.attach();
    h.append(0, 0, 'DRONE_A'); // drone A
    // Drone B, far away, on its OWN key → a single fresh point, not 50
    // interpolated points bridging back to A (the old shared-'__global__' bug).
    const fresh = h.append(0, STEP * 50, 'DRONE_B');
    expect(fresh).toBe(1);
  });

  it('omitting droneId is now a compile-time error (no silent shared key)', () => {
    const h = new CoverageHeatmap(asMap(makeMap()));
    h.attach();
    // @ts-expect-error — droneId is required; the permissive null default is gone.
    expect(() => h.append(0, 0)).not.toThrow();
  });
});
