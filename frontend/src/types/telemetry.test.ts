/**
 * Module A · Task A1 — type-guard / discriminator tests.
 *
 * The types themselves are erased at runtime; the only executable surface in
 * `telemetry.ts` is the `isNavTelemetry` / `isDronePacket` discriminators, which
 * A3 (`ingest` routing) and the legacy dashboard both rely on. These tests pin
 * the routing contract and probe the documented "mirrors the legacy exactly"
 * claim.
 */
import { describe, it, expect } from 'vitest';
import {
  isNavTelemetry,
  isDronePacket,
  type DronePacket,
  type NavTelemetry,
  type InboundPacket,
} from './telemetry';

function navPacket(over: Partial<NavTelemetry> = {}): NavTelemetry {
  return {
    drone_id: 'DRONE_1',
    timestamp: 1,
    x: -117.8,
    y: 33.6,
    current_waypoint_idx: 2,
    waypoints_remaining: 3,
    mission_complete: false,
    ...over,
  };
}

function dronePacket(over: Partial<DronePacket> = {}): DronePacket {
  return {
    drone_id: 'DRONE_1',
    timestamp: 1,
    frame_idx: 0,
    detections: [],
    gps: { lat: 33.6, lng: -117.8, lon: -117.8, alt: 100 },
    health: { battery: 90, signal: 'STRONG', status: 'ONLINE', speed_ms: 5, temp_c: 30 },
    mission: { zone: 'ALPHA', coverage_pct: 0, elapsed_s: 0 },
    ...over,
  };
}

describe('isNavTelemetry / isDronePacket', () => {
  it('routes a real nav packet to NavTelemetry', () => {
    const p = navPacket();
    expect(isNavTelemetry(p)).toBe(true);
    expect(isDronePacket(p)).toBe(false);
  });

  it('routes a real drone packet to DronePacket', () => {
    const p = dronePacket();
    expect(isNavTelemetry(p)).toBe(false);
    expect(isDronePacket(p)).toBe(true);
  });

  it('treats current_waypoint_idx:0 as a nav packet (in-operator, not truthiness)', () => {
    expect(isNavTelemetry(navPacket({ current_waypoint_idx: 0 }))).toBe(true);
  });

  it('falls back to bare x/y (no gps) for a nav packet missing current_waypoint_idx', () => {
    const bare = { drone_id: 'DRONE_2', timestamp: 1, x: 1, y: 2 } as unknown as InboundPacket;
    expect(isNavTelemetry(bare)).toBe(true);
  });

  it('a drone packet with gps but no nav keys is NOT nav', () => {
    expect(isNavTelemetry(dronePacket())).toBe(false);
  });

  // ── Adversarial: divergence from the legacy `!pkt.gps` truthiness check ──
  // Legacy JS used `!pkt.gps`, so a packet carrying x/y AND `gps: null` (a
  // malformed/explicit null) was still classified as nav. The TS guard uses
  // `p.gps === undefined`, so `gps: null` is NOT undefined and the same packet
  // is classified as a DRONE packet instead. Documented as a faithfulness nit
  // (real nav packets always carry current_waypoint_idx, so this never fires in
  // practice) — this test PINS the actual TS behaviour so the divergence is
  // visible if anyone re-reads the "mirrors the legacy exactly" claim.
  it('DIVERGENCE: x/y packet with gps:null is classified DRONE (legacy classified nav)', () => {
    const weird = { drone_id: 'DRONE_3', x: 1, y: 2, gps: null } as unknown as InboundPacket;
    // TS guard result:
    expect(isNavTelemetry(weird)).toBe(false);
    // Legacy `!pkt.gps` would have been true (null is falsy):
    const legacy = 'current_waypoint_idx' in weird ||
      (typeof (weird as any).x === 'number' && typeof (weird as any).y === 'number' && !(weird as any).gps);
    expect(legacy).toBe(true);
    expect(isNavTelemetry(weird)).not.toBe(legacy);
  });
});
