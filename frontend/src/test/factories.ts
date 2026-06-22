/**
 * Test factories — build valid wire packets quickly, override only what a test
 * cares about. Shapes mirror `src/types/telemetry.ts` (and the Python wire
 * format in `src/packet.py`).
 */
import type {
  Detection,
  DroneId,
  DronePacket,
  NavTelemetry,
  SignalState,
  DroneStatus,
  Zone,
} from '../types/telemetry';

let frameSeq = 0;

export function makeDetection(over: Partial<Detection> = {}): Detection {
  return {
    class: 'person',
    confidence: 0.9,
    bbox: [10, 20, 110, 220],
    ...over,
  };
}

interface PacketOverrides {
  drone_id?: DroneId;
  zone?: Zone;
  status?: DroneStatus;
  signal?: SignalState;
  battery?: number;
  detections?: Detection[];
  lng?: number;
  lat?: number;
  coverage_active?: boolean;
  frame_b64?: string | null;
}

export function makeDronePacket(over: PacketOverrides = {}): DronePacket {
  const {
    drone_id = 'DRONE_1',
    zone = 'ALPHA',
    status = 'ONLINE',
    signal = 'STRONG',
    battery = 88,
    detections = [],
    lng = -117.82,
    lat = 33.68,
    coverage_active,
    frame_b64,
  } = over;

  return {
    drone_id,
    timestamp: 1_700_000_000 + frameSeq,
    frame_idx: frameSeq++,
    detections,
    gps: { lat, lng, lon: lng, alt: 100, coverage_active },
    health: { battery, signal, status, speed_ms: 5, temp_c: 30 },
    mission: { zone, coverage_pct: 0, elapsed_s: 1 },
    frame_b64,
  };
}

export function makeNavTelemetry(over: Partial<NavTelemetry> = {}): NavTelemetry {
  return {
    drone_id: 'DRONE_1',
    timestamp: 1_700_000_000,
    x: 0,
    y: 0,
    current_waypoint_idx: 0,
    waypoints_remaining: 10,
    mission_complete: false,
    ...over,
  };
}

/** A 1×1 transparent JPEG is irrelevant here — any non-empty base64 string makes
 *  `hasFrame` true; tests that need real <img> dimensions stub naturalWidth. */
export const FAKE_FRAME_B64 = 'AAAA';
