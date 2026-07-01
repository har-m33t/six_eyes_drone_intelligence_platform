/**
 * App — top-level composition (Module D / integration).
 * ------------------------------------------------------
 * Wires the four parallel modules into the running dashboard:
 *   • Module A (store + socket) — consumed through narrow selector hooks so a
 *     20 Hz telemetry tick only re-renders the panel that needs it, never the
 *     whole tree (the A2 "no root re-render" contract).
 *   • Module B (TacticalMap)    — fed `useDronePositions()`; surfaces the draw
 *     handle + perimeter callback for the deploy flow.
 *   • Module C (DashboardShell / VideoGrid / IntelPanel) — pure layout slots.
 *   • Module D (useDeploySwarm / DeployControls / useKeyboardControls) — the
 *     orchestrator glue linking user actions to Module-A commands.
 *
 * Each "Connected*" wrapper owns its own narrow subscription, so App itself only
 * re-renders on low-frequency events (deploy state, draw-handle ready) — not on
 * telemetry.
 */

import { useEffect, useRef, useState } from 'react';
import DashboardShell from './components/DashboardShell';
import { TacticalMap } from './components/TacticalMap';
import { VideoGrid, countOnlineFeeds, type DroneFeedData } from './components/VideoGrid';
import { ConnectedIntelPanel } from './components/IntelPanel';
import DeployControls from './components/DeployControls';
import { useDeploySwarm } from './controllers/useDeploySwarm';
import { useKeyboardControls } from './hooks/useKeyboardControls';
import type { MapboxDrawHandle } from './map/useMapboxDraw';
import type { LngLat, DroneId, DronePacket } from './types/telemetry';
import {
  useSwarmStore,
  useConnection,
  useCoveragePositions,
  useDronePositions,
  useFleetSummary,
  useGlobalCoverage,
  useMissionEpoch,
  useMissionStart,
  type ConnectionStatus,
} from './store/useSwarmStore';
import { DRONE_IDS, ZONES, shortDroneLabel } from './constants/drones';
import './App.css';

// ──────────────────────────────────────────────────────────────────────────
// Header: connection status
// ──────────────────────────────────────────────────────────────────────────

const CONN_META: Record<ConnectionStatus, { label: string; color: string }> = {
  connecting: { label: 'CONNECTING', color: 'var(--amber)' },
  live: { label: 'LIVE', color: 'var(--accent)' },
  reconnecting: { label: 'RECONNECTING', color: 'var(--amber)' },
  closed: { label: 'OFFLINE', color: 'var(--red)' },
};

function ConnectionStatusBadge() {
  const status = useConnection();
  const meta = CONN_META[status];
  return (
    <span className="conn-badge">
      <span className="conn-dot" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Header: mission clock (ticks once a second off the store's start epoch)
// ──────────────────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function MissionClock() {
  const start = useMissionStart();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = start ? Math.max(0, Date.now() - start) : 0;
  return <span className="mission-clock">MISSION T+ {formatElapsed(elapsed)}</span>;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-feed view data (shared by the LIVE FEEDS header count and the grid)
// ──────────────────────────────────────────────────────────────────────────

function buildFeeds(
  drones: Partial<Record<DroneId, DronePacket>>,
): Partial<Record<DroneId, DroneFeedData>> {
  const feeds: Partial<Record<DroneId, DroneFeedData>> = {};
  for (const id of DRONE_IDS) {
    const pkt = drones[id];
    if (!pkt) continue;
    const gps = pkt.gps;
    feeds[id] = {
      signal: pkt.health?.signal,
      frame: typeof pkt.frame_b64 === 'string' ? pkt.frame_b64 : null,
      detections: pkt.detections,
      battery: pkt.health?.battery,
      // `lng` is canonical; fall back to the `lon` alias older producers send.
      gps: gps ? { lat: gps.lat, lng: gps.lng ?? gps.lon } : undefined,
    };
  }
  return feeds;
}

// ──────────────────────────────────────────────────────────────────────────
// Panel-header counters
// ──────────────────────────────────────────────────────────────────────────

function FeedCountBadge() {
  // Count feeds that are ACTUALLY streaming video (a frame is flowing and the
  // link is not LOST), not health-online drones. The two diverge — a drone with
  // a healthy radio link may still send no video — and the badge previously read
  // the health count (`useFleetSummary().online`), so the LIVE FEEDS panel could
  // claim "6/6 ONLINE" while every tile sat on its NO SIGNAL placeholder
  // (ui-fixes.md #2: "states 6/6 ONLINE but not a single video feed visible").
  // Deriving from the same feed data the grid renders keeps the header honest.
  const drones = useSwarmStore((s) => s.drones);
  return <>{countOnlineFeeds(buildFeeds(drones))}/6 ONLINE</>;
}

function CoverageBadge() {
  const pct = useGlobalCoverage();
  return <>{pct.toFixed(0)}% SEARCHED</>;
}

// ──────────────────────────────────────────────────────────────────────────
// Map column — feeds the live positions to Module B
// ──────────────────────────────────────────────────────────────────────────

interface ConnectedMapProps {
  onPerimeterDrawn: (coords: LngLat[]) => void;
  onDrawReady: (handle: MapboxDrawHandle) => void;
}

function ConnectedMap({ onPerimeterDrawn, onDrawReady }: ConnectedMapProps) {
  const positions = useDronePositions();
  // The footprint traces the nav search-sweep (NavTelemetry), not GPS (B4-5);
  // the markers stay on GPS positions above.
  const coveragePositions = useCoveragePositions();
  // Bumped on every deploy/clear so the coverage footprint wipes for a new
  // search area instead of painting over the old one (review bug B4-4).
  const coverageEpoch = useMissionEpoch();
  return (
    <TacticalMap
      positions={positions}
      coveragePositions={coveragePositions}
      onPerimeterDrawn={onPerimeterDrawn}
      onDrawReady={onDrawReady}
      coverageEpoch={coverageEpoch}
    />
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Video column — derives per-feed data from the live drone packets
// ──────────────────────────────────────────────────────────────────────────

function ConnectedVideoGrid() {
  // Frames change every tick, so this panel intentionally re-renders with the
  // telemetry stream — the subscription is scoped here so nothing else does.
  const drones = useSwarmStore((s) => s.drones);
  return <VideoGrid feeds={buildFeeds(drones)} />;
}

// ──────────────────────────────────────────────────────────────────────────
// Fleet-status sidebar
// ──────────────────────────────────────────────────────────────────────────

function statusColor(status: string | undefined): string {
  if (status === 'CRITICAL') return 'var(--red)';
  if (status === 'WARNING') return 'var(--amber)';
  return 'var(--accent)';
}

function ConnectedSidebar() {
  const drones = useSwarmStore((s) => s.drones);
  const summary = useFleetSummary();
  return (
    <div className="fleet">
      <div className="fleet-stats">
        <div className="fleet-stat">
          <span className="fleet-stat-val">{summary.online}/6</span>
          <span className="fleet-stat-lbl">ONLINE</span>
        </div>
        <div className="fleet-stat">
          <span className="fleet-stat-val">{summary.detections}</span>
          <span className="fleet-stat-lbl">DETECTIONS</span>
        </div>
        <div className="fleet-stat">
          <span className="fleet-stat-val">{summary.avgBattery.toFixed(0)}%</span>
          <span className="fleet-stat-lbl">AVG BATT</span>
        </div>
        <div className="fleet-stat">
          <span className="fleet-stat-val">{summary.alerts}</span>
          <span className="fleet-stat-lbl">ALERTS</span>
        </div>
      </div>

      <div className="fleet-rows">
        {DRONE_IDS.map((id) => {
          const pkt = drones[id];
          const h = pkt?.health;
          return (
            <div className="fleet-row" key={id}>
              <span className="fleet-row-id">{shortDroneLabel(id)}</span>
              <span className="fleet-row-zone">{ZONES[id]}</span>
              <span className="fleet-row-status" style={{ color: statusColor(h?.status) }}>
                {h?.status ?? '—'}
              </span>
              <span className="fleet-row-sig">{h?.signal ?? '—'}</span>
              <span className="fleet-row-batt">
                {h && Number.isFinite(h.battery) ? `${h.battery.toFixed(0)}%` : '—'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// App
// ──────────────────────────────────────────────────────────────────────────

export default function App() {
  // Module D: K → KILL_DRONE(DRONE_3) presentation control.
  useKeyboardControls();

  // The Mapbox Draw handle is published by TacticalMap once the map is ready;
  // the deploy controller drives DRAW/CLEAR through it. Held in a ref-backed
  // state so a late handle re-arms the controller exactly once.
  const [drawHandle, setDrawHandle] = useState<MapboxDrawHandle | null>(null);
  const onDrawReadyRef = useRef((handle: MapboxDrawHandle) => setDrawHandle(handle));

  const deploy = useDeploySwarm({ draw: drawHandle });

  return (
    <DashboardShell
      connectionStatus={<ConnectionStatusBadge />}
      deployControls={<DeployControls controller={deploy} />}
      missionClock={<MissionClock />}
      feedCount={<FeedCountBadge />}
      coverage={<CoverageBadge />}
      videoFeeds={<ConnectedVideoGrid />}
      map={
        <ConnectedMap
          onPerimeterDrawn={deploy.onPerimeterDrawn}
          onDrawReady={onDrawReadyRef.current}
        />
      }
      sidebar={<ConnectedSidebar />}
      intel={<ConnectedIntelPanel />}
    />
  );
}
