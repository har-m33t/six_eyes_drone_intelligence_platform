/**
 * Tests for the live sidebar trend charts.
 *
 * Two halves, mirroring the Module-C split:
 *   • pure data/geometry helpers (mapping, averaging, SVG path building) — the
 *     "is it accurate?" contract; and
 *   • the store-connected `TelemetryTrends` sampler — polls the real Zustand
 *     store on a fake-timer cadence and renders the current readouts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';

import {
  TrendChart,
  TelemetryTrends,
  avgBattery,
  signalStrength,
  strengthLabel,
  lastFinite,
  linePath,
  areaPath,
  readSample,
  SIGNAL_STRENGTH,
  SAMPLE_MS,
  MAX_SAMPLES,
} from './TelemetryTrends';
import { useSwarmStore } from '../store/useSwarmStore';
import { makeDronePacket } from '../test/factories';

function resetStore() {
  useSwarmStore.setState({
    drones: {},
    coverage: {},
    globalCoveragePct: 0,
    connection: 'connecting',
    missionStartMs: null,
    seenAlerts: [],
    alertCount: 0,
  });
}

function pushPacket(...args: Parameters<typeof makeDronePacket>) {
  act(() => {
    useSwarmStore.getState().applyDronePacket(makeDronePacket(...args));
  });
}

beforeEach(resetStore);

// ── Pure data mapping ──────────────────────────────────────────────────────

describe('signalStrength', () => {
  it('maps the three real link states onto a 0–100 scale', () => {
    expect(signalStrength('STRONG')).toBe(100);
    expect(signalStrength('WEAK')).toBe(55);
    expect(signalStrength('LOST')).toBe(0);
  });

  it('returns null for a non-reporting drone (chart gap, not a false 0)', () => {
    expect(signalStrength(undefined)).toBeNull();
  });

  it('strengthLabel inverts the mapping for the legend', () => {
    expect(strengthLabel(SIGNAL_STRENGTH.STRONG)).toBe('STRONG');
    expect(strengthLabel(SIGNAL_STRENGTH.WEAK)).toBe('WEAK');
    expect(strengthLabel(SIGNAL_STRENGTH.LOST)).toBe('LOST');
    expect(strengthLabel(null)).toBe('—');
  });
});

describe('avgBattery', () => {
  it('averages only finite batteries', () => {
    const drones = {
      DRONE_1: makeDronePacket({ drone_id: 'DRONE_1', battery: 80 }),
      DRONE_2: makeDronePacket({ drone_id: 'DRONE_2', battery: 60 }),
    };
    expect(avgBattery(drones)).toBe(70);
  });

  it('ignores a drone whose battery is not finite (no NaN poisoning)', () => {
    const drones = {
      DRONE_1: makeDronePacket({ drone_id: 'DRONE_1', battery: 90 }),
      DRONE_2: makeDronePacket({ drone_id: 'DRONE_2', battery: Number.NaN }),
    };
    expect(avgBattery(drones)).toBe(90);
  });

  it('returns null (a gap) when no drone reports a battery', () => {
    expect(avgBattery({})).toBeNull();
  });
});

describe('lastFinite', () => {
  it('finds the most recent finite value across gaps', () => {
    expect(lastFinite([10, null, 20, null])).toBe(20);
    expect(lastFinite([null, null])).toBeNull();
    expect(lastFinite([])).toBeNull();
  });
});

// ── SVG path geometry ──────────────────────────────────────────────────────

describe('linePath', () => {
  it('spans the full width and inverts the y axis (max at top)', () => {
    // two points: min then max ⇒ x 0→100, y 100(bottom)→0(top)
    expect(linePath([0, 100], 0, 100)).toBe('M0.00 100.00 L100.00 0.00');
  });

  it('breaks the line at a gap instead of drawing across it', () => {
    const d = linePath([100, null, 0], 0, 100);
    // one subpath before the gap, a fresh M after it (two move commands)
    expect(d.match(/M/g)?.length).toBe(2);
    expect(d).toContain('M0.00 0.00');
    expect(d).toContain('M100.00 100.00');
  });

  it('clamps out-of-range values into the plot box', () => {
    expect(linePath([150], 0, 100)).toBe('M0.00 0.00'); // clamped to max → top
  });
});

describe('areaPath', () => {
  it('closes the fill down to the chart floor', () => {
    const d = areaPath([100, 100], 0, 100);
    expect(d.startsWith('M0.00 100.00')).toBe(true); // start on the floor
    expect(d.trim().endsWith('Z')).toBe(true); // closed
  });

  it('omits a lone point (no area to fill)', () => {
    expect(areaPath([50], 0, 100)).toBe('');
  });
});

// ── readSample (store → sample) ────────────────────────────────────────────

describe('readSample', () => {
  it('captures the fleet battery mean and per-drone strengths', () => {
    const drones = {
      DRONE_1: makeDronePacket({ drone_id: 'DRONE_1', battery: 100, signal: 'STRONG' }),
      DRONE_2: makeDronePacket({ drone_id: 'DRONE_2', battery: 50, signal: 'LOST' }),
    };
    const s = readSample(drones);
    expect(s.battery).toBe(75);
    expect(s.signals.DRONE_1).toBe(100);
    expect(s.signals.DRONE_2).toBe(0);
    expect(s.signals.DRONE_3).toBeNull(); // not reporting
  });
});

// ── Pure chart component ───────────────────────────────────────────────────

describe('TrendChart', () => {
  it('renders one <path> line per series plus gridlines and axis ticks', () => {
    const { container } = render(
      <TrendChart
        ariaLabel="test chart"
        min={0}
        max={100}
        gridlines={[0, 50, 100]}
        axisLabels={[{ value: 100, text: 'FULL' }]}
        series={[
          { key: 'a', color: '#fff', values: [0, 100] },
          { key: 'b', color: '#f00', values: [100, 0] },
        ]}
      />,
    );
    expect(container.querySelectorAll('path.trend-line')).toHaveLength(2);
    expect(container.querySelector('[data-series="a"]')).toBeInTheDocument();
    expect(container.querySelectorAll('line.trend-grid')).toHaveLength(3);
    expect(screen.getByLabelText('test chart')).toBeInTheDocument();
    expect(screen.getByText('FULL')).toBeInTheDocument();
  });

  it('draws an area path only for a fill series', () => {
    const { container } = render(
      <TrendChart
        ariaLabel="battery"
        min={0}
        max={100}
        series={[{ key: 'avg', color: '#0f0', values: [80, 70], fill: true }]}
      />,
    );
    expect(container.querySelector('path.trend-area')).toBeInTheDocument();
  });
});

// ── Store-connected sampler ────────────────────────────────────────────────

describe('TelemetryTrends (connected)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows a dash for battery before any telemetry arrives', () => {
    const { container } = render(<TelemetryTrends />);
    // scope to the battery readout — the empty legend states also render '—'
    expect(container.querySelector('.trend-current')).toHaveTextContent('—');
  });

  it('samples the store on the interval and renders the live avg battery', () => {
    pushPacket({ drone_id: 'DRONE_1', battery: 100, signal: 'STRONG' });
    pushPacket({ drone_id: 'DRONE_2', battery: 60, signal: 'WEAK' });
    render(<TelemetryTrends />);

    // advance one sample tick so the poller reads the seeded store
    act(() => {
      vi.advanceTimersByTime(SAMPLE_MS);
    });
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('reflects each drone current link state in the legend', () => {
    pushPacket({ drone_id: 'DRONE_1', signal: 'STRONG' });
    pushPacket({ drone_id: 'DRONE_3', signal: 'LOST' });
    render(<TelemetryTrends />);
    act(() => {
      vi.advanceTimersByTime(SAMPLE_MS);
    });

    const trends = screen.getByTestId('telemetry-trends');
    const items = within(trends).getAllByRole('listitem');
    expect(items).toHaveLength(6);
    // D1 STRONG, D3 LOST, non-reporting drones show a dash
    expect(items[0]).toHaveTextContent('D1');
    expect(items[0]).toHaveTextContent('STRONG');
    expect(items[2]).toHaveTextContent('LOST');
    expect(items[1]).toHaveTextContent('—');
  });

  it('caps the rolling buffer so memory stays bounded', () => {
    pushPacket({ drone_id: 'DRONE_1', battery: 50, signal: 'STRONG' });
    render(<TelemetryTrends />);
    act(() => {
      // far more ticks than the buffer holds
      vi.advanceTimersByTime(SAMPLE_MS * (MAX_SAMPLES + 40));
    });
    // The single battery line's path has at most MAX_SAMPLES vertices
    // (one M + the rest L commands).
    const path = document.querySelector('path.trend-line[data-series="avg"]');
    const verts = path?.getAttribute('d')?.match(/[ML]/g)?.length ?? 0;
    expect(verts).toBeGreaterThan(0);
    expect(verts).toBeLessThanOrEqual(MAX_SAMPLES);
  });
});
