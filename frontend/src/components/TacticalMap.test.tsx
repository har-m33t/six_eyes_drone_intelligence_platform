/**
 * Code-review test suite — Module B · Task B1 (`TacticalMap`).
 *
 * Covers map initialisation (style/zoom/center/controls), token + center
 * resolution chains, and the onReady/teardown lifecycle, AND "try to break it"
 * cases that document the bugs found in the review (see
 * `.claude/module_b_review.md`). Bug-documenting cases are tagged `[BUG B1-n]`
 * and assert the CURRENT behaviour so the suite stays green and the regression
 * is pinned; flip the assertion when the bug is fixed.
 *
 * `mapbox-gl` is mocked with a fake `Map`/`NavigationControl` (its real runtime
 * needs WebGL jsdom cannot provide).
 *
 *   cd frontend && npm test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

// ── Mock mapbox-gl ───────────────────────────────────────────────────────────

interface FakeMap {
  options: Record<string, unknown>;
  controls: Array<{ control: unknown; position?: string }>;
  on: ReturnType<typeof vi.fn>;
  addControl: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  fireLoad: () => void;
}

const { maps, navControls, mapboxglMock } = vi.hoisted(() => {
  const createdMaps: FakeMap[] = [];
  const createdNav: Array<Record<string, unknown>> = [];

  class FakeMapImpl {
    options: Record<string, unknown>;
    controls: Array<{ control: unknown; position?: string }> = [];
    private loadCbs: Array<() => void> = [];
    on = vi.fn((ev: string, cb: () => void) => {
      if (ev === 'load') this.loadCbs.push(cb);
    });
    addControl = vi.fn((control: unknown, position?: string) => {
      this.controls.push({ control, position });
    });
    remove = vi.fn();
    fireLoad = () => this.loadCbs.slice().forEach((cb) => cb());
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
  const mock = {
    accessToken: '',
    Map: FakeMapImpl,
    NavigationControl: FakeNavControl,
  };
  return { maps: createdMaps, navControls: createdNav, mapboxglMock: mock };
});

vi.mock('mapbox-gl', () => ({ default: mapboxglMock }));

import { TacticalMap } from './TacticalMap';

beforeEach(() => {
  mapboxglMock.accessToken = '';
  delete window.SIX_EYES_CONFIG;
});

afterEach(() => {
  maps.length = 0;
  navControls.length = 0;
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

// ── Break attempts / bug documentation ───────────────────────────────────────

describe('TacticalMap — [BUG B1-2] declared B-task props are never consumed', () => {
  it('ignores `positions` and `onPerimeterDrawn` — the module is wholly unwired', () => {
    const onPerimeterDrawn = vi.fn();
    render(
      <TacticalMap
        accessToken="t"
        // store-shaped positions, as B2's useDroneMarkers would consume
        positions={[
          { drone_id: 'DRONE_1', position: [1, 2] },
        ]}
        onPerimeterDrawn={onPerimeterDrawn}
      />,
    );
    maps[0].fireLoad();
    // B1 never composes useDroneMarkers / useMapboxDraw / CoverageHeatmap, so
    // no markers, no draw control (only the NavigationControl), no callback.
    expect(maps[0].controls).toHaveLength(1); // just the nav control
    expect(onPerimeterDrawn).not.toHaveBeenCalled();
  });
});

describe('TacticalMap — [BUG B1-3] init args captured once; later prop changes are ignored', () => {
  it('does not re-create the map or honour a changed onReady when props change', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<TacticalMap accessToken="t" onReady={first} />);
    rerender(<TacticalMap accessToken="t" onReady={second} initialCenter={[99, 99]} />);

    // Empty-dep effect → still one map, original center, ORIGINAL onReady.
    expect(maps).toHaveLength(1);
    expect(maps[0].options.center).toEqual([0, 0]); // [99,99] ignored
    maps[0].fireLoad();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled(); // stale closure
  });
});
