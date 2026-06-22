/**
 * SIX-EYES telemetry type schema (Module A · Task A1)
 * ----------------------------------------------------
 * Explicit, exact TypeScript shapes for every JSON packet that crosses the
 * WebSocket boundary, reverse-engineered from the legacy vanilla dashboard
 * (`six_eyes_dashboard.html`) and the authoritative Python wire format
 * (`src/packet.py`, `src/simulators.py`, `src/inference.py`).
 *
 * Two distinct INBOUND wire formats are multiplexed on the same socket:
 *   1. `DronePacket`  — full per-frame drone state (gps / health / detections).
 *   2. `NavTelemetry` — lightweight route-progress packet emitted while a drone
 *                       flies a Deploy-Swarm route. No gps / health / detections.
 * The legacy `isNavTelemetry()` discriminator keys on `current_waypoint_idx`
 * (or raw `x`/`y` without `gps`); `isNavTelemetry()` below mirrors that exactly.
 *
 * OUTBOUND commands match the legacy `{ command, ... }` envelope sent over the
 * same socket (e.g. START_MISSION; KILL_DRONE per Task D2).
 *
 * These are pure type contracts — no runtime cost — so Modules B/C/D can be
 * built concurrently against a stable interface.
 */

// ──────────────────────────────────────────────────────────────────────────
// Shared primitives & enumerations
// ──────────────────────────────────────────────────────────────────────────

/** Canonical drone identifier, `DRONE_1` … `DRONE_6`. */
export type DroneId = `DRONE_${number}`;

/**
 * Health rollup status produced by `simulate_health()`.
 * Legacy values are ONLINE | WARNING | CRITICAL. (Task C2 refers to an OFFLINE
 * terminal state; the dashboard derives that from `signal === 'LOST'` rather
 * than a distinct status string — see `SignalState`.)
 */
export type DroneStatus = 'ONLINE' | 'WARNING' | 'CRITICAL';

/** Radio link quality. `LOST` drives the SIGNAL-LOST overlay (Task C2). */
export type SignalState = 'STRONG' | 'WEAK' | 'LOST';

/** Operational search zone, mapped 1:1 to drones in `src/config.py`. */
export type Zone = 'ALPHA' | 'BRAVO' | 'CHARLIE' | 'DELTA' | 'ECHO' | 'FOXTROT';

/** A geographic coordinate pair in `[lng, lat]` order (GeoJSON convention). */
export type LngLat = [number, number];

// ──────────────────────────────────────────────────────────────────────────
// Nested packet members
// ──────────────────────────────────────────────────────────────────────────

/**
 * A single YOLO person detection (`src/inference.py`). Only COCO class 0
 * ("person") is ever emitted, so `class` is the string literal `'person'`.
 */
export interface Detection {
  /** Always `'person'` — the producer keeps only `box.cls === 0`. */
  class: 'person';
  /** Confidence in `[0, 1]`, rounded to 3 dp. */
  confidence: number;
  /** Pixel bounding box `[x1, y1, x2, y2]`. */
  bbox: [number, number, number, number];
}

/**
 * Simulated GPS fix (`simulate_gps`). `lng` is the canonical field; `lon` is a
 * backwards-compatible alias kept for older dashboards/tests — consumers should
 * read `gps.lng ?? gps.lon`.
 */
export interface GpsFix {
  lat: number;
  lng: number;
  /** Compatibility alias for `lng`. */
  lon: number;
  alt: number;
  /**
   * False while a drone is transiting to its search start; the dashboard does
   * NOT paint a coverage footprint for such packets. Absent ⇒ treated as true.
   */
  coverage_active?: boolean;
}

/** Simulated health/telemetry block (`simulate_health`). */
export interface HealthState {
  /** Battery percentage `[0, 100]`. */
  battery: number;
  signal: SignalState;
  status: DroneStatus;
  speed_ms: number;
  temp_c: number;
}

/** Mission metadata block (`build_packet`). */
export interface MissionState {
  zone: Zone;
  /** Time-derived coverage estimate `[0, 100]`. */
  coverage_pct: number;
  /** Seconds since the shared `MISSION_START`. */
  elapsed_s: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Inbound wire formats
// ──────────────────────────────────────────────────────────────────────────

/**
 * Full per-frame drone packet (`DronePacket` dataclass, `dataclasses.asdict()`
 * → JSON). Broadcast every frame to every dashboard client.
 */
export interface DronePacket {
  drone_id: DroneId;
  /** Unix timestamp (seconds, float). */
  timestamp: number;
  /** Frame number since mission start (video sync). */
  frame_idx: number;
  detections: Detection[];
  gps: GpsFix;
  health: HealthState;
  mission: MissionState;
  /**
   * Base64 JPEG of the frame for the dashboard video grid. WebSocket-only
   * (never persisted to Foundry); may be absent/`null`.
   */
  frame_b64?: string | null;
}

/**
 * Lightweight navigation-telemetry packet (`NavTelemetry` dataclass), broadcast
 * once a drone is flying its Deploy-Swarm route. Carries route-local sweep
 * coordinates + waypoint progress and NONE of the gps/health/detections
 * structure. For Mapbox-drawn missions, `x`/`y` are `lng`/`lat`.
 */
export interface NavTelemetry {
  drone_id: DroneId;
  timestamp: number;
  /** Route x; `lng` for Mapbox-drawn missions. */
  x: number;
  /** Route y; `lat` for Mapbox-drawn missions. */
  y: number;
  /** Waypoints reached so far. */
  current_waypoint_idx: number;
  /** Waypoints still ahead on this route. */
  waypoints_remaining: number;
  /** Whole assigned route flown. */
  mission_complete: boolean;
  /** False while transiting to the search start. Absent ⇒ treated as true. */
  coverage_active?: boolean;
}

/** Discriminated union of everything the socket may deliver. */
export type InboundPacket = DronePacket | NavTelemetry;

/**
 * Runtime discriminator mirroring the legacy `isNavTelemetry()`: a nav packet
 * exposes `current_waypoint_idx`, or raw `x`/`y` numbers without a `gps` block.
 * Narrows an `InboundPacket` to `NavTelemetry`.
 */
export function isNavTelemetry(pkt: InboundPacket): pkt is NavTelemetry {
  const p = pkt as Partial<NavTelemetry> & Partial<DronePacket>;
  return (
    'current_waypoint_idx' in pkt ||
    (typeof p.x === 'number' && typeof p.y === 'number' && p.gps === undefined)
  );
}

/** Narrows an `InboundPacket` to a full `DronePacket`. */
export function isDronePacket(pkt: InboundPacket): pkt is DronePacket {
  return !isNavTelemetry(pkt);
}

// ──────────────────────────────────────────────────────────────────────────
// Outbound commands (`{ command, ... }` envelope)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Deploy-Swarm command: a drawn search polygon as `[[lng, lat], ...]`
 * (≥ 3 vertices). Handled by `websocket_server._handle_start_mission`.
 */
export interface StartMissionCommand {
  command: 'START_MISSION';
  polygon: LngLat[];
}

/**
 * Presentation kill switch (Task D2): force a drone OFFLINE. Targets a specific
 * drone (the demo binds `K` → `DRONE_3`).
 *
 * NOTE: not yet handled server-side — the legacy server only recognises
 * START_MISSION. Defined here so Module D can compile against the contract.
 */
export interface KillDroneCommand {
  command: 'KILL_DRONE';
  drone_id: DroneId;
}

/** Discriminated union of every outbound command. */
export type OutboundCommand = StartMissionCommand | KillDroneCommand;

/** Command name literals. */
export type CommandType = OutboundCommand['command'];

/**
 * Helper that maps a command name to the payload it carries (everything in the
 * command envelope except the `command` discriminator). Backs the
 * `webSocketService.sendCommand(cmd, payload)` interface contract (§19).
 */
export type CommandPayload<C extends CommandType> = Omit<
  Extract<OutboundCommand, { command: C }>,
  'command'
>;
