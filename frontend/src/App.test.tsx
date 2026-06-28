/**
 * Integration test — the app boots even when the Mapbox map fails to load.
 *
 * Before the fix, a missing Mapbox token made TacticalMap's map-init throw,
 * which (with no error boundary) unmounted the entire dashboard → blank page.
 * This asserts the whole tree still mounts: the map shows its fallback AND the
 * surrounding chrome (deploy controls, panels) renders normally.
 *
 *   cd frontend && npm test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Simulate production-with-no-token: the Map constructor throws.
vi.mock('mapbox-gl', () => {
  class ThrowingMap {
    constructor() {
      throw new Error('An API access token is required to use Mapbox GL.');
    }
  }
  class NavigationControl {}
  class Marker {
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      return this;
    }
    getElement() {
      return document.createElement('div');
    }
  }
  return { default: { Map: ThrowingMap, NavigationControl, Marker, accessToken: '' } };
});

vi.mock('@mapbox/mapbox-gl-draw', () => ({ default: class {} }));

import App from './App';
import { useSwarmStore } from './store/useSwarmStore';
import { DRONE_IDS } from './constants/drones';
import { makeDronePacket, FAKE_FRAME_B64 } from './test/factories';

describe('App — does not blank out when the map fails', () => {
  it('mounts the dashboard chrome and a map fallback instead of crashing', () => {
    expect(() => render(<App />)).not.toThrow();

    // Map panel degraded gracefully…
    expect(screen.getByText('MAP UNAVAILABLE')).toBeInTheDocument();

    // …and the rest of the dashboard still rendered (Module D deploy control +
    // a Module C panel title), proving the failure stayed contained.
    expect(screen.getByText('DEPLOY SWARM')).toBeInTheDocument();
    expect(screen.getByText('DRAW AREA')).toBeInTheDocument();
  });
});

// ui-fixes.md #2 — the "LIVE FEEDS · N/6 ONLINE" badge must count feeds that are
// actually streaming video, not health-online drones, so it can never claim
// feeds the operator cannot see.
describe('App — LIVE FEEDS count reflects streaming video, not health', () => {
  beforeEach(() => {
    // The store is a process-wide singleton; clear it so seeded packets from one
    // case do not leak into the next.
    useSwarmStore.setState({ drones: {}, seenAlerts: [], alertCount: 0 });
  });

  it('reports 0/6 when all drones are health-online but no live frames are flowing', () => {
    // Six healthy drones (ONLINE / STRONG) with NO video frame.
    for (const id of DRONE_IDS) {
      useSwarmStore.getState().applyDronePacket(makeDronePacket({ drone_id: id }));
    }

    const { container } = render(<App />);

    // Header is honest: nothing is LIVE-streaming, so the badge reads 0/6 — not
    // the old health-derived "6/6 ONLINE" that contradicted the absence of a
    // live feed.
    expect(screen.getByText('0/6 ONLINE')).toBeInTheDocument();
    expect(screen.queryByText('6/6 ONLINE')).toBeNull();
    // Video is backend-streamed only: with no frames flowing, every tile shows
    // the NO SIGNAL placeholder rather than looping a local MP4, so the grid
    // honestly reflects that no live feed is arriving from the producer.
    expect(container.querySelectorAll('video')).toHaveLength(0);
    expect(container.querySelectorAll('.feed-placeholder')).toHaveLength(6);
  });

  it('reports 6/6 once every feed is actually streaming a frame', () => {
    for (const id of DRONE_IDS) {
      useSwarmStore
        .getState()
        .applyDronePacket(makeDronePacket({ drone_id: id, frame_b64: FAKE_FRAME_B64 }));
    }

    const { container } = render(<App />);

    expect(screen.getByText('6/6 ONLINE')).toBeInTheDocument();
    expect(container.querySelectorAll('.feed-placeholder')).toHaveLength(0);
  });
});
