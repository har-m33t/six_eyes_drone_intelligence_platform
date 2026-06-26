/**
 * Code-review test suite — Module B · Task B1 (`TacticalMap`).
 *
 * Covers map initialisation (style/zoom/center/controls), token + center
 * resolution chains, the onReady/teardown lifecycle, AND the Module-B wiring
 * that B1 now composes onto the map (B2 markers, B3 draw, B4 coverage).
 *
 * The `[BUG B1-n]` cases from the review (`.claude/module_b_review.md`) are now
 * FIXED and assert the corrected behaviour:
 *   - B1-1  `positions` is typed against the store's `DronePosition` shape.
 *   - B1-2  `positions` / `onPerimeterDrawn` are consumed (markers + draw).
 *   - B1-3  `onReady` is read live via a ref.
 *
 * `mapbox-gl` and `@mapbox/mapbox-gl-draw` are mocked with fakes (their real
 * runtime needs WebGL jsdom cannot provide).
 *
 *   cd frontend && npm test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { DronePosition } from '../map/droneMarkers';

// ── Mock mapbox-gl ───────────────────────────────────────────────────────────

interface FakeMap {
  options: Record<string, unknown>;
  controls: Array<{ control: unknown; position?: string }>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  addControl: ReturnType<typeof vi.fn>;
  removeControl: ReturnType<typeof vi.fn>;
  hasControl: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  isStyleLoaded: ReturnType<typeof vi.fn>;
  getSource: ReturnType<typeof vi.fn>;
  addSource: ReturnType<typeof vi.fn>;
  addLayer: ReturnType<typeof vi.fn>;
  getLayer: ReturnType<typeof vi.fn>;
  removeSource: ReturnType<typeof vi.fn>;
  removeLayer: ReturnType<typeof vi.fn>;
  fire: (ev: string) => void;
  fireLoad: () => void;
}

const { maps, navControls, markers, mapboxglMock, drawMock } = vi.hoisted(() => {
  const createdMaps: FakeMap[] = [];
  const createdNav: Array<Record<string, unknown>> = [];
  const createdMarkers: Array<Record<string, unknown>> = [];

  // Mutable geometry the fake MapboxDraw hands back from getAll(); a closed
  // triangle by default → extractPolygonRing yields 3 open vertices.
  const draw = {
    geometry: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
          properties: {},
        },
      ],
    } as unknown,
  };

  class FakeMapImpl {
    options: Record<string, unknown>;
    controls: Array<{ control: unknown; position?: string }> = [];
    private handlers: Record<string, Array<() => void>> = {};
    on = vi.fn((ev: string, cb: () => void) => {
      (this.handlers[ev] ??= []).push(cb);
    });
    off = vi.fn((ev: string, cb: () => void) => {
      this.handlers[ev] = (this.handlers[ev] ?? []).filter((h) => h !== cb);
    });
    addControl = vi.fn((control: unknown, position?: string) => {
      this.controls.push({ control, position });
    });
    removeControl = vi.fn((control: unknown) => {
      this.controls = this.controls.filter((c) => c.control !== control);
    });
    hasControl = vi.fn(() => true);
    remove = vi.fn();
    isStyleLoaded = vi.fn(() => false);
    getSource = vi.fn(() => undefined);
    addSource = vi.fn();
    addLayer = vi.fn();
    getLayer = vi.fn(() => undefined);
    removeSource = vi.fn();
    removeLayer = vi.fn();
    fire = (ev: string) => (this.handlers[ev] ?? []).slice().forEach((cb) => cb());
    fireLoad = () => this.fire('load');
    constructor(options: Record<string, unknown>) {
      this.options = options;
      createdMaps.push(this as unknown as FakeMap);
    }
  }
  class FakeNavControl {
    constructor(opts: Record<string, unknown>) {
      createdNav.push(opts);
    }
  }
  class FakeMarker {
    setLngLat = vi.fn(() => this);
    addTo = vi.fn(() => this);
    remove = vi.fn();
    constructor(opts: Record<string, unknown>) {
      createdMarkers.push(opts);
    }
  }
  class FakeDraw {
    getAll = vi.fn(() => draw.geometry);
    deleteAll = vi.fn();
    changeMode = vi.fn();
  }

  const mapboxgl = {
    accessToken: '',
    Map: FakeMapImpl,
    NavigationControl: FakeNavControl,
    Marker: FakeMarker,
  };
  return {
    maps: createdMaps,
    navControls: createdNav,
    markers: createdMarkers,
    mapboxglMock: mapboxgl,
    drawMock: FakeDraw,
  };
});

vi.mock('mapbox-gl', () => ({ default: mapboxglMock }));
vi.mock('@mapbox/mapbox-gl-draw', () => ({ default: drawMock }));

import { TacticalMap } from './TacticalMap';
import { CoverageHeatmap } from '../map/coverageHeatmap';

/** A store-shaped position (`DronePosition` from the A2 store / B2 marker module). */
function pos(overrides: Partial<DronePosition> = {}): DronePosition {
  return {
    id: 'DRONE_1',
    lng: 1,
    lat: 2,
    status: 'ONLINE',
    hasDetection: false,
    coverageActive: false,
    ...overrides,
  };
}

beforeEach(() => {
  mapboxglMock.accessToken = '';
  delete window.SIX_EYES_CONFIG;
});

afterEach(() => {
  maps.length = 0;
  navControls.length = 0;
  markers.length = 0;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ── Initialisation ───────────────────────────────────────────────────────────

describe('TacticalMap — initialisation', () => {
  it('renders the map container', () => {
    const { getByTestId } = render(<TacticalMap accessToken="tok" />);
    expect(getByTestId('tactical-map')).toBeInTheDocument();
  });

  it('initialises Mapbox with the tactical defaults', () => {
    render(<TacticalMap accessToken="tok" />);
    expect(maps).toHaveLength(1);
    expect(maps[0].options).toMatchObject({
      style: 'mapbox://styles/mapbox/dark-v11',
      zoom: 14,
      center: [0, 0],
      attributionControl: false,
    });
  });

  it('adds a top-right NavigationControl with pitch viz disabled', () => {
    render(<TacticalMap accessToken="tok" />);
    expect(navControls[0]).toEqual({ visualizePitch: false });
    expect(maps[0].controls[0].position).toBe('top-right');
  });

  it('honours an explicit initialCenter / initialZoom', () => {
    render(<TacticalMap accessToken="tok" initialCenter={[12, 34]} initialZoom={9} />);
    expect(maps[0].options.center).toEqual([12, 34]);
    expect(maps[0].options.zoom).toBe(9);
  });
});

// ── Token + center resolution ────────────────────────────────────────────────

describe('TacticalMap — token resolution', () => {
  it('prefers the explicit accessToken prop', () => {
    render(<TacticalMap accessToken="explicit-token" />);
    expect(mapboxglMock.accessToken).toBe('explicit-token');
  });

  it('falls back to window.SIX_EYES_CONFIG when no prop/env token', () => {
    window.SIX_EYES_CONFIG = { MAPBOX_ACCESS_TOKEN: 'legacy-token' };
    render(<TacticalMap />);
    expect(mapboxglMock.accessToken).toBe('legacy-token');
  });

  it('warns (does not throw) and renders blank when no token is configured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<TacticalMap />);
    expect(warn).toHaveBeenCalledOnce();
    expect(mapboxglMock.accessToken).toBe('');
    expect(maps).toHaveLength(1); // still constructs the (blank) map
  });
});

describe('TacticalMap — center resolution', () => {
  it('uses window.SIX_EYES_CONFIG.INITIAL_MAP_CENTER when no prop center', () => {
    window.SIX_EYES_CONFIG = { MAPBOX_ACCESS_TOKEN: 't', INITIAL_MAP_CENTER: [5, 6] };
    render(<TacticalMap />);
    expect(maps[0].options.center).toEqual([5, 6]);
  });

  it('ignores a malformed config center and uses [0,0]', () => {
    // Non-finite pair must not propagate to Mapbox.
    window.SIX_EYES_CONFIG = {
      MAPBOX_ACCESS_TOKEN: 't',
      INITIAL_MAP_CENTER: [Number.NaN, 6] as [number, number],
    };
    render(<TacticalMap />);
    expect(maps[0].options.center).toEqual([0, 0]);
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('TacticalMap — lifecycle', () => {
  it('fires onReady with the map on the load event', () => {
    const onReady = vi.fn();
    render(<TacticalMap accessToken="t" onReady={onReady} />);
    expect(onReady).not.toHaveBeenCalled(); // not until load
    maps[0].fireLoad();
    expect(onReady).toHaveBeenCalledWith(maps[0]);
  });

  it('removes the map on unmount', () => {
    const { unmount } = render(<TacticalMap accessToken="t" />);
    const map = maps[0];
    unmount();
    expect(map.remove).toHaveBeenCalledTimes(1);
  });
});

// ── Module-B wiring (the B1-2 fix) ───────────────────────────────────────────

describe('TacticalMap — [BUG B1-2 FIXED] composes the Module-B layer', () => {
  it('consumes positions (markers) and mounts the polygon draw control', () => {
    const onPerimeterDrawn = vi.fn();
    const onDrawReady = vi.fn();
    render(
      <TacticalMap
        accessToken="t"
        positions={[pos({ id: 'DRONE_1', lng: 10, lat: 20 })]}
        onPerimeterDrawn={onPerimeterDrawn}
        onDrawReady={onDrawReady}
      />,
    );

    // The polygon draw control is mounted alongside the nav control.
    expect(maps[0].controls).toHaveLength(2);
    expect(maps[0].controls[0].position).toBe('top-right'); // nav
    expect(maps[0].controls[1].position).toBe('top-left'); // draw (legacy default)

    // A marker was created for the supplied position (B2 cache, not React state).
    expect(markers).toHaveLength(1);

    // D1 receives the imperative draw handle.
    expect(onDrawReady).toHaveBeenCalledTimes(1);
    expect(onDrawReady.mock.calls[0][0]).toMatchObject({
      startDrawing: expect.any(Function),
      clear: expect.any(Function),
      getPolygon: expect.any(Function),
    });

    // Completing a polygon flows the open ring out through onPerimeterDrawn.
    maps[0].fire('draw.create');
    expect(onPerimeterDrawn).toHaveBeenCalledWith([[0, 0], [1, 0], [1, 1]]);
  });

  it('[BUG B4-5 FIXED] paints the footprint from the nav sweep, not GPS positions', () => {
    render(
      <TacticalMap
        accessToken="t"
        // GPS position drives the marker only (note the far-away coords)…
        positions={[pos({ id: 'DRONE_1', lng: 99, lat: 88 })]}
        // …while the nav search-sweep position drives the footprint.
        coveragePositions={[{ id: 'DRONE_2', lng: 5, lat: 5, coverageActive: true }]}
      />,
    );
    maps[0].fireLoad();

    // The coverage source registers with the buffered footprint, painted at the
    // NAV coordinate (5,5) — NOT the GPS marker coordinate (99,88).
    expect(maps[0].addSource).toHaveBeenCalledWith('coverage-source', expect.anything());
    const data = maps[0].addSource.mock.calls[0][1].data;
    expect(data.features.length).toBeGreaterThan(0);
    expect(data.features[0].geometry.coordinates).toEqual([5, 5]);

    // The GPS position still produced exactly one marker.
    expect(markers).toHaveLength(1);
  });

  it('[BUG B4-5 FIXED] does NOT paint coverage from GPS positions alone', () => {
    render(
      <TacticalMap
        accessToken="t"
        positions={[pos({ id: 'DRONE_2', lng: 5, lat: 5, coverageActive: true })]}
      />,
    );
    maps[0].fireLoad();

    // Source/layer still register (attach is unconditional), but with NO points —
    // GPS no longer drives the footprint.
    expect(maps[0].addLayer).toHaveBeenCalled();
    const data = maps[0].addSource.mock.calls[0][1].data;
    expect(data.features.length).toBe(0);
  });

  it('breaks the segment for a transiting drone (coverageActive false) — no point', () => {
    render(
      <TacticalMap
        accessToken="t"
        coveragePositions={[{ id: 'DRONE_3', lng: 7, lat: 7, coverageActive: false }]}
      />,
    );
    maps[0].fireLoad();
    const data = maps[0].addSource.mock.calls[0][1].data;
    expect(data.features.length).toBe(0);
  });
});

// ── onReady liveness (the B1-3 fix) ──────────────────────────────────────────

describe('TacticalMap — [BUG B1-3 FIXED] onReady is read live', () => {
  it('invokes the latest onReady (not a stale closure) and never recreates the map', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<TacticalMap accessToken="t" onReady={first} />);
    rerender(<TacticalMap accessToken="t" onReady={second} initialCenter={[99, 99]} />);

    // Empty-dep init effect → still one map; init args (center) captured once.
    expect(maps).toHaveLength(1);
    expect(maps[0].options.center).toEqual([0, 0]); // [99,99] correctly ignored

    // load now invokes the CURRENT handler, not the one from first render.
    maps[0].fireLoad();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(maps[0]);
  });
});

// ── Coverage footprint wiped on a new mission (the B4-4 fix) ──────────────────

describe('TacticalMap — [BUG B4-4 FIXED] coverage footprint clears on a new mission', () => {
  it('does NOT clear the footprint on first mount', () => {
    const clearSpy = vi.spyOn(CoverageHeatmap.prototype, 'clear');
    render(<TacticalMap accessToken="t" coverageEpoch={0} />);
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('clears the footprint when coverageEpoch increments (deploy / clear)', () => {
    const clearSpy = vi.spyOn(CoverageHeatmap.prototype, 'clear');
    const { rerender } = render(<TacticalMap accessToken="t" coverageEpoch={0} />);
    expect(clearSpy).not.toHaveBeenCalled();

    rerender(<TacticalMap accessToken="t" coverageEpoch={1} />);
    expect(clearSpy).toHaveBeenCalledTimes(1);

    // A re-render with the SAME epoch must not re-clear (idempotent).
    rerender(<TacticalMap accessToken="t" coverageEpoch={1} />);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves the footprint alone when coverageEpoch is not supplied', () => {
    const clearSpy = vi.spyOn(CoverageHeatmap.prototype, 'clear');
    const { rerender } = render(<TacticalMap accessToken="t" />);
    rerender(<TacticalMap accessToken="t" positions={[pos({ coverageActive: true })]} />);
    expect(clearSpy).not.toHaveBeenCalled();
  });
});
