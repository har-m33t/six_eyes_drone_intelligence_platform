/**
 * DashboardShell — Task C1 (Layout Scaffold), Module C.
 *
 * Pure layout grid component. It reproduces the legacy
 * `six_eyes_dashboard.html` structure (48px header + a 3-column grid with a
 * full-width AI strip) and exposes each interactive region as an optional
 * slot prop. Until a downstream module mounts into a slot, a labelled
 * placeholder is rendered so the wireframe is visible and reviewable.
 *
 * Slot ownership (per the migration plan):
 *   - `map`        → Module B  (TacticalMap.tsx)
 *   - `videoFeeds` → Task C2    (VideoGrid.tsx)
 *   - `sidebar`    → fleet status / metrics (right column)
 *   - `intel`      → Task C3    (IntelPanel.tsx — AI intel strip)
 *   - header slots → Module D  (deploy controls, conn status, mission clock)
 *
 * The component holds NO telemetry state and imports nothing from the store or
 * network layers — it stays a "pure layout grid component" per the Module C
 * interface contract, so it can be built and reviewed independently of A/B/D.
 */

import type { ReactNode } from 'react';
import '../styles/theme.css';
import './DashboardShell.css';

interface PlaceholderProps {
  label: string;
  hint?: string;
}

/** Labelled dashed-frame stand-in shown until a real module fills the slot. */
function Placeholder({ label, hint }: PlaceholderProps) {
  return (
    <div className="shell-placeholder">
      <div className="ph-pulse" />
      <div className="ph-label">{label}</div>
      {hint ? <div className="ph-hint">{hint}</div> : null}
    </div>
  );
}

export interface DashboardShellProps {
  /* ── Header slots (wired by Module D) ── */
  /** Connection status indicator, sits just right of the logo. */
  connectionStatus?: ReactNode;
  /** Deploy-swarm controls (draw / clear / deploy), right-aligned group. */
  deployControls?: ReactNode;
  /** Mission clock readout, far right of the header. */
  missionClock?: ReactNode;

  /* ── Panel header counters ── */
  /** "N/6 ONLINE" badge in the LIVE FEEDS panel header. */
  feedCount?: ReactNode;
  /** "N% SEARCHED" badge in the POSITION // GPS panel header. */
  coverage?: ReactNode;

  /* ── Panel body slots ── */
  /** Streaming video grid (Task C2). */
  videoFeeds?: ReactNode;
  /** Geospatial map frame (Module B). */
  map?: ReactNode;
  /** Fleet status / mission summary sidebar (right column). */
  sidebar?: ReactNode;
  /** AI intel log strip (Task C3). */
  intel?: ReactNode;
}

/**
 * Top-level structural shell. Renders the header bar and the tactical grid,
 * delegating every populated region to its slot prop (or a placeholder).
 */
export default function DashboardShell({
  connectionStatus,
  deployControls,
  missionClock,
  feedCount,
  coverage,
  videoFeeds,
  map,
  sidebar,
  intel,
}: DashboardShellProps) {
  return (
    <div className="shell-root">
      {/* Single top banner — the swarm control panel. Brand, connection status,
          the DRAW AREA · CLEAR · DEPLOY SWARM command group, and the mission
          clock all live in ONE prominent bar at the very top (merged from the
          old two-row brand-header + command-bar split), so the control panel is
          front-and-centre rather than tucked into a secondary row. */}
      <header className="shell-banner">
        <div className="shell-logo">
          SIX&#8209;EYES <span>// DRONE FLEET INTELLIGENCE</span>
        </div>

        {/* Connection status — immediately right of the brand. */}
        <div className="shell-banner-conn">
          {connectionStatus ?? (
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              CONNECTING&hellip;
            </span>
          )}
        </div>

        {/* Control panel — the swarm command center. `margin-left:auto` (in CSS)
            pushes this group and the clock to the right side of the banner; the
            raised, bordered frame makes it read as a distinct control panel. */}
        <div className="shell-control-panel">
          <span className="shell-control-panel-label">SWARM CONTROL</span>
          <div className="shell-control-panel-slot">
            {deployControls ?? (
              <span style={{ fontSize: 9.5, color: 'var(--text-dim)' }}>
                DEPLOY CONTROLS
              </span>
            )}
          </div>
        </div>

        {/* Mission clock — far right. */}
        <div className="shell-banner-clock">
          {missionClock ?? (
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              MISSION T+ 00:00:00
            </span>
          )}
        </div>
      </header>

      <main className="shell-grid">
        {/* Column 1 — live video feeds. */}
        <section className="shell-panel">
          <div className="shell-panel-head">
            <span>LIVE FEEDS</span>
            <span className="count">{feedCount ?? '0/6 ONLINE'}</span>
          </div>
          <div className="shell-panel-body">
            {videoFeeds ?? <Placeholder label="Video Feeds" hint="Task C2 · VideoGrid" />}
          </div>
        </section>

        {/* Column 2 — geospatial map. */}
        <section className="shell-panel">
          <div className="shell-panel-head">
            <span>POSITION // GPS</span>
            <span className="count">{coverage ?? 'COVERAGE 0%'}</span>
          </div>
          <div className="shell-panel-body">
            {map ?? <Placeholder label="Map Frame" hint="Module B · TacticalMap" />}
          </div>
        </section>

        {/* Column 3 — fleet status / mission summary sidebar. */}
        <section className="shell-panel">
          <div className="shell-panel-head">
            <span>FLEET STATUS</span>
          </div>
          <div className="shell-panel-body">
            {sidebar ?? <Placeholder label="Fleet Status" hint="Mission summary · health" />}
          </div>
        </section>

        {/* Full-width bottom row — AI intel strip. */}
        <section className="shell-ai-strip">
          {intel ?? <Placeholder label="AI Intel Log" hint="Task C3 · IntelPanel" />}
        </section>
      </main>
    </div>
  );
}
