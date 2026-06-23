/**
 * Tests for Task C3 — the store-connected ConnectedIntelPanel (Module-A seam).
 *
 * Drives the real Zustand store and asserts: priority ladder
 * (lost > detection > battery > nominal), de-dup of identical situations,
 * the global %-searched wiring, and a documented `it.fails` for the
 * confidence-churn log-spam bug.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { ConnectedIntelPanel } from './IntelPanel';
import { useSwarmStore } from '../store/useSwarmStore';
import { makeDronePacket, makeDetection, makeNavTelemetry } from '../test/factories';

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

function logLines(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.intel-stream .intel-line'));
}

beforeEach(resetStore);

describe('ConnectedIntelPanel priority ladder', () => {
  it('idle copy before any telemetry', () => {
    render(<ConnectedIntelPanel />);
    expect(screen.getByText(/Standing by for telemetry/)).toBeInTheDocument();
  });

  it('nominal copy when all drones are healthy', () => {
    pushPacket({ drone_id: 'DRONE_1', status: 'ONLINE' });
    render(<ConnectedIntelPanel />);
    expect(screen.getByText(/All systems nominal\. 1\/6 drones online/)).toBeInTheDocument();
  });

  it('battery-critical outranks nominal', () => {
    pushPacket({ drone_id: 'DRONE_2', status: 'CRITICAL', battery: 7, zone: 'BRAVO' });
    render(<ConnectedIntelPanel />);
    expect(screen.getByText(/DRONE_2 battery critical/)).toBeInTheDocument();
    expect(screen.getByText(/at 7%/)).toBeInTheDocument();
  });

  it('detection outranks battery-critical', () => {
    pushPacket({ drone_id: 'DRONE_2', status: 'CRITICAL', battery: 5 });
    pushPacket({ drone_id: 'DRONE_3', detections: [makeDetection({ confidence: 0.88 })], zone: 'CHARLIE' });
    render(<ConnectedIntelPanel />);
    const active = logLines(document.body as HTMLElement).slice(-1)[0];
    expect(active.textContent).toMatch(/Person detected.*DRONE_3.*Zone CHARLIE.*88%/);
  });

  it('lost-signal outranks everything', () => {
    pushPacket({ drone_id: 'DRONE_3', detections: [makeDetection()] });
    pushPacket({ drone_id: 'DRONE_4', signal: 'LOST', status: 'CRITICAL', zone: 'DELTA' });
    render(<ConnectedIntelPanel />);
    const active = logLines(document.body as HTMLElement).slice(-1)[0];
    expect(active.textContent).toMatch(/DRONE_4 has lost signal.*Zone DELTA/);
    expect(active.classList.contains('critical')).toBe(true);
  });
});

describe('ConnectedIntelPanel de-dup', () => {
  it('does NOT add a new log line when an identical situation repeats', () => {
    pushPacket({ drone_id: 'DRONE_1', status: 'ONLINE', battery: 80 });
    const { container } = render(<ConnectedIntelPanel />);
    const before = logLines(container).length;

    // same drone, same status/zone/online-count — only battery (not in the
    // nominal descriptor) wiggles, so the situation is unchanged.
    pushPacket({ drone_id: 'DRONE_1', status: 'ONLINE', battery: 79 });
    pushPacket({ drone_id: 'DRONE_1', status: 'ONLINE', battery: 78 });

    expect(logLines(container).length).toBe(before);
  });

  it('adds exactly one new line when the situation transitions', () => {
    pushPacket({ drone_id: 'DRONE_1', status: 'ONLINE' });
    const { container } = render(<ConnectedIntelPanel />);
    const before = logLines(container).length;

    pushPacket({ drone_id: 'DRONE_1', signal: 'LOST', status: 'CRITICAL' });
    expect(logLines(container).length).toBe(before + 1);
  });
});

describe('ConnectedIntelPanel % searched wiring', () => {
  it('reflects waypoint-weighted global coverage from nav telemetry', () => {
    act(() => {
      // 3 of 10 waypoints flown ⇒ 30%
      useSwarmStore.getState().applyNavTelemetry(
        makeNavTelemetry({ drone_id: 'DRONE_1', current_waypoint_idx: 3, waypoints_remaining: 7 }),
      );
    });
    render(<ConnectedIntelPanel />);
    expect(screen.getByText('30%')).toBeInTheDocument();
  });
});

// ── Documented bug: detection confidence churn spams the log ───────────────
describe('ConnectedIntelPanel detection churn (BUG: confidence in descriptor)', () => {
  // The component's docstring claims "exactly one entry per distinct intel
  // event, never one per frame." FIXED: de-dup now keys on the stable
  // `IntelKey` (severity/kind/droneId/zone) and excludes the volatile rounded
  // confidence, so a sustained detection whose confidence wiggles 1% per frame
  // keeps a single log line; the displayed value is read fresh at append time.
  it('keeps a single line while one drone stays detected (confidence wiggles)', () => {
    pushPacket({ drone_id: 'DRONE_3', detections: [makeDetection({ confidence: 0.8 })] });
    const { container } = render(<ConnectedIntelPanel />);
    const before = logLines(container).length;

    // same detection, confidence drifts 80→81→80→82 over four 20Hz frames
    for (const c of [0.81, 0.8, 0.82]) {
      pushPacket({ drone_id: 'DRONE_3', detections: [makeDetection({ confidence: c })] });
    }
    expect(logLines(container).length).toBe(before); // expect no spam
  });
});
