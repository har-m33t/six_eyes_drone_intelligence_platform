/**
 * Canonical drone roster (mirrors `src/config.py` — `DRONE_IDS` + `ZONES`).
 * ------------------------------------------------------------------------
 * The legacy dashboard builds its six feeds/health rows from these exact
 * constants. They are reproduced here (not imported from Python) so the React
 * modules render the full, ordered 6-drone grid even before any telemetry has
 * arrived — matching the vanilla dashboard's "scaffold all six up front" behaviour.
 *
 * Keep in lock-step with `src/config.py`: drone IDs are `DRONE_1`…`DRONE_6` and
 * zones map 1:1 ALPHA…FOXTROT.
 */

import type { DroneId, Zone } from '../types/telemetry';

/** Ordered, fixed roster of the six drones (render order for the video grid). */
export const DRONE_IDS = [
  'DRONE_1',
  'DRONE_2',
  'DRONE_3',
  'DRONE_4',
  'DRONE_5',
  'DRONE_6',
] as const satisfies readonly DroneId[];

/** Union of the six concrete drone ids (narrower than the open `DroneId` type). */
export type CanonicalDroneId = (typeof DRONE_IDS)[number];

/** 1:1 drone → search-zone map (callsigns), identical to `config.ZONES`. */
export const ZONES: Record<CanonicalDroneId, Zone> = {
  DRONE_1: 'ALPHA',
  DRONE_2: 'BRAVO',
  DRONE_3: 'CHARLIE',
  DRONE_4: 'DELTA',
  DRONE_5: 'ECHO',
  DRONE_6: 'FOXTROT',
};

/** Short display label used on the feed/health tiles, e.g. `DRONE_3` → `D3`. */
export function shortDroneLabel(id: DroneId): string {
  return id.replace('DRONE_', 'D');
}
