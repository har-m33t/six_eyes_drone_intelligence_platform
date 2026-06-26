/**
 * Resilience test — Module B · TacticalMap, the "map must not blank the app" fix.
 *
 * Production reality: with no Mapbox access token configured, `new
 * mapboxgl.Map({ style: 'mapbox://…' })` THROWS synchronously ("An API access
 * token is required to use Mapbox GL.") — it does NOT render blank. That throw
 * lands in TacticalMap's mount effect, and with no error boundary above it the
 * whole React root unmounts → blank page ("frontend is down").
 *
 * The fix wraps map construction in try/catch and renders a fallback. These
 * tests pin that: the Map constructor is mocked to throw (simulating the
 * no-token case) and the component must NOT propagate the throw.
 *
 *   cd frontend && npm test
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mapbox mocked so the Map constructor throws exactly like the no-token case.
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

// Draw is only constructed once a map exists; the map never initialises here, so
// this just keeps the import inert under jsdom.
vi.mock('@mapbox/mapbox-gl-draw', () => ({ default: class {} }));

import { TacticalMap } from './TacticalMap';

describe('TacticalMap — survives a Mapbox init failure', () => {
  it('does not throw out of the mount effect when the Map constructor throws', () => {
    expect(() => render(<TacticalMap />)).not.toThrow();
  });

  it('renders the MAP UNAVAILABLE fallback (so the panel stays usable)', () => {
    render(<TacticalMap />);
    expect(screen.getByText('MAP UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // Container still present — layout is unaffected.
    expect(screen.getByTestId('tactical-map')).toHaveClass('tactical-map--error');
  });
});
