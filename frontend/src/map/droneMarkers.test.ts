/**
 * Code-review test suite — Module B · Task B2 (`DroneMarkerCache` / `useDroneMarkers`).
 *
 * Covers the imperative marker cache (lazy create, in-place move, dirty-checked
 * DOM writes, prune) and the React glue hook, AND "try to break it" cases that
 * document the bugs found in the review (see `.claude/module_b_review.md`).
 * Bug-documenting cases are tagged `[BUG B2-n]` and assert the CURRENT behaviour
 * so the suite stays green and the regression is pinned; flip the assertion when
 * the bug is fixed.
 *
 * `mapbox-gl` is mocked with a fake `Marker` (its real runtime needs WebGL that
 * jsdom cannot provide). The marker's custom HTML element IS built by the code
 * under test via jsdom's `document`, so DOM assertions are real.
 *
 *   cd frontend && npm test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// ── Mock mapbox-gl Marker ────────────────────────────────────────────────────

interface FakeMarker {
  element: HTMLElement;
  lngLat: [number, number] | null;
  setLngLat: ReturnType<typeof vi.fn>;
  addTo: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

const { markers, MarkerCtor } = vi.hoisted(() => {
  const created: FakeMarker[] = [];
  class FakeMarkerImpl {
    element: HTMLElement;
    lngLat: [number, number] | null = null;
    setLngLat = vi.fn(function (this: FakeMarkerImpl, ll: [number, number]) {
      this.lngLat = ll;
      return this;
    });
    addTo = vi.fn(function (this: FakeMarkerImpl) {
      return this;
    });
    remove = vi.fn(function (this: FakeMarkerImpl) {
      return this;
    });
    constructor(opts: { element: HTMLElement }) {
      this.element = opts.element;
      created.push(this as unknown as FakeMarker);
    }
  }
  return { markers: created, MarkerCtor: FakeMarkerImpl };
});

vi.mock('mapbox-gl', () => ({ default: { Marker: MarkerCtor } }));

import type { Map as MapboxMap } from 'mapbox-gl';
import { DroneMarkerCache, statusColor, useDroneMarkers } from './droneMarkers';
import type { DronePosition } from '../store/useSwarmStore';

// A throwaway map; the cache only passes it to Marker.addTo (mocked).
const fakeMap = {} as unknown as MapboxMap;

const pos = (over: Partial<DronePosition> = {}): DronePosition => ({
  id: 'DRONE_1',
  lng: 10,
  lat: 20,
  status: 'ONLINE',
  hasDetection: false,
  coverageActive: true,
  ...over,
});

/** The `.drone-marker` dot inside a created marker's element. */
const dotOf = (m: FakeMarker) => m.element.querySelector('.drone-marker') as HTMLElement;

afterEach(() => {
  markers.length = 0;
  vi.clearAllMocks();
});

// ── statusColor ──────────────────────────────────────────────────────────────

describe('statusColor', () => {
  it('maps each status to its glow color', () => {
    expect(statusColor('ONLINE')).toBe('#a78bfa');
    expect(statusColor('WARNING')).toBe('#ffb84d');
    expect(statusColor('CRITICAL')).toBe('#ff5c5c');
  });

  it('defaults unknown statuses to the ONLINE purple', () => {
    // @ts-expect-error — exercising a malformed status at runtime
    expect(statusColor('BOGUS')).toBe('#a78bfa');
  });
});

// ── DroneMarkerCache ─────────────────────────────────────────────────────────

describe('DroneMarkerCache — create & update', () => {
  it('lazily creates one marker on a drone’s first valid fix', () => {
    const cache = new DroneMarkerCache(fakeMap);
    cache.update(pos());
    expect(markers).toHaveLength(1);
    expect(cache.has('DRONE_1')).toBe(true);
    expect(cache.size).toBe(1);
    expect(markers[0].lngLat).toEqual([10, 20]);
    expect(markers[0].addTo).toHaveBeenCalledTimes(1);
  });

  it('labels the dot with the short drone id and the status color', () => {
    const cache = new DroneMarkerCache(fakeMap);
    cache.update(pos({ status: 'CRITICAL' }));
    const dot = dotOf(markers[0]);
    expect(dot.querySelector('.drone-marker-label')?.textContent).toBe('D1');
    expect(dot.style.getPropertyValue('--marker-color')).toBe('#ff5c5c');
  });

  it('moves the marker in place when coords change (no re-create)', () => {
    const cache = new DroneMarkerCache(fakeMap);
    cache.update(pos());
    cache.update(pos({ lng: 11, lat: 21 }));
    expect(markers).toHaveLength(1); // not re-created
    expect(markers[0].setLngLat).toHaveBeenCalledTimes(2); // ctor + move
    expect(markers[0].lngLat).toEqual([11, 21]);
  });

  it('does NOT touch the DOM when nothing changed (20 Hz jitter guard)', () => {
    const cache = new DroneMarkerCache(fakeMap);
    cache.update(pos());
    markers[0].setLngLat.mockClear();
    const dot = dotOf(markers[0]);
    const colorSpy = vi.spyOn(dot.style, 'setProperty');
    const classSpy = vi.spyOn(dot.classList, 'toggle');

    cache.update(pos()); // identical packet
    expect(markers[0].setLngLat).not.toHaveBeenCalled();
    expect(colorSpy).not.toHaveBeenCalled();
    expect(classSpy).not.toHaveBeenCalled();
  });

  it('recolors only when status flips', () => {
    const cache = new DroneMarkerCache(fakeMap);
    cache.update(pos({ status: 'ONLINE' }));
    const dot = dotOf(markers[0]);
    cache.update(pos({ status: 'WARNING' }));
    expect(dot.style.getPropertyValue('--marker-color')).toBe('#ffb84d');
  });

  it('toggles the detection ring only on edge changes', () => {
    const cache = new DroneMarkerCache(fakeMap);
    cache.update(pos({ hasDetection: false }));
    const dot = dotOf(markers[0]);
    expect(dot.classList.contains('detected')).toBe(false);
    cache.update(pos({ hasDetection: true }));
    expect(dot.classList.contains('detected')).toBe(true);
    cache.update(pos({ hasDetection: false }));
    expect(dot.classList.contains('detected')).toBe(false);
  });

  it('rejects non-finite coordinates without creating a marker', () => {
    const cache = new DroneMarkerCache(fakeMap);
    cache.update(pos({ lng: Number.NaN }));
    cache.update(pos({ lat: Number.POSITIVE_INFINITY }));
    expect(markers).toHaveLength(0);
    expect(cache.size).toBe(0);
  });
});

describe('DroneMarkerCache — sync / prune / remove / clear', () => {
  it('syncs an array of positions into individual markers', () => {
    const cache = new DroneMarkerCache(fakeMap);
    cache.sync([pos({ id: 'DRONE_1' }), pos({ id: 'DRONE_2' })]);
    expect(cache.size).toBe(2);
  });

  it('keeps stale markers by default (a packet gap must not drop a dot)', () => {
    const cache = new DroneMarkerCache(fakeMap);
    cache.sync([pos({ id: 'DRONE_1' }), pos({ id: 'DRONE_2' })]);
    cache.sync([pos({ id: 'DRONE_1' })]); // DRONE_2 absent this tick
    expect(cache.has('DRONE_2')).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('prunes markers absent from the array when asked', () => {
    const cache = new DroneMarkerCache(fakeMap);
    cache.sync([pos({ id: 'DRONE_1' }), pos({ id: 'DRONE_2' })]);
    cache.sync([pos({ id: 'DRONE_1' })], { prune: true });
    expect(cache.has('DRONE_2')).toBe(false);
    expect(cache.size).toBe(1);
  });

  it('remove() and clear() detach markers from the map', () => {
    const cache = new DroneMarkerCache(fakeMap);
    cache.sync([pos({ id: 'DRONE_1' }), pos({ id: 'DRONE_2' })]);
    cache.remove('DRONE_1');
    expect(cache.has('DRONE_1')).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
    // every created marker had remove() called (1 via remove, rest via clear)
    expect(markers.every((m) => m.remove.mock.calls.length >= 1)).toBe(true);
  });
});

// ── useDroneMarkers hook ─────────────────────────────────────────────────────

describe('useDroneMarkers', () => {
  it('does not build a cache until the map is non-null', () => {
    const { result } = renderHook(
      ({ map }: { map: MapboxMap | null }) => useDroneMarkers(map, [pos()]),
      { initialProps: { map: null as MapboxMap | null } },
    );
    expect(result.current.current).toBeNull();
  });

  it('builds the cache and syncs positions once the map is provided', () => {
    const positions = [pos({ id: 'DRONE_1' }), pos({ id: 'DRONE_2' })];
    const { result } = renderHook(() => useDroneMarkers(fakeMap, positions));
    expect(result.current.current?.size).toBe(2);
  });

  it('clears the cache on unmount', () => {
    const { result, unmount } = renderHook(() => useDroneMarkers(fakeMap, [pos()]));
    const cache = result.current.current!;
    unmount();
    expect(cache.size).toBe(0);
    expect(result.current.current).toBeNull();
  });
});

// ── Break attempts / bug documentation ───────────────────────────────────────

describe('useDroneMarkers — [BUG B2-1 FIXED] markers paint the moment the map readies', () => {
  it('syncs a stable positions array immediately when the map arrives late', () => {
    // Real timeline: positions populate from the store first, then the map
    // finishes loading. The sync effect now depends on `[map, positions, prune]`,
    // so a null→ready map flip re-syncs against the freshly-built cache even when
    // the positions reference never changes (frozen / paused stream).
    const positions = [pos({ id: 'DRONE_1' })]; // STABLE reference across renders
    const { result, rerender } = renderHook(
      ({ map }: { map: MapboxMap | null }) => useDroneMarkers(map, positions),
      { initialProps: { map: null as MapboxMap | null } },
    );
    expect(result.current.current).toBeNull();

    // Map becomes ready, positions reference unchanged.
    rerender({ map: fakeMap });

    // Cache built AND synced → the drone is drawn without waiting for a tick.
    expect(result.current.current).not.toBeNull();
    expect(result.current.current?.size).toBe(1);
  });

  it('keeps markers in sync across subsequent positions updates', () => {
    let positions = [pos({ id: 'DRONE_1' })];
    const { result, rerender } = renderHook(
      ({ map }: { map: typeof fakeMap | null }) => useDroneMarkers(map, positions),
      { initialProps: { map: fakeMap as typeof fakeMap | null } },
    );
    expect(result.current.current?.size).toBe(1);

    act(() => {
      positions = [pos({ id: 'DRONE_1' }), pos({ id: 'DRONE_2' })];
    });
    rerender({ map: fakeMap });
    expect(result.current.current?.size).toBe(2);
  });
});
