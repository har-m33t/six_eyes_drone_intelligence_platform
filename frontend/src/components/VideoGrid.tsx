/**
 * VideoGrid — the streaming 3×2 feed wall (Module C · Task C2).
 * ------------------------------------------------------------
 * Pure layout component (Interface Contract: "Pure layout grid component").
 * Always renders EXACTLY six feeds in the fixed `DRONE_IDS` order, merging in
 * whatever per-drone data the parent supplies; drones with no data yet render as
 * NO_SIGNAL placeholders, matching the legacy "scaffold all six up front" build.
 *
 * It owns no store/network wiring — Module A/D pass `feeds` down. Per-feed render
 * state is derived locally via `deriveFeedStatus(signal, hasFrame)`.
 */

import type { Detection, DroneId, SignalState } from '../types/telemetry';
import { DRONE_IDS, ZONES } from '../constants/drones';
import { VideoFeed, deriveFeedStatus } from './VideoFeed';
import './VideoGrid.css';

/** Per-drone view data the grid needs to render one feed tile. */
export interface DroneFeedData {
  /** Radio-link state; `LOST` flips the tile to the SIGNAL LOST overlay. */
  signal?: SignalState;
  /** Latest base64 JPEG frame (no `data:` prefix). */
  frame?: string | null;
  /** YOLO person detections for the latest frame. */
  detections?: Detection[];
}

export interface VideoGridProps {
  /** Sparse per-drone feed data, keyed by drone id. Missing drones ⇒ NO_SIGNAL. */
  feeds?: Partial<Record<DroneId, DroneFeedData>>;
}

export function VideoGrid({ feeds }: VideoGridProps) {
  return (
    <div className="video-grid">
      {DRONE_IDS.map((id) => {
        const data = feeds?.[id];
        const status = deriveFeedStatus(data?.signal, Boolean(data?.frame));
        return (
          <VideoFeed
            key={id}
            droneId={id}
            zone={ZONES[id]}
            status={status}
            frame={data?.frame}
            detections={data?.detections}
          />
        );
      })}
    </div>
  );
}

/** Count of feeds that are actively streaming (status LIVE — a frame is flowing
 *  and the link is not LOST). Handy for the "X/6 ONLINE" header DashboardShell
 *  (Task C1) owns; NO_SIGNAL (no frame yet) and OFFLINE feeds do not count. */
export function countOnlineFeeds(feeds?: Partial<Record<DroneId, DroneFeedData>>): number {
  return DRONE_IDS.reduce((n, id) => {
    const data = feeds?.[id];
    return deriveFeedStatus(data?.signal, Boolean(data?.frame)) === 'LIVE' ? n + 1 : n;
  }, 0);
}
