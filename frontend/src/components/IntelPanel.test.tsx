/**
 * Tests for Task C3 — the PURE IntelPanel component.
 *
 * The pure panel takes everything via props (no store). Covers empty state,
 * severity-driven strip class, source badge, %-searched rounding, rich-text
 * highlight segments, and the severity-collapsed timeline.
 *
 * Includes a documented `it.fails` reproducing the autoscroll-after-cap bug.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IntelPanel, type IntelLogEntry } from './IntelPanel';

let key = 0;
function line(over: Partial<IntelLogEntry> = {}): IntelLogEntry {
  return {
    id: `e${key++}`,
    text: 'All systems nominal.',
    severity: 'normal',
    timestamp: 1_700_000_000_000,
    ...over,
  };
}

describe('IntelPanel (pure)', () => {
  it('shows the standing-by placeholder when there are no logs', () => {
    render(<IntelPanel logs={[]} coveragePct={0} />);
    expect(screen.getByText(/Standing by for telemetry/)).toBeInTheDocument();
    expect(screen.getByText('awaiting first report')).toBeInTheDocument();
  });

  it('reflects the newest line severity in the strip class', () => {
    const { container, rerender } = render(
      <IntelPanel logs={[line({ severity: 'normal' })]} coveragePct={0} />,
    );
    expect(container.querySelector('.intel-strip')!.className).not.toMatch(/critical|warning/);

    rerender(<IntelPanel logs={[line({ severity: 'normal' }), line({ severity: 'critical' })]} coveragePct={0} />);
    expect(container.querySelector('.intel-strip')!.classList.contains('critical')).toBe(true);
  });

  it('renders the source badge (LOCAL SIM vs AIP LIVE)', () => {
    const { rerender } = render(<IntelPanel logs={[]} coveragePct={0} />);
    expect(screen.getByText('LOCAL SIM')).toBeInTheDocument();
    rerender(<IntelPanel logs={[]} coveragePct={0} sourceLive />);
    expect(screen.getByText('AIP LIVE')).toBeInTheDocument();
  });

  it('rounds the % searched and clamps non-finite to 0', () => {
    const { rerender } = render(<IntelPanel logs={[]} coveragePct={37.6} />);
    expect(screen.getByText('38%')).toBeInTheDocument();
    rerender(<IntelPanel logs={[]} coveragePct={Number.NaN} />);
    expect(screen.getByText('0%')).toBeInTheDocument();
    rerender(<IntelPanel logs={[]} coveragePct={Number.POSITIVE_INFINITY} />);
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('renders rich-text emphasis segments as real spans (no innerHTML)', () => {
    const entry = line({
      severity: 'critical',
      text: 'DRONE_3 has lost signal in Zone CHARLIE.',
      segments: [
        { text: 'DRONE_3 has lost signal', emphasis: 'crit-hl' },
        { text: ' in Zone CHARLIE.' },
      ],
    });
    const { container } = render(<IntelPanel logs={[entry]} coveragePct={0} />);
    const hl = container.querySelector('span.crit-hl');
    expect(hl).toBeInTheDocument();
    expect(hl!.textContent).toBe('DRONE_3 has lost signal');
  });

  it('collapses the timeline to one bar per severity transition (capped at 12)', () => {
    // normal,normal,warning,warning,critical,normal → 4 transitions
    const seq: IntelLogEntry['severity'][] = [
      'normal', 'normal', 'warning', 'warning', 'critical', 'normal',
    ];
    const { container } = render(
      <IntelPanel logs={seq.map((severity) => line({ severity }))} coveragePct={0} />,
    );
    const bars = container.querySelectorAll('.intel-timeline-bar');
    expect(bars).toHaveLength(4);

    // build a long alternating run → timeline is capped at 12 bars
    const long: IntelLogEntry[] = [];
    for (let i = 0; i < 40; i++) long.push(line({ severity: i % 2 ? 'warning' : 'normal' }));
    const { container: c2 } = render(<IntelPanel logs={long} coveragePct={0} />);
    expect(c2.querySelectorAll('.intel-timeline-bar')).toHaveLength(12);
  });

  it('prefers the lastUpdatedMs override for the timestamp when provided', () => {
    const ts = Date.UTC(2026, 0, 1, 12, 0, 0);
    render(<IntelPanel logs={[line()]} coveragePct={0} lastUpdatedMs={ts} />);
    // the formatted clock string for `ts` must appear in the meta row
    expect(screen.getByText(new Date(ts).toLocaleTimeString())).toBeInTheDocument();
  });
});

// ── Documented bug: autoscroll stops once the log length plateaus ──────────
describe('IntelPanel autoscroll (BUG: keyed on logs.length)', () => {
  const sets: number[] = [];
  let descTop: PropertyDescriptor | undefined;
  let descHeight: PropertyDescriptor | undefined;

  beforeEach(() => {
    sets.length = 0;
    descTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
    descHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 9999;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get() {
        return 0;
      },
      set(v: number) {
        sets.push(v);
      },
    });
  });

  afterEach(() => {
    if (descTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', descTop);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTop;
    if (descHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', descHeight);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  });

  // Positive control: when the COUNT changes, autoscroll fires. This proves the
  // scrollTop spy + effect work, so the `it.fails` below can only fail for the
  // real reason (the length-keyed dependency), not a broken harness.
  it('autoscrolls when the log count grows (control)', () => {
    const { rerender } = render(<IntelPanel logs={[line()]} coveragePct={0} />);
    const afterMount = sets.length;
    expect(afterMount).toBeGreaterThan(0);
    rerender(<IntelPanel logs={[line(), line()]} coveragePct={0} />);
    expect(sets.length).toBeGreaterThan(afterMount);
  });

  // EXPECTED behaviour: a new line should always scroll the newest into view.
  // FIXED: the effect now keys on `[logs, active?.id]` instead of `logs.length`,
  // so new content re-triggers the scroll even after the stream caps at
  // MAX_LOG_LINES and the length plateaus.
  it('autoscrolls when the newest line changes but the count stays constant', () => {
    const fifty = Array.from({ length: 50 }, () => line());
    const { rerender } = render(<IntelPanel logs={fifty} coveragePct={0} />);
    const afterMount = sets.length; // mount effect ran once

    // simulate the capped stream: drop oldest, append newest — length stays 50
    const rolled = [...fifty.slice(1), line({ severity: 'critical', text: 'NEW EVENT' })];
    rerender(<IntelPanel logs={rolled} coveragePct={0} />);

    expect(sets.length).toBeGreaterThan(afterMount);
  });
});
