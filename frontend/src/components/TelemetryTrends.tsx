/**
 * TelemetryTrends — live mission-trend charts for the fleet-status sidebar.
 * -----------------------------------------------------------------------
 * Fills the empty vertical space under the six fleet rows with two compact,
 * self-updating time-series charts:
 *
 *   • AVG BATTERY         — the fleet-mean battery %, sampled over time. The
 *                           producer drains battery ~5%/min (see
 *                           `src/simulators.py::simulate_health`), so this reads
 *                           as a genuine downward slope, not a decorative wiggle.
 *   • CONNECTION STRENGTH — one line per drone, mapping the real radio-link
 *                           state to a strength scale (STRONG=100 / WEAK=55 /
 *                           LOST=0). Lines sit stacked at the top while the swarm
 *                           is healthy and peel downward as links degrade.
 *
 * DATA PATH (deliberately NOT a store subscription). Telemetry ticks at ~20 Hz;
 * subscribing here would re-render the charts 20×/sec for no visual gain. Instead
 * this component POLLS `useSwarmStore.getState()` on a fixed `SAMPLE_MS` cadence
 * (the same pattern the `MissionClock` uses) and keeps a rolling buffer of the
 * last `MAX_SAMPLES` samples in local state — so it re-renders at most once every
 * couple of seconds and the store contract (latest-state-only) is untouched.
 *
 * ACCURACY. `avgBattery` reuses the fleet summary's finite-only averaging rule
 * (a drone with an absent battery must not poison the mean, and an empty fleet
 * yields `null` → a gap, never a misleading 0%). `signalStrength` maps ONLY the
 * three real `SignalState` values; anything else is a gap. The charts therefore
 * plot exactly what the wire carried, with no interpolation or smoothing.
 *
 * The pure `TrendChart` (SVG only, no store/network imports) is exported so it
 * can be reviewed and snapshot-tested in isolation, matching the Module-C split
 * used by `IntelPanel` / `VideoFeed`.
 */

import { useEffect, useMemo, useState } from 'react';
import type { DroneId, DronePacket, SignalState } from '../types/telemetry';
import { DRONE_IDS, shortDroneLabel, type CanonicalDroneId } from '../constants/drones';
import { useSwarmStore } from '../store/useSwarmStore';
import { batteryColor } from './VideoFeed';
import './TelemetryTrends.css';

// ──────────────────────────────────────────────────────────────────────────
// Sampling configuration
// ──────────────────────────────────────────────────────────────────────────

/** How often the store is polled for a fresh trend sample. */
export const SAMPLE_MS = 2000;
/** Rolling-buffer capacity (90 × 2s = a 3-minute scrolling window). */
export const MAX_SAMPLES = 90;

// ──────────────────────────────────────────────────────────────────────────
// Per-drone line colours (distinct on the dark panel, harmonised with --accent)
// ──────────────────────────────────────────────────────────────────────────

/** Stable colour per drone for the connection-strength lines + legend. */
export const DRONE_LINE_COLORS: Record<CanonicalDroneId, string> = {
  DRONE_1: '#a78bfa', // accent purple
  DRONE_2: '#4dd2ff', // cyan
  DRONE_3: '#7cf7a0', // green
  DRONE_4: '#ffb84d', // amber
  DRONE_5: '#ff6fd8', // pink
  DRONE_6: '#6ea8ff', // blue
};

// ──────────────────────────────────────────────────────────────────────────
// Data mapping (pure, exported for unit tests)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Radio-link state → a 0–100 strength value. This is the ONLY signal quality the
 * wire carries (a three-level enum, see `simulate_health`), so the chart maps the
 * real states rather than inventing a continuous dBm reading. `undefined` (drone
 * not reporting) → `null` so the line breaks instead of dropping to a false 0.
 */
export const SIGNAL_STRENGTH: Record<SignalState, number> = {
  STRONG: 100,
  WEAK: 55,
  LOST: 0,
};

export function signalStrength(signal: SignalState | undefined): number | null {
  if (signal === undefined) return null;
  return SIGNAL_STRENGTH[signal] ?? null;
}

/** Reverse of {@link SIGNAL_STRENGTH} for the legend's current-state readout. */
export function strengthLabel(v: number | null): string {
  if (v === SIGNAL_STRENGTH.STRONG) return 'STRONG';
  if (v === SIGNAL_STRENGTH.WEAK) return 'WEAK';
  if (v === SIGNAL_STRENGTH.LOST) return 'LOST';
  return '—';
}

/**
 * Fleet-mean battery over drones with a FINITE battery reading, or `null` when
 * none report. Mirrors `useFleetSummary`'s averaging rule (BUG A2-1b) so the
 * trend and the "AVG BATT" stat can never disagree — except this returns `null`
 * (a chart gap) instead of `0` when there is no data to average.
 */
export function avgBattery(drones: Partial<Record<DroneId, DronePacket>>): number | null {
  const batteries = Object.values(drones)
    .filter((d): d is DronePacket => Boolean(d))
    .map((d) => d.health?.battery)
    .filter((b): b is number => Number.isFinite(b));
  if (batteries.length === 0) return null;
  return batteries.reduce((sum, b) => sum + b, 0) / batteries.length;
}

/** Most recent finite value in a (possibly gappy) series, or null if all gaps. */
export function lastFinite(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// SVG path geometry (pure, exported for unit tests)
// ──────────────────────────────────────────────────────────────────────────

/** Data coordinate space: the chart draws into a square viewBox and scales to
 *  fit with `preserveAspectRatio="none"`, so strokes use `non-scaling-stroke`. */
const VIEW = 100;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Value → y coord (inverted: `max` at the top = 0, `min` at the bottom = VIEW). */
function yCoord(v: number, min: number, max: number): number {
  if (max <= min) return VIEW;
  return VIEW - ((clamp(v, min, max) - min) / (max - min)) * VIEW;
}

/** Sample index → x coord, spreading the whole series across the full width. */
function xCoord(i: number, n: number): number {
  return n <= 1 ? 0 : (i / (n - 1)) * VIEW;
}

/**
 * Split a value series into contiguous runs of finite points (carrying their
 * original index) so a `null`/non-finite gap BREAKS the line rather than drawing
 * a false segment across missing telemetry.
 */
function contiguousRuns(
  values: readonly (number | null)[],
): { i: number; v: number }[][] {
  const runs: { i: number; v: number }[][] = [];
  let run: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      if (run.length) {
        runs.push(run);
        run = [];
      }
    } else {
      run.push({ i, v });
    }
  });
  if (run.length) runs.push(run);
  return runs;
}

/** `d` for the connecting line — one `M…L…` subpath per contiguous run. */
export function linePath(
  values: readonly (number | null)[],
  min: number,
  max: number,
): string {
  const n = values.length;
  return contiguousRuns(values)
    .map((run) =>
      run
        .map(
          (p, k) =>
            `${k === 0 ? 'M' : 'L'}${xCoord(p.i, n).toFixed(2)} ${yCoord(p.v, min, max).toFixed(2)}`,
        )
        .join(' '),
    )
    .join(' ')
    .trim();
}

/** `d` for the filled area under the line (single-series charts only). */
export function areaPath(
  values: readonly (number | null)[],
  min: number,
  max: number,
): string {
  const n = values.length;
  const bottom = VIEW.toFixed(2);
  return contiguousRuns(values)
    .filter((run) => run.length > 1) // a lone point has no area
    .map((run) => {
      const first = run[0];
      const last = run[run.length - 1];
      const pts = run
        .map((p) => `L${xCoord(p.i, n).toFixed(2)} ${yCoord(p.v, min, max).toFixed(2)}`)
        .join(' ');
      return `M${xCoord(first.i, n).toFixed(2)} ${bottom} ${pts} L${xCoord(last.i, n).toFixed(2)} ${bottom} Z`;
    })
    .join(' ')
    .trim();
}

// ──────────────────────────────────────────────────────────────────────────
// Pure chart component (no store / network imports)
// ──────────────────────────────────────────────────────────────────────────

export interface ChartSeries {
  /** Stable React + test key (e.g. a drone id, or 'avg'). */
  key: string;
  color: string;
  values: readonly (number | null)[];
  /** Draw a faint filled area beneath the line (single-series charts). */
  fill?: boolean;
}

export interface AxisLabel {
  /** Data-space value the tick sits at. */
  value: number;
  text: string;
}

export interface TrendChartProps {
  series: readonly ChartSeries[];
  min: number;
  max: number;
  /** Data values to draw a faint horizontal gridline at. */
  gridlines?: readonly number[];
  /** Right-edge tick labels (rendered as HTML so they never scale/distort). */
  axisLabels?: readonly AxisLabel[];
  ariaLabel: string;
}

/**
 * A compact multi-series line chart. Draws into a square viewBox stretched to the
 * container with `preserveAspectRatio="none"`; every stroke is
 * `vector-effect="non-scaling-stroke"` so lines stay crisp and uniform at any
 * aspect ratio, and all text lives in an HTML overlay (never scaled SVG text).
 */
export function TrendChart({
  series,
  min,
  max,
  gridlines = [],
  axisLabels = [],
  ariaLabel,
}: TrendChartProps) {
  return (
    <div className="trend-chart">
      <svg
        className="trend-chart-svg"
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
      >
        {gridlines.map((g) => {
          const y = yCoord(g, min, max);
          return (
            <line
              key={`grid-${g}`}
              className="trend-grid"
              x1={0}
              x2={VIEW}
              y1={y}
              y2={y}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {series.map((s) =>
          s.fill ? (
            <path
              key={`${s.key}-area`}
              className="trend-area"
              d={areaPath(s.values, min, max)}
              fill={s.color}
            />
          ) : null,
        )}

        {series.map((s) => (
          <path
            key={s.key}
            className="trend-line"
            data-series={s.key}
            d={linePath(s.values, min, max)}
            stroke={s.color}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      {axisLabels.length > 0 && (
        <div className="trend-axis" aria-hidden="true">
          {axisLabels.map((l) => {
            const topPct = (1 - clamp((l.value - min) / (max - min || 1), 0, 1)) * 100;
            // Anchor proportionally to position (top label sits just below its
            // line, bottom label just above) so extreme ticks are never clipped
            // by the chart's `overflow: hidden`, while the middle stays centred.
            return (
              <span
                key={l.text}
                className="trend-axis-tick"
                style={{ top: `${topPct}%`, transform: `translateY(-${topPct}%)` }}
              >
                {l.text}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Sampling
// ──────────────────────────────────────────────────────────────────────────

interface Sample {
  battery: number | null;
  signals: Record<CanonicalDroneId, number | null>;
}

/** Take one trend sample straight off the current store state. */
export function readSample(
  drones: Partial<Record<DroneId, DronePacket>>,
): Sample {
  const signals = {} as Record<CanonicalDroneId, number | null>;
  for (const id of DRONE_IDS) {
    signals[id] = signalStrength(drones[id]?.health?.signal);
  }
  return { battery: avgBattery(drones), signals };
}

// ──────────────────────────────────────────────────────────────────────────
// Store-connected container
// ──────────────────────────────────────────────────────────────────────────

/**
 * Polls the swarm store on the `SAMPLE_MS` cadence, keeps a bounded rolling
 * buffer, and feeds the two `TrendChart`s. Not a store subscriber by design (see
 * the file header) — it reads via `getState()` on its own timer, so a 20 Hz
 * telemetry stream never re-renders it.
 */
export function TelemetryTrends() {
  const [samples, setSamples] = useState<Sample[]>(() => [
    readSample(useSwarmStore.getState().drones),
  ]);

  useEffect(() => {
    const t = setInterval(() => {
      setSamples((prev) => {
        const next = prev.concat(readSample(useSwarmStore.getState().drones));
        return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
      });
    }, SAMPLE_MS);
    return () => clearInterval(t);
  }, []);

  const batteryValues = useMemo(() => samples.map((s) => s.battery), [samples]);
  const currentBattery = lastFinite(batteryValues);

  const signalSeries = useMemo<ChartSeries[]>(
    () =>
      DRONE_IDS.map((id) => ({
        key: id,
        color: DRONE_LINE_COLORS[id],
        values: samples.map((s) => s.signals[id]),
      })),
    [samples],
  );

  const batterySeries: ChartSeries[] = useMemo(
    () => [
      {
        key: 'avg',
        color: currentBattery == null ? 'var(--accent)' : batteryColor(currentBattery),
        values: batteryValues,
        fill: true,
      },
    ],
    [batteryValues, currentBattery],
  );

  return (
    <div className="trends" data-testid="telemetry-trends">
      {/* ── Avg battery ── */}
      <section className="trend">
        <div className="trend-head">
          <span className="trend-title">Avg Battery</span>
          <span
            className="trend-current"
            style={{ color: currentBattery == null ? 'var(--text-dim)' : batteryColor(currentBattery) }}
          >
            {currentBattery == null ? '—' : `${Math.round(currentBattery)}%`}
          </span>
        </div>
        <TrendChart
          series={batterySeries}
          min={0}
          max={100}
          gridlines={[0, 50, 100]}
          axisLabels={[
            { value: 100, text: '100' },
            { value: 50, text: '50' },
            { value: 0, text: '0' },
          ]}
          ariaLabel="Fleet average battery percentage over time"
        />
      </section>

      {/* ── Connection strength ── */}
      <section className="trend">
        <div className="trend-head">
          <span className="trend-title">Connection Strength</span>
        </div>
        <TrendChart
          series={signalSeries}
          min={0}
          max={100}
          gridlines={[0, SIGNAL_STRENGTH.WEAK, 100]}
          axisLabels={[
            { value: SIGNAL_STRENGTH.STRONG, text: 'STRONG' },
            { value: SIGNAL_STRENGTH.WEAK, text: 'WEAK' },
            { value: SIGNAL_STRENGTH.LOST, text: 'LOST' },
          ]}
          ariaLabel="Per-drone connection strength over time"
        />
        <ul className="trend-legend">
          {DRONE_IDS.map((id) => {
            const current = lastFinite(samples.map((s) => s.signals[id]));
            return (
              <li className="trend-legend-item" key={id}>
                <span
                  className="trend-legend-swatch"
                  style={{ background: DRONE_LINE_COLORS[id] }}
                  aria-hidden="true"
                />
                <span className="trend-legend-id">{shortDroneLabel(id)}</span>
                <span className="trend-legend-state">{strengthLabel(current)}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

export default TelemetryTrends;
