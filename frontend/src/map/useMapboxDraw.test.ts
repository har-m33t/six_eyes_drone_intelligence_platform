/**
 * Code-review test suite — Module B · Task B3 (`useMapboxDraw`).
 *
 * Covers the pure ring extractor + the hook's imperative handle and event
 * wiring, AND a set of "try to break it" cases that document the bugs found in
 * the review (see `.claude/module_b_review.md`). Bug-documenting cases are tagged
 * `[BUG B3-n]` and assert the CURRENT behaviour so the suite stays green and the
 * regression is pinned; flip the assertion when the bug is fixed.
 *
 * `@mapbox/mapbox-gl-draw` is mocked so the test never loads the real plugin
 * (which needs a live mapbox-gl/WebGL runtime jsdom cannot provide).
 *
 *   cd frontend && npm test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import type { LngLat } from '../types/telemetry';

// ── Mock the Draw plugin ─────────────────────────────────────────────────────
// A minimal stand-in whose getAll() is controllable per instance. Defined via
// vi.hoisted so it exists before the hoisted vi.mock factory references it.

interface FakeDraw {
  options: unknown;
  features: GeoJSON.FeatureCollection;
  deleteAll: ReturnType<typeof vi.fn>;
  changeMode: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
}

const { drawInstances, FakeDrawCtor } = vi.hoisted(() => {
  const instances: FakeDraw[] = [];
  class FakeDrawImpl {
    options: unknown;
    features: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
    deleteAll = vi.fn(function (this: FakeDrawImpl) {
      this.features = { type: 'FeatureCollection', features: [] };
      return this;
    });
    changeMode = vi.fn(function (this: FakeDrawImpl) {
      return this;
    });
    getAll = vi.fn(function (this: FakeDrawImpl) {
      return this.features;
    });
    constructor(options: unknown) {
      this.options = options;
      instances.push(this as unknown as FakeDraw);
    }
  }
  return { drawInstances: instances, FakeDrawCtor: FakeDrawImpl };
});

vi.mock('@mapbox/mapbox-gl-draw', () => ({ default: FakeDrawCtor }));

// Imported AFTER the mock is declared (vi.mock is hoisted regardless).
import {
  useMapboxDraw,
  extractPolygonRing,
  POLYGON_ONLY_DRAW_OPTIONS,
  MIN_POLYGON_VERTICES,
} from './useMapboxDraw';

// ── Fake mapboxgl.Map ────────────────────────────────────────────────────────

function makeMap() {
  const handlers: Record<string, Array<(e?: unknown) => void>> = {};
  const controls = new Set<unknown>();
  return {
    on: vi.fn((ev: string, cb: (e?: unknown) => void) => {
      (handlers[ev] ??= []).push(cb);
    }),
    off: vi.fn((ev: string, cb: (e?: unknown) => void) => {
      handlers[ev] = (handlers[ev] ?? []).filter((f) => f !== cb);
    }),
    addControl: vi.fn((c: unknown) => controls.add(c)),
    removeControl: vi.fn((c: unknown) => controls.delete(c)),
    hasControl: vi.fn((c: unknown) => controls.has(c)),
    // test affordance
    fire: (ev: string, e?: unknown) => (handlers[ev] ?? []).slice().forEach((f) => f(e)),
    listenerCount: (ev: string) => (handlers[ev] ?? []).length,
    controlCount: () => controls.size,
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asMap = (m: ReturnType<typeof makeMap>) => m as any;

const polyFC = (ring: number[][]): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }],
});

afterEach(() => {
  drawInstances.length = 0;
  vi.clearAllMocks();
});

// ── extractPolygonRing (pure) ────────────────────────────────────────────────

describe('extractPolygonRing', () => {
  it('drops the closing duplicate vertex (GeoJSON closed ring → open ring)', () => {
    expect(extractPolygonRing(polyFC([[0, 0], [1, 0], [1, 1], [0, 0]]))).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it('returns an already-open ring unchanged', () => {
    expect(extractPolygonRing(polyFC([[0, 0], [1, 0], [1, 1]]))).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it('returns [] for an empty collection', () => {
    expect(extractPolygonRing({ type: 'FeatureCollection', features: [] })).toEqual([]);
  });

  it('returns [] when the first/only feature is not a Polygon', () => {
    expect(
      extractPolygonRing({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }],
      }),
    ).toEqual([]);
  });

  it('finds the Polygon even past a leading non-Polygon feature', () => {
    expect(
      extractPolygonRing({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [9, 9] } },
          { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
        ],
      }),
    ).toEqual([[0, 0], [1, 0], [1, 1]]);
  });
});

describe('extractPolygonRing — [BUG B3-1 FIXED] ≥3-vertex validity guard', () => {
  it('rejects a degenerate 2-point closed ring as []', () => {
    // A degenerate ring (fast double-click / aborted draw) collapses to one
    // vertex; the guard now rejects anything below MIN_POLYGON_VERTICES so
    // getPolygon() can never hand D1 an invalid sub-triangle.
    expect(extractPolygonRing(polyFC([[0, 0], [0, 0]]))).toEqual([]);
  });

  it('rejects an in-progress 2-vertex open ring (mid-draw update) as []', () => {
    expect(extractPolygonRing(polyFC([[0, 0], [1, 1]]))).toEqual([]);
  });

  it('still accepts a valid 3-vertex polygon', () => {
    expect(extractPolygonRing(polyFC([[0, 0], [1, 0], [1, 1], [0, 0]]))).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it('MIN_POLYGON_VERTICES is 3 (matches the START_MISSION gate)', () => {
    expect(MIN_POLYGON_VERTICES).toBe(3);
  });
});

// ── Hook: handle + event wiring ──────────────────────────────────────────────

describe('useMapboxDraw — mount / handle', () => {
  it('exposes locked polygon-only construction options', () => {
    expect(POLYGON_ONLY_DRAW_OPTIONS).toMatchObject({
      displayControlsDefault: false,
      controls: { polygon: true, trash: true },
    });
  });

  it('does nothing until the map is non-null', () => {
    const { result } = renderHook(() => useMapboxDraw({ map: null }));
    expect(result.current.instance).toBeNull();
    expect(result.current.getPolygon()).toEqual([]);
    expect(drawInstances).toHaveLength(0);
  });

  it('mounts the draw control once the map is provided', () => {
    const m = makeMap();
    const { result } = renderHook(() => useMapboxDraw({ map: asMap(m) }));
    expect(drawInstances).toHaveLength(1);
    expect(m.addControl).toHaveBeenCalledTimes(1);
    expect(result.current.instance).toBe(drawInstances[0]);
    // create/update/delete all wired
    expect(m.listenerCount('draw.create')).toBe(1);
    expect(m.listenerCount('draw.update')).toBe(1);
    expect(m.listenerCount('draw.delete')).toBe(1);
  });

  it('startDrawing clears prior geometry and enters draw_polygon mode', () => {
    const m = makeMap();
    const { result } = renderHook(() => useMapboxDraw({ map: asMap(m) }));
    act(() => result.current.startDrawing());
    const draw = drawInstances[0];
    expect(draw.deleteAll).toHaveBeenCalledTimes(1);
    expect(draw.changeMode).toHaveBeenCalledWith('draw_polygon');
  });

  it('emits the open ring on draw.create / draw.update', () => {
    const m = makeMap();
    const onPerimeterDrawn = vi.fn();
    renderHook(() => useMapboxDraw({ map: asMap(m), onPerimeterDrawn }));
    const draw = drawInstances[0];
    draw.features = polyFC([[0, 0], [2, 0], [2, 2], [0, 0]]);

    act(() => m.fire('draw.create'));
    expect(onPerimeterDrawn).toHaveBeenLastCalledWith([[0, 0], [2, 0], [2, 2]]);

    draw.features = polyFC([[0, 0], [3, 0], [3, 3], [0, 0]]);
    act(() => m.fire('draw.update'));
    expect(onPerimeterDrawn).toHaveBeenLastCalledWith([[0, 0], [3, 0], [3, 3]]);
  });

  it('clear() empties the geometry and emits []', () => {
    const m = makeMap();
    const onPerimeterDrawn = vi.fn();
    const { result } = renderHook(() => useMapboxDraw({ map: asMap(m), onPerimeterDrawn }));
    drawInstances[0].features = polyFC([[0, 0], [1, 0], [1, 1], [0, 0]]);

    act(() => result.current.clear());
    expect(drawInstances[0].deleteAll).toHaveBeenCalled();
    expect(onPerimeterDrawn).toHaveBeenLastCalledWith([]);
  });

  it('getPolygon() reads the live draw geometry as an open ring', () => {
    const m = makeMap();
    const { result } = renderHook(() => useMapboxDraw({ map: asMap(m) }));
    drawInstances[0].features = polyFC([[1, 1], [2, 1], [2, 2], [1, 1]]);
    expect(result.current.getPolygon()).toEqual([[1, 1], [2, 1], [2, 2]]);
  });

  it('autoStart enters draw_polygon immediately', () => {
    const m = makeMap();
    renderHook(() => useMapboxDraw({ map: asMap(m), autoStart: true }));
    expect(drawInstances[0].changeMode).toHaveBeenCalledWith('draw_polygon');
  });

  it('keeps a stable handle identity across re-renders', () => {
    const m = makeMap();
    const { result, rerender } = renderHook(() => useMapboxDraw({ map: asMap(m) }));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('tears the control + listeners down on unmount', () => {
    const m = makeMap();
    const { unmount } = renderHook(() => useMapboxDraw({ map: asMap(m) }));
    unmount();
    expect(m.removeControl).toHaveBeenCalledTimes(1);
    expect(m.listenerCount('draw.create')).toBe(0);
    expect(m.listenerCount('draw.update')).toBe(0);
    expect(m.listenerCount('draw.delete')).toBe(0);
  });

  it('does not re-subscribe listeners when only the callback identity changes', () => {
    const m = makeMap();
    const { rerender } = renderHook(
      ({ cb }: { cb: (c: LngLat[]) => void }) => useMapboxDraw({ map: asMap(m), onPerimeterDrawn: cb }),
      { initialProps: { cb: vi.fn() } },
    );
    rerender({ cb: vi.fn() }); // new inline callback each render
    // addControl ran exactly once → the draw.* effect did not re-run.
    expect(m.addControl).toHaveBeenCalledTimes(1);
  });
});

// ── Break attempts / bug documentation ───────────────────────────────────────

describe('useMapboxDraw — [BUG B3-2 FIXED] startDrawing() notifies the perimeter callback', () => {
  it('wipes the existing polygon AND emits [] so the consumer stays in sync', () => {
    const m = makeMap();
    const onPerimeterDrawn = vi.fn();
    const { result } = renderHook(() => useMapboxDraw({ map: asMap(m), onPerimeterDrawn }));

    // Operator draws a valid polygon → consumer (D1) buffers a 3-vertex ring.
    drawInstances[0].features = polyFC([[0, 0], [1, 0], [1, 1], [0, 0]]);
    act(() => m.fire('draw.create'));
    expect(onPerimeterDrawn).toHaveBeenLastCalledWith([[0, 0], [1, 0], [1, 1]]);
    onPerimeterDrawn.mockClear();

    // Operator hits "draw again": startDrawing() deleteAll's the geometry…
    act(() => result.current.startDrawing());

    // …and now, like clear(), it emits [] so the consumer drops the stale
    // perimeter before the replacement polygon is drawn.
    expect(drawInstances[0].deleteAll).toHaveBeenCalled();
    expect(onPerimeterDrawn).toHaveBeenCalledWith([]);
    expect(drawInstances[0].changeMode).toHaveBeenCalledWith('draw_polygon');
    expect(result.current.getPolygon()).toEqual([]); // live geometry is empty
  });
});
