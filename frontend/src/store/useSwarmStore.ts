/**
 * SIX-EYES swarm store (Module A · Task A2)
 * -----------------------------------------
 * The single source of truth for real-time mission state. Zustand is chosen for
 * its selector-based subscriptions: components subscribe to a NARROW slice and
 * re-render only when that slice's reference changes (Object.is), so 20 Hz
 * telemetry for one drone never re-renders panels bound to the other five.
 *
 * "Slice-based API without root re-renders" (the A2 brief) is achieved by:
 *   • keying drones by id in a flat record, and on update spreading a NEW record
 *     while PRESERVING the identity of every untouched drone's packet object.
 *     A consumer of `s => s.drones.DRONE_1` is unaffected when DRONE_3 ticks.
 *   • exposing fine-grained hooks (`useDrone`, `useConnection`, …) so callers
 *     never have to subscribe to the whole store. Multi-field reads use
 *     `useShallow` to avoid new-object churn.
 *
 * INTERFACE BOUNDARY
 *   • Inbound: Task A3 (`websocket.ts`) maps socket frames straight onto the
 *     mutation actions below — call `useSwarmStore.getState().ingest(msg)` for
 *     auto-routing, or the specific `applyDronePacket` / `applyNavTelemetry`.
 *   • Outbound: command sending lives on the `webSocketService` instance (A3),
 *     NOT here — this store is state only.
 *
 * Mirrors the legacy `six_eyes_dashboard.html` data handlers (`handlePacket`,
 * `handleNavTelemetry`, `updateCoverageStat`, `refreshSummary`) so the React UI
 * reproduces the vanilla dashboard's behavior exactly.
 */

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import {
  type DroneId,
  type DronePacket,
  type DroneStatus,
  type NavTelemetry,
  type InboundPacket,
  isNavTelemetry,
} from '../types/telemetry';

// ──────────────────────────────────────────────────────────────────────────
// Connection lifecycle (owned by the store; driven by the A3 service)
// ──────────────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

// ──────────────────────────────────────────────────────────────────────────
// Derived view-models (stable shapes consumed across Modules B/C)
// ──────────────────────────────────────────────────────────────────────────

/** A drone's live map position — the array Module B (TacticalMap) consumes. */
export interface DronePosition {
  id: DroneId;
  lng: number;
  lat: number;
  status: DroneStatus;
  hasDetection: boolean;
  /** false ⇒ transit-to-start; Module B must NOT paint coverage for it. */
  coverageActive: boolean;
}

/** Per-drone waypoint progress, the basis of the global "% SEARCHED" stat. */
export interface CoverageProgress {
  current: number;
  total: number;
}

/** Header summary stats (legacy `refreshSummary`). */
export interface FleetSummary {
  online: number;
  detections: number;
  avgBattery: number;
  alerts: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Store shape
// ──────────────────────────────────────────────────────────────────────────

export interface SwarmState {
  /** Latest full packet per drone. Untouched entries keep object identity. */
  drones: Partial<Record<DroneId, DronePacket>>;
  /** Waypoint progress per drone id (normalized upper-case key). */
  coverage: Record<string, CoverageProgress>;
  /** Waypoint-weighted global coverage, 0–100. */
  globalCoveragePct: number;
  /** Socket connection lifecycle. */
  connection: ConnectionStatus;
  /** Set on first packet / connect; backs the mission clock. */
  missionStartMs: number | null;
  /** Distinct (drone+status) alert keys already counted (legacy `seenAlerts`). */
  seenAlerts: string[];
  /** Running alert count (legacy `alertCount`). */
  alertCount: number;

  // ── Mutation actions (the A3-facing write surface) ──────────────────────
  /** Route any inbound frame to the correct handler (uses A1's guard). */
  ingest: (msg: InboundPacket) => void;
  /** Merge a full drone packet, replacing only that drone's slice. */
  applyDronePacket: (pkt: DronePacket) => void;
  /** Fold navigation telemetry into the coverage stat. */
  applyNavTelemetry: (nav: NavTelemetry) => void;
  /** Update the connection lifecycle indicator. */
  setConnection: (status: ConnectionStatus) => void;
  /** Drop coverage progress (new mission / reconnect). */
  resetCoverage: () => void;
  /** Full reset of swarm state (new search area deployed). */
  clearMission: () => void;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Normalize a GPS fix to a finite `lng` (backend may send `lng` or `lon`). */
function packetLng(pkt: DronePacket): number | null {
  const lng = pkt.gps?.lng ?? pkt.gps?.lon;
  return Number.isFinite(lng) ? (lng as number) : null;
}

function hasDetection(pkt: DronePacket): boolean {
  return Boolean(pkt.detections && pkt.detections.length > 0);
}

/**
 * Per-packet `DronePosition` cache. Keyed by the `DronePacket` object identity so
 * a drone whose packet did NOT change this tick yields the *same* `DronePosition`
 * reference. That stability is what lets `useShallow` in `useDronePositions`
 * actually short-circuit: without it, a fresh object literal per call is never
 * `Object.is`-equal to the previous one, so the array would compare unequal and
 * the hook would re-render on every unrelated store write. Returns `null` for a
 * packet with no finite coordinate (the drone is then omitted). A `WeakMap` lets
 * superseded packets be garbage-collected.
 */
const positionCache = new WeakMap<DronePacket, DronePosition | null>();

function toPosition(pkt: DronePacket): DronePosition | null {
  const cached = positionCache.get(pkt);
  if (cached !== undefined) return cached;

  const lng = packetLng(pkt);
  const lat = pkt.gps?.lat;
  const pos: DronePosition | null =
    lng === null || !Number.isFinite(lat)
      ? null // reject junk coords — drone omitted from the positions array
      : {
          id: pkt.drone_id,
          lng,
          lat: lat as number,
          status: pkt.health.status,
          hasDetection: hasDetection(pkt),
          coverageActive: pkt.gps?.coverage_active !== false,
        };

  positionCache.set(pkt, pos);
  return pos;
}

// ──────────────────────────────────────────────────────────────────────────
// Store
// ──────────────────────────────────────────────────────────────────────────

export const useSwarmStore = create<SwarmState>((set, get) => ({
  drones: {},
  coverage: {},
  globalCoveragePct: 0,
  connection: 'connecting',
  missionStartMs: null,
  seenAlerts: [],
  alertCount: 0,

  ingest: (msg) => {
    // Defensive: A3 already null/object-guards before calling, but `ingest` is a
    // public action and A1's `isNavTelemetry` would throw on the `in` operator for
    // a non-object. Ignore junk rather than throw (BUG A2-1c).
    const m: unknown = msg;
    if (typeof m !== 'object' || m === null) return;
    if (isNavTelemetry(msg)) get().applyNavTelemetry(msg);
    else get().applyDronePacket(msg);
  },

  applyDronePacket: (pkt) =>
    set((state) => {
      // Drop a structurally-malformed frame instead of throwing (BUG A2-1a): a
      // packet with no id or no `health` block can't drive any panel, so ignore
      // it rather than crash the action (A3 swallows throws, but silently — this
      // keeps the store itself robust and the failure explicit).
      if (!pkt || !pkt.drone_id || !pkt.health) {
        console.warn('[swarm-store] Ignoring drone packet with no drone_id/health.');
        return {};
      }

      const id = pkt.drone_id;

      // Count this as a NEW alert exactly once per (drone, status) transition,
      // mirroring the legacy `seenAlerts` de-duplication.
      const isAlert = pkt.health.signal === 'LOST' || pkt.health.status === 'CRITICAL';
      const alertKey = id + pkt.health.status;
      const firstSeen = isAlert && !state.seenAlerts.includes(alertKey);

      return {
        // New record reference, but every OTHER drone's packet keeps its
        // identity → sibling subscribers do not re-render.
        drones: { ...state.drones, [id]: pkt },
        missionStartMs: state.missionStartMs ?? Date.now(),
        seenAlerts: firstSeen ? [...state.seenAlerts, alertKey] : state.seenAlerts,
        alertCount: firstSeen ? state.alertCount + 1 : state.alertCount,
      };
    }),

  applyNavTelemetry: (nav) =>
    set((state) => {
      const id = String(nav.drone_id ?? '').toUpperCase();
      if (!id) return {};

      const current = Number(nav.current_waypoint_idx) || 0;
      const remaining = Number(nav.waypoints_remaining) || 0;
      // Route length = waypoints hit + waypoints ahead. A `mission_complete`
      // drone has flown its whole route even if both momentarily read 0.
      let total = current + remaining;
      let done = current;
      if (nav.mission_complete) {
        total = Math.max(total, 1);
        done = total;
      }

      const coverage = { ...state.coverage, [id]: { current: done, total } };

      // Waypoint-WEIGHTED global coverage: Σdone / Σtotal across all reporting
      // drones (a long route counts for more than a short one), not a plain
      // mean of per-drone percentages.
      const tracked = Object.values(coverage);
      const totalWp = tracked.reduce((s, d) => s + d.total, 0);
      const doneWp = tracked.reduce((s, d) => s + d.current, 0);
      const globalCoveragePct = totalWp > 0 ? (doneWp / totalWp) * 100 : 0;

      return { coverage, globalCoveragePct };
    }),

  setConnection: (status) =>
    set((state) => ({
      connection: status,
      // Start the mission clock on the first successful connect (legacy
      // `ws.onopen`), so it counts from link-up, not from the first packet.
      // Never reset once set (legacy `if (!missionStart)`).
      missionStartMs:
        status === 'live'
          ? state.missionStartMs ?? Date.now()
          : state.missionStartMs,
    })),

  resetCoverage: () => set({ coverage: {}, globalCoveragePct: 0 }),

  clearMission: () =>
    set({
      drones: {},
      coverage: {},
      globalCoveragePct: 0,
      seenAlerts: [],
      alertCount: 0,
    }),
}));

// ──────────────────────────────────────────────────────────────────────────
// Selector hooks — the read surface (subscribe narrowly, never the whole store)
// ──────────────────────────────────────────────────────────────────────────

/** One drone's latest packet. Re-renders only when THIS drone updates. */
export const useDrone = (id: DroneId): DronePacket | undefined =>
  useSwarmStore((s) => s.drones[id]);

/** Connection lifecycle for the header indicator. */
export const useConnection = (): ConnectionStatus =>
  useSwarmStore((s) => s.connection);

/** Global waypoint-weighted coverage percentage. */
export const useGlobalCoverage = (): number =>
  useSwarmStore((s) => s.globalCoveragePct);

/** Mission start epoch (ms) for the clock; null until first packet/connect. */
export const useMissionStart = (): number | null =>
  useSwarmStore((s) => s.missionStartMs);

/**
 * Live drone positions for Module B (TacticalMap). Each element comes from the
 * identity-stable `toPosition` cache, so `useShallow` compares the array
 * element-wise and the hook re-renders ONLY when a drone's packet actually
 * changed — not on unrelated writes (connection, coverage, alerts). A drone with
 * no finite coordinate is omitted.
 */
export const useDronePositions = (): DronePosition[] =>
  useSwarmStore(
    useShallow((s) => {
      const out: DronePosition[] = [];
      for (const pkt of Object.values(s.drones)) {
        if (!pkt) continue;
        const pos = toPosition(pkt);
        if (pos !== null) out.push(pos);
      }
      return out;
    }),
  );

/** Header summary stats (legacy `refreshSummary`). */
export const useFleetSummary = (): FleetSummary =>
  useSwarmStore(
    useShallow((s) => {
      const drones = Object.values(s.drones).filter(
        (d): d is DronePacket => Boolean(d),
      );
      const online = drones.filter(
        (d) => d.health?.status !== 'CRITICAL' && d.health?.signal !== 'LOST',
      ).length;
      const detections = drones.reduce((n, d) => n + (d.detections?.length ?? 0), 0);
      // Average ONLY over finite batteries (BUG A2-1b): a single drone with a
      // partial/absent `battery` must not poison the whole-fleet readout to NaN.
      const batteries = drones
        .map((d) => d.health?.battery)
        .filter((b): b is number => Number.isFinite(b));
      const avgBattery = batteries.length
        ? batteries.reduce((n, b) => n + b, 0) / batteries.length
        : 0;
      return { online, detections, avgBattery, alerts: s.alertCount };
    }),
  );
