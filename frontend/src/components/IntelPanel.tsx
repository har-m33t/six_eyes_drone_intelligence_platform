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

  // Keep the newest line in view as the stream grows. Keyed on the newest
  // entry's identity (NOT `logs.length`): once the connected container caps the
  // stream at MAX_LOG_LINES the length plateaus, so a length dep would stop
  // firing on new content. `logs` is a fresh array per append, and `active?.id`
  // changes whenever the newest line does, so this re-scrolls on every new line.
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, active?.id]);

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

/** The kind of situation an intel line describes. */
type IntelKind = 'idle' | 'lost' | 'detection' | 'battery' | 'nominal';

/** True for the three actionable alert kinds (everything except idle/nominal). */
function isAlertKind(kind: IntelKind): boolean {
  return kind === 'lost' || kind === 'detection' || kind === 'battery';
}

/**
 * One synthesized situation for a single drone (or the swarm-wide idle/nominal
 * fallback). `value` is the display-only volatile reading — confidence% for a
 * detection, battery% for a battery alert, online count for nominal — read fresh
 * each derivation. It feeds a grouped line's range/latest but NEVER participates
 * in a line's identity (see `descriptorKey`), so a detection whose confidence
 * wiggles ±1 every 20 Hz frame stays one line.
 */
interface IntelDescriptor {
  severity: IntelSeverity;
  kind: IntelKind;
  droneId: string;
  zone: string;
  value: number;
}

/**
 * The STABLE identity of a situation: kind + drone + zone, with the volatile
 * `value` deliberately excluded. Two detections of the same drone/zone whose
 * confidence merely drifts share one key, so they coalesce into a single grouped
 * line instead of spamming one line per frame (ui-fixes issue 6). Returning a
 * primitive string lets the store selector use `useShallow` over the key array,
 * so `ConnectedIntelPanel` re-renders only when the SET of situations changes.
 */
function descriptorKey(d: IntelDescriptor): string {
  return `${d.kind}:${d.droneId}:${d.zone}`;
}

/**
 * Derive EVERY active situation — one descriptor per drone with an alert
 * condition (per-drone priority: lost → detection → battery). Returning the full
 * set (not just the single highest-priority "headline") is what fixes the spam:
 * two drones detecting at once each get their own grouped line instead of
 * fighting over one slot and oscillating, which previously appended a fresh line
 * on every flip. When no drone has an alert, returns a single nominal descriptor
 * (or idle, before any telemetry).
 */
function deriveIntelAll(drones: Partial<Record<DroneId, DronePacket>>): IntelDescriptor[] {
  const list = Object.values(drones).filter((d): d is DronePacket => Boolean(d));
  if (list.length === 0) {
    return [{ severity: 'normal', kind: 'idle', droneId: '', zone: '', value: 0 }];
  }

  const alerts: IntelDescriptor[] = [];
  for (const d of list) {
    if (d.health.signal === 'LOST') {
      alerts.push({
        severity: 'critical',
        kind: 'lost',
        droneId: d.drone_id,
        zone: d.mission.zone,
        value: 0,
      });
    } else if (d.detections && d.detections.length > 0) {
      alerts.push({
        severity: 'warning',
        kind: 'detection',
        droneId: d.drone_id,
        zone: d.mission.zone,
        value: Math.round(d.detections[0].confidence * 100),
      });
    } else if (d.health.status === 'CRITICAL') {
      alerts.push({
        severity: 'warning',
        kind: 'battery',
        droneId: d.drone_id,
        zone: d.mission.zone,
        value: Math.round(d.health.battery),
      });
    }
  }
  if (alerts.length > 0) return alerts;

  const online = list.filter((d) => d.health.status === 'ONLINE').length;
  return [{ severity: 'normal', kind: 'nominal', droneId: '', zone: '', value: online }];
}

// ──────────────────────────────────────────────────────────────────────────
// Grouped alert log (ui-fixes issue 6 — coalesce repeats into one updating line)
// ──────────────────────────────────────────────────────────────────────────

/**
 * A coalesced intel line. Repeated observations of the same `key` within
 * `GROUP_WINDOW_MS` fold into one of these — bumping `count`, widening the
 * [`valueMin`, `valueMax`] range and refreshing `lastTs` — so a sustained,
 * flickering detection reads as a single "Person detected … 49–69% (×N)" line
 * that UPDATES in place, never a fresh line per frame.
 */
interface AlertGroup {
  /** Stable React key — kept across updates so the line mutates, not remounts. */
  id: string;
  /** `descriptorKey` identity that groups observations together. */
  key: string;
  kind: IntelKind;
  droneId: string;
  zone: string;
  severity: IntelSeverity;
  /** Epoch ms of the most recent observation (drives the line's clock). */
  lastTs: number;
  /** How many times this active alert has been (re)observed. */
  count: number;
  valueMin: number;
  valueMax: number;
  latestValue: number;
}

/** Repeats of an alert this long after its last sighting open a FRESH line. */
const GROUP_WINDOW_MS = 12_000;

/** `min%`, or `min–max%` once the observed range has spread. */
function rangePct(min: number, max: number): string {
  return min === max ? `${min}%` : `${min}–${max}%`;
}

/** Render a grouped alert into the pure panel's `{ segments, text }` shape. */
function formatGroup(g: AlertGroup): Pick<IntelLogEntry, 'segments' | 'text'> {
  const times = g.count > 1 ? ` (×${g.count})` : '';
  let segments: IntelSegment[];
  switch (g.kind) {
    case 'lost':
      segments = [
        { text: `${g.droneId} has lost signal`, emphasis: 'crit-hl' },
        {
          text: ` in Zone ${g.zone}${times}. Recommend redirecting nearest available unit to maintain zone coverage.`,
        },
      ];
      break;
    case 'detection':
      segments = [
        { text: 'Person detected', emphasis: 'hl' },
        {
          text: ` by ${g.droneId} in Zone ${g.zone} at ${rangePct(g.valueMin, g.valueMax)} confidence${times}. Recommend prioritizing this zone for ground team dispatch.`,
        },
      ];
      break;
    case 'battery':
      segments = [
        { text: `${g.droneId} battery critical`, emphasis: 'hl' },
        { text: ` at ${rangePct(g.valueMin, g.valueMax)}${times}. Recommend return-to-base.` },
      ];
      break;
    case 'nominal':
      segments = [
        {
          text: `All systems nominal. ${g.latestValue}/6 drones online, no active detections. Mission proceeding as planned.`,
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

/** Project a grouped alert to the immutable log-entry the pure panel renders. */
function groupToEntry(g: AlertGroup): IntelLogEntry {
  return { id: g.id, severity: g.severity, timestamp: g.lastTs, ...formatGroup(g) };
}

/**
 * Fold the current descriptors into the running group list. Active alerts
 * coalesce into (or open) their group; the idle/nominal status line is appended
 * only when NO alert is still live in the window — so it never interleaves with
 * the flicker gaps of an ongoing detection. Returns `prev` unchanged when there
 * is nothing to do, keeping the array reference stable to avoid a needless render.
 */
function coalesce(
  prev: AlertGroup[],
  descriptors: IntelDescriptor[],
  now: number,
  nextId: () => string,
): AlertGroup[] {
  const alerts = descriptors.filter((d) => isAlertKind(d.kind));
  if (alerts.length === 0) {
    const ongoing = prev.some(
      (g) => isAlertKind(g.kind) && now - g.lastTs <= GROUP_WINDOW_MS,
    );
    if (ongoing) return prev; // suppress idle/nominal while an alert flickers
  }

  const next = prev.slice();
  const upsert = (d: IntelDescriptor) => {
    const key = descriptorKey(d);
    let idx = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].key === key) {
        idx = i;
        break;
      }
    }
    if (idx >= 0 && now - next[idx].lastTs <= GROUP_WINDOW_MS) {
      const g = next[idx];
      next[idx] = {
        ...g,
        severity: d.severity,
        lastTs: now,
        count: g.count + 1,
        valueMin: Math.min(g.valueMin, d.value),
        valueMax: Math.max(g.valueMax, d.value),
        latestValue: d.value,
      };
    } else {
      next.push({
        id: nextId(),
        key,
        kind: d.kind,
        droneId: d.droneId,
        zone: d.zone,
        severity: d.severity,
        lastTs: now,
        count: 1,
        valueMin: d.value,
        valueMax: d.value,
        latestValue: d.value,
      });
    }
  };

  (alerts.length > 0 ? alerts : descriptors).forEach(upsert);
  return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
}

// ──────────────────────────────────────────────────────────────────────────
// Store-connected container (Module A binding seam)
// ──────────────────────────────────────────────────────────────────────────

export interface ConnectedIntelPanelProps {
  /** Pass true once real AIP IntelReport data is wired in (badge → AIP LIVE). */
  sourceLive?: boolean;
}

/**
 * Wires the pure `IntelPanel` to the swarm store. The `useShallow` selector
 * returns the STABLE key of every active situation (no volatile `value`), so
 * this component re-renders only when the SET of situations changes — a new
 * alert appears or one clears — never one render per 20 Hz frame while a
 * detection's confidence wiggles.
 *
 * On each such change it folds the FRESH descriptors into a GROUPED log
 * (`coalesce`): a sustained, flickering detection becomes one line that updates
 * in place with a widening confidence range and a repeat count, rather than a
 * new "Person detected …" line every second (ui-fixes issue 6).
 */
export function ConnectedIntelPanel({ sourceLive = false }: ConnectedIntelPanelProps = {}) {
  const activeKeys = useSwarmStore(
    useShallow((s) => deriveIntelAll(s.drones).map(descriptorKey)),
  );
  const coveragePct = useGlobalCoverage();

  const [groups, setGroups] = useState<AlertGroup[]>([]);
  const seqRef = useRef(0);

  // `activeKeys` keeps referential identity (useShallow) until the situation set
  // changes, so this effect runs per distinct event, never per frame. Read the
  // full descriptors (with their current values) fresh here rather than the keys.
  useEffect(() => {
    const descriptors = deriveIntelAll(useSwarmStore.getState().drones);
    setGroups((prev) =>
      coalesce(prev, descriptors, Date.now(), () => `${Date.now()}-${seqRef.current++}`),
    );
  }, [activeKeys]);

  const logs = useMemo(() => groups.map(groupToEntry), [groups]);

  return <IntelPanel logs={logs} coveragePct={coveragePct} sourceLive={sourceLive} />;
}

export default IntelPanel;
