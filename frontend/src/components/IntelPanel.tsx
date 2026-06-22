/**
 * IntelPanel — Task C3 (AI Intel Log Panel), Module C.
 * ----------------------------------------------------
 * Renders the SIX-EYES mission-intelligence strip: a real-time stream of
 * synthesized AI intel lines plus the global "% SEARCHED" metric and a compact
 * severity timeline. Reverse-engineered from the legacy
 * `six_eyes_dashboard.html` AI strip (`generateLocalIntel`, `updateAIStrip`,
 * `pushTimelineEntry`) and the `% SEARCHED` counter (`updateCoverageStat`).
 *
 * TWO exports, split along the Module C interface boundary:
 *   • `IntelPanel`           — PURE layout component. "Consumes status strings
 *                              and raw log text arrays to populate views"
 *                              (interface contract). No store / network imports.
 *   • `ConnectedIntelPanel`  — the Module-A binding seam. Subscribes to the
 *                              swarm store, synthesizes the intel line from live
 *                              drone state, accumulates a capped log history, and
 *                              feeds the pure component. This is the "listening
 *                              cleanly to the store changes from Module A" half.
 *
 * Keeping the pure view free of store imports lets Task C3 be reviewed and
 * snapshot-tested in isolation, exactly like `DashboardShell` / `TacticalMap`.
 *
 * The DATA-SOURCE story matches the legacy note: `deriveIntel()` is a LOCAL
 * fallback mirroring the AIP agent's prompt logic so the strip is live during
 * dev. To swap in real AIP output, feed `IntelPanel` log entries built from the
 * Foundry IntelReport stream and pass `sourceLive` — every other behaviour
 * (timeline, severity colouring, layout) is unchanged.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import './IntelPanel.css';

import type { DroneId, DronePacket } from '../types/telemetry';
import { useSwarmStore, useGlobalCoverage } from '../store/useSwarmStore';

// ──────────────────────────────────────────────────────────────────────────
// Public data contract (consumed by the pure component)
// ──────────────────────────────────────────────────────────────────────────

/** Severity drives the strip colour + timeline bar height (legacy palette). */
export type IntelSeverity = 'normal' | 'warning' | 'critical';

/**
 * A single rich-text fragment of an intel line. `emphasis` reproduces the
 * legacy inline highlight spans (`.hl` amber, `.crit-hl` red) without resorting
 * to `dangerouslySetInnerHTML`, so the view stays a safe pure component.
 */
export interface IntelSegment {
  text: string;
  emphasis?: 'hl' | 'crit-hl';
}

/**
 * One line in the intel log stream. `text` is the flat raw string (the
 * contract's "raw log text"); `segments`, when present, is the same content
 * split for highlight rendering.
 */
export interface IntelLogEntry {
  /** Stable React key. */
  id: string;
  /** Flat raw log text (always present). */
  text: string;
  /** Optional rich rendering preserving the legacy inline highlights. */
  segments?: IntelSegment[];
  severity: IntelSeverity;
  /** Epoch ms the line was emitted. */
  timestamp: number;
}

export interface IntelPanelProps {
  /** Chronological intel lines (oldest first); the newest is the active strip. */
  logs: IntelLogEntry[];
  /** Global waypoint-weighted coverage 0–100 → the "% SEARCHED" counter. */
  coveragePct: number;
  /** false ⇒ "LOCAL SIM" badge, true ⇒ "AIP LIVE" (legacy `setSourceBadge`). */
  sourceLive?: boolean;
  /** Override for the "last report" time; defaults to the newest log entry. */
  lastUpdatedMs?: number | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Display constants (ported from the legacy strip)
// ──────────────────────────────────────────────────────────────────────────

const MAX_TIMELINE_BARS = 12; // legacy `MAX_TIMELINE_BARS`
const MAX_LOG_LINES = 50; // cap the scrollback so memory stays bounded
const BAR_HEIGHT_PCT: Record<IntelSeverity, number> = {
  critical: 100,
  warning: 65,
  normal: 35,
};

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/**
 * Collapse the log stream into timeline bars: one bar per *severity change*
 * (legacy `pushTimelineEntry` only fired when severity differed from the last
 * entry), keeping at most the newest `MAX_TIMELINE_BARS`.
 */
function toTimeline(logs: IntelLogEntry[]): IntelLogEntry[] {
  const bars: IntelLogEntry[] = [];
  for (const entry of logs) {
    const last = bars[bars.length - 1];
    if (!last || last.severity !== entry.severity) bars.push(entry);
  }
  return bars.slice(-MAX_TIMELINE_BARS);
}

// ──────────────────────────────────────────────────────────────────────────
// Pure presentational component (interface contract: layout only)
// ──────────────────────────────────────────────────────────────────────────

/** Render one intel line's text, applying inline highlight spans if present. */
function IntelLine({ entry }: { entry: IntelLogEntry }) {
  if (!entry.segments || entry.segments.length === 0) return <>{entry.text}</>;
  return (
    <>
      {entry.segments.map((seg, i) =>
        seg.emphasis ? (
          <span key={i} className={seg.emphasis}>
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/**
 * The AI intel strip. Pure: every value it shows comes from props. Auto-scrolls
 * the log stream to the newest line (a DOM-only effect, no data coupling).
 */
export function IntelPanel({
  logs,
  coveragePct,
  sourceLive = false,
  lastUpdatedMs,
}: IntelPanelProps) {
  const streamRef = useRef<HTMLDivElement | null>(null);

  const active = logs.length > 0 ? logs[logs.length - 1] : null;
  const severity: IntelSeverity = active?.severity ?? 'normal';
  const timeline = useMemo(() => toTimeline(logs), [logs]);

  const stampMs = lastUpdatedMs ?? active?.timestamp ?? null;
  const pct = Number.isFinite(coveragePct) ? Math.round(coveragePct) : 0;

  // Keep the newest line in view as the stream grows.
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  const stripClass =
    'intel-strip' + (severity !== 'normal' ? ` ${severity}` : '');

  return (
    <div className={stripClass} data-testid="intel-panel">
      <div className="intel-icon" aria-hidden="true">
        &#9673;
      </div>

      <div className="intel-content">
        <div className="intel-meta">
          <span className="intel-title">SIX-EYES MISSION INTELLIGENCE</span>
          <span className={'intel-source-badge' + (sourceLive ? ' live' : '')}>
            {sourceLive ? 'AIP LIVE' : 'LOCAL SIM'}
          </span>
          <span className="intel-timestamp">
            {stampMs ? formatClock(stampMs) : 'awaiting first report'}
          </span>
        </div>

        {/* Scrolling log stream — newest line at the bottom. */}
        <div className="intel-stream" ref={streamRef}>
          {logs.length === 0 ? (
            <div className="intel-line normal placeholder">
              Standing by for telemetry. Connect producers to ws://localhost:8765
              to begin mission.
            </div>
          ) : (
            logs.map((entry) => (
              <div key={entry.id} className={`intel-line ${entry.severity}`}>
                <span className="intel-line-time">
                  {formatClock(entry.timestamp)}
                </span>
                <span className="intel-line-text">
                  <IntelLine entry={entry} />
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* System metric — global "% SEARCHED" counter. */}
      <div className="intel-metric" title="Global swarm search coverage">
        <div className="intel-metric-value">{pct}%</div>
        <div className="intel-metric-label">SEARCHED</div>
      </div>

      {/* Severity timeline — one bar per severity transition. */}
      <div className="intel-timeline" aria-hidden="true">
        {timeline.map((entry) => (
          <div
            key={entry.id}
            className={`intel-timeline-bar ${entry.severity}`}
            style={{ height: `${BAR_HEIGHT_PCT[entry.severity]}%` }}
            title={formatClock(entry.timestamp)}
          />
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Local intel synthesis (LOCAL SIM fallback — mirrors legacy generateLocalIntel)
// ──────────────────────────────────────────────────────────────────────────

/**
 * A fully-primitive descriptor of the current intel line. Returning only
 * primitives lets the store selector use `useShallow`, so `ConnectedIntelPanel`
 * re-derives a log entry ONLY when the meaningful situation changes — not on
 * every 20 Hz packet.
 */
interface IntelDescriptor {
  severity: IntelSeverity;
  kind: 'idle' | 'lost' | 'detection' | 'battery' | 'nominal';
  droneId: string;
  zone: string;
  /** confidence% (detection) | battery% (battery) | online count (nominal). */
  value: number;
}

/** Priority order matches the legacy strip: lost → detection → battery → nominal. */
function deriveIntel(drones: Partial<Record<DroneId, DronePacket>>): IntelDescriptor {
  const list = Object.values(drones).filter((d): d is DronePacket => Boolean(d));
  if (list.length === 0) {
    return { severity: 'normal', kind: 'idle', droneId: '', zone: '', value: 0 };
  }

  const lost = list.find((d) => d.health.signal === 'LOST');
  if (lost) {
    return {
      severity: 'critical',
      kind: 'lost',
      droneId: lost.drone_id,
      zone: lost.mission.zone,
      value: 0,
    };
  }

  const detected = list.find((d) => d.detections && d.detections.length > 0);
  if (detected) {
    return {
      severity: 'warning',
      kind: 'detection',
      droneId: detected.drone_id,
      zone: detected.mission.zone,
      value: Math.round(detected.detections[0].confidence * 100),
    };
  }

  const critical = list.find((d) => d.health.status === 'CRITICAL');
  if (critical) {
    return {
      severity: 'warning',
      kind: 'battery',
      droneId: critical.drone_id,
      zone: critical.mission.zone,
      value: Math.round(critical.health.battery),
    };
  }

  const online = list.filter((d) => d.health.status === 'ONLINE').length;
  return { severity: 'normal', kind: 'nominal', droneId: '', zone: '', value: online };
}

/** Format a descriptor into the legacy strip's rich text (segments + flat text). */
function formatIntel(d: IntelDescriptor): Pick<IntelLogEntry, 'segments' | 'text'> {
  let segments: IntelSegment[];
  switch (d.kind) {
    case 'lost':
      segments = [
        { text: `${d.droneId} has lost signal`, emphasis: 'crit-hl' },
        {
          text: ` in Zone ${d.zone}. Recommend redirecting nearest available unit to maintain zone coverage.`,
        },
      ];
      break;
    case 'detection':
      segments = [
        { text: 'Person detected', emphasis: 'hl' },
        {
          text: ` by ${d.droneId} in Zone ${d.zone} at ${d.value}% confidence. Recommend prioritizing this zone for ground team dispatch.`,
        },
      ];
      break;
    case 'battery':
      segments = [
        { text: `${d.droneId} battery critical`, emphasis: 'hl' },
        { text: ` at ${d.value}%. Recommend return-to-base.` },
      ];
      break;
    case 'nominal':
      segments = [
        {
          text: `All systems nominal. ${d.value}/6 drones online, no active detections. Mission proceeding as planned.`,
        },
      ];
      break;
    case 'idle':
    default:
      segments = [
        {
          text: 'Standing by for telemetry. Connect producers to ws://localhost:8765 to begin mission.',
        },
      ];
      break;
  }
  return { segments, text: segments.map((s) => s.text).join('') };
}

// ──────────────────────────────────────────────────────────────────────────
// Store-connected container (Module A binding seam)
// ──────────────────────────────────────────────────────────────────────────

export interface ConnectedIntelPanelProps {
  /** Pass true once real AIP IntelReport data is wired in (badge → AIP LIVE). */
  sourceLive?: boolean;
}

/**
 * Wires the pure `IntelPanel` to the swarm store. The `useShallow` selector over
 * `deriveIntel` means this component re-renders only when the synthesized intel
 * descriptor actually changes, so the log gains exactly one entry per distinct
 * situation (mirroring the legacy de-dupe), never one per frame.
 */
export function ConnectedIntelPanel({ sourceLive = false }: ConnectedIntelPanelProps = {}) {
  const descriptor = useSwarmStore(useShallow((s) => deriveIntel(s.drones)));
  const coveragePct = useGlobalCoverage();

  const [logs, setLogs] = useState<IntelLogEntry[]>([]);
  const seqRef = useRef(0);

  // `descriptor` keeps referential identity (useShallow) until the situation
  // changes, so this effect appends exactly one capped log line per change.
  useEffect(() => {
    const { text, segments } = formatIntel(descriptor);
    const entry: IntelLogEntry = {
      id: `${Date.now()}-${seqRef.current++}`,
      text,
      segments,
      severity: descriptor.severity,
      timestamp: Date.now(),
    };
    setLogs((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
    });
  }, [descriptor]);

  return <IntelPanel logs={logs} coveragePct={coveragePct} sourceLive={sourceLive} />;
}

export default IntelPanel;
