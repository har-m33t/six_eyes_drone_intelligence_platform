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

/** A drone's pre-recorded feed clip, played directly in the browser as the video
 *  tile's base layer (live WebSocket frames override it when the backend is up). */
export interface DroneVideoSource {
  /** URL served by Vite's footage middleware (see `vite.config.ts`). */
  src: string;
  /** Seconds to seek to on first play, so drones sharing a clip look independent
   *  (mirrors the backend's `START_OFFSETS`). Clamped to the clip length at runtime. */
  startOffsetS: number;
}

/**
 * Drone → footage-clip map, mirroring `src/config.py` `VIDEO_PATHS` (three clips
 * reused across six drones) and `START_OFFSETS` (per-drone desync). Paths resolve
 * against the repo-root `footage/` dir via the dev/preview server middleware.
 */
export const DRONE_VIDEO_SOURCES: Record<CanonicalDroneId, DroneVideoSource> = {
  DRONE_1: { src: '/footage/drone_1.mp4', startOffsetS: 0 },
  DRONE_2: { src: '/footage/drone_2.mp4', startOffsetS: 2 },
  DRONE_3: { src: '/footage/drone_1.mp4', startOffsetS: 8 }, // reuse, desynced from D1
  DRONE_4: { src: '/footage/drone_2.mp4', startOffsetS: 4 }, // reuse, desynced from D2/D6
  DRONE_5: { src: '/footage/drone_3.mp4', startOffsetS: 9 },
  DRONE_6: { src: '/footage/drone_2.mp4', startOffsetS: 7 }, // reuse, desynced from D2/D4
};
