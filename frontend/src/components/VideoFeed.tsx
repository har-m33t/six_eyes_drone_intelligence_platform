/**
 * VideoFeed — one drone viewport (Module C · Task C2).
 * ----------------------------------------------------
 * Pure, presentational. Renders exactly one of three mutually-exclusive states,
 * selected by the `status` string the parent passes in (Interface Contract:
 * "Consumes status strings … to populate views"):
 *
 *   • LIVE       — the streamed JPEG frame + a YOLO detection overlay + an amber
 *                  "PERSON DETECTED" badge when person detections are present.
 *   • OFFLINE    — frozen last frame in greyscale ("black/static") under a red
 *                  SIGNAL LOST warning. Drives the demo signal-lost scenario.
 *   • NO_SIGNAL  — neutral "NO SIGNAL" placeholder before any frame has arrived.
 *
 * The viewport is driven ENTIRELY by frames streamed from the backend producer
 * over the WebSocket (`packet.frame_b64`) — it never plays the source MP4s
 * directly in the browser. Until the backend streams the first frame (or while
 * the producer is offline) a tile shows the NO SIGNAL placeholder, so the grid
 * is an honest mirror of the live simulation rather than looping local footage.
 *
 * No store/network imports — Module A wires the data in (D2's KILL_DRONE flips a
 * drone to OFFLINE). See `deriveFeedStatus` for the signal→state mapping.
 */

import { useState } from 'react';
import type { Detection, DroneId, SignalState, Zone } from '../types/telemetry';
import { shortDroneLabel } from '../constants/drones';
import './VideoGrid.css';

/** The three terminal render states of a single feed tile. */
export type FeedStatus = 'LIVE' | 'OFFLINE' | 'NO_SIGNAL';

/**
 * Map a drone's radio-signal state + whether a frame has been received to the
 * feed's render state. `LOST` ⇒ OFFLINE (the SIGNAL LOST overlay) regardless of
 * frames; this is the single place the OFFLINE-derives-from-signal rule lives
 * (the wire `DroneStatus` has no OFFLINE member — see `types/telemetry.ts`).
 */
export function deriveFeedStatus(
  signal: SignalState | undefined,
  hasFrame: boolean,
): FeedStatus {
  if (signal === 'LOST') return 'OFFLINE';
  return hasFrame ? 'LIVE' : 'NO_SIGNAL';
}

const DATA_IMAGE_B64_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;

/** True only for a non-empty frame string that can produce an <img> src. */
export function hasRenderableFrame(frame: string | null | undefined): frame is string {
  return typeof frame === 'string' && frame.trim().length > 0;
}

/**
 * The Python backend sends bare base64 in `packet.frame_b64`, and the legacy
 * dashboard rendered it as `data:image/jpeg;base64,${frame_b64}`. Accept an
 * already-prefixed data URL too so the React tile does not double-prefix frames
 * from tests or alternate producers.
 */
export function frameToImageSrc(frame: string | null | undefined): string | null {
  if (!hasRenderableFrame(frame)) return null;
  const value = frame.trim();
  return DATA_IMAGE_B64_RE.test(value) ? value : `data:image/jpeg;base64,${value}`;
}

/**
 * Battery level → severity colour for the live battery bar, mirroring the fleet
 * panel's `statusColor` convention (accent = healthy, amber = warning, red =
 * critical). The <10% threshold lines up with the demo battery-critical alert.
 */
export function batteryColor(battery: number): string {
  if (battery <= 10) return 'var(--red, #ff5c5c)';
  if (battery <= 30) return 'var(--amber, #ffb84d)';
  return 'var(--accent, #a78bfa)';
}

/**
 * Compact hemisphere-tagged coordinate readout for the corner GPS overlay, e.g.
 * `34.0522°N 118.2437°W`. Four decimals ≈ 11 m precision — enough for the demo
 * while keeping the chip narrow so it never crowds the frame.
 */
export function formatGps(lat: number, lng: number): string {
  const fmt = (v: number, pos: string, neg: string) =>
    `${Math.abs(v).toFixed(4)}°${v >= 0 ? pos : neg}`;
  return `${fmt(lat, 'N', 'S')} ${fmt(lng, 'E', 'W')}`;
}

export interface VideoFeedProps {
  droneId: DroneId;
  zone: Zone;
  /** Pre-derived render state (see `deriveFeedStatus`). */
  status: FeedStatus;
  /** Base64 JPEG for the current frame (no `data:` prefix); null/undefined when none. */
  frame?: string | null;
  /** YOLO person detections for the current frame; drives the overlay + badge. */
  detections?: Detection[];
  /**
   * Live battery percentage `[0, 100]` from `health.battery`. Drives the battery
   * bar, which only mounts once the feed is LIVE (connected + streaming), so it
   * "appears upon connection" and disappears again if the drone drops offline.
   */
  battery?: number;
  /**
   * Live GPS fix (`gps.lat` / `gps.lng`) shown as a small corner overlay over the
   * footage. Like the battery bar it only renders while the feed is LIVE.
   */
  gps?: { lat: number; lng: number };
}

interface FrameSize {
  w: number;
  h: number;
}

export function VideoFeed({
  droneId,
  zone,
  status,
  frame,
  detections = [],
  battery,
  gps,
}: VideoFeedProps) {
  // Native pixel dimensions of the streamed frame, captured on first decode.
  // The YOLO bboxes are in this same pixel space, so the overlay's SVG viewBox
  // is set from it to keep boxes registered to the video under `object-fit: cover`.
  const [frameSize, setFrameSize] = useState<FrameSize | null>(null);

  const isOffline = status === 'OFFLINE';
  const imageSrc = frameToImageSrc(frame);
  const hasFrame = imageSrc !== null;
  // Keep the (now frozen, greyscale) last frame visible while OFFLINE; only the
  // never-saw-a-frame NO_SIGNAL state shows the placeholder.
  const showImage = hasFrame && status !== 'NO_SIGNAL';
  // The neutral placeholder stands in until the backend streams the first frame
  // (or while the producer is offline) — the tile never plays a local MP4.
  const showPlaceholder = !showImage && status === 'NO_SIGNAL';
  const hasDetections = detections.length > 0;
  const showOverlay = status === 'LIVE' && hasFrame && hasDetections && frameSize !== null;
  // The battery bar only appears once the feed is LIVE (connected + streaming),
  // so it materialises on connection and is torn down again if the link is lost.
  const showBattery = status === 'LIVE' && typeof battery === 'number' && Number.isFinite(battery);
  const batteryPct = showBattery ? Math.max(0, Math.min(100, battery as number)) : 0;
  // GPS overlay follows the same connection gate as the battery bar: only over a
  // LIVE frame, and only when both coordinates are real numbers.
  const showGps =
    status === 'LIVE' &&
    gps != null &&
    Number.isFinite(gps.lat) &&
    Number.isFinite(gps.lng);

  return (
    <div className={`feed${isOffline ? ' offline' : ''}`} data-drone-id={droneId}>
      {showPlaceholder && (
        <div className="feed-placeholder">
          <div className="pulse" />
          NO SIGNAL
        </div>
      )}

      {showImage && (
        <img
          src={imageSrc}
          alt={`${droneId} live feed`}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth && img.naturalHeight) {
              setFrameSize((prev) =>
                prev && prev.w === img.naturalWidth && prev.h === img.naturalHeight
                  ? prev
                  : { w: img.naturalWidth, h: img.naturalHeight },
              );
            }
          }}
        />
      )}

      {showOverlay && frameSize && (
        <YoloOverlay frameSize={frameSize} detections={detections} />
      )}

      {isOffline && (
        // Real DOM node (not a CSS ::after) so the emergency warning is in the
        // accessibility tree — `role="alert"` makes it an assertive live region —
        // and is assertable in tests. Renders over the frozen/black frame.
        <div className="feed-offline-overlay" role="alert">
          SIGNAL LOST
        </div>
      )}

      <div className="feed-label">
        <span>{shortDroneLabel(droneId)}</span>
        <span className="zone">{zone}</span>
      </div>

      {showGps && gps && (
        // Small telemetry chip tucked in the top-right corner, below the zone
        // label — clear of the battery bar and detect badge so it never blocks
        // the video subject. Updates every tick as the GPS fix changes.
        <div className="feed-gps" aria-label={`${shortDroneLabel(droneId)} GPS coordinates`}>
          <span className="feed-gps-label">GPS</span>
          {formatGps(gps.lat, gps.lng)}
        </div>
      )}

      {status === 'LIVE' && hasDetections && (
        <div className="feed-detect-badge">
          PERSON DETECTED{detections.length > 1 ? ` ×${detections.length}` : ''}
        </div>
      )}

      {showBattery && (
        // Live battery gauge pinned to the bottom of the tile. `role="meter"`
        // exposes the live value to assistive tech; the fill width + colour track
        // the draining battery and re-render every telemetry tick with the frame.
        <div
          className="feed-battery"
          role="meter"
          aria-label={`${shortDroneLabel(droneId)} battery`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(batteryPct)}
        >
          <div className="feed-battery-track">
            <div
              className="feed-battery-fill"
              style={{ width: `${batteryPct}%`, background: batteryColor(batteryPct) }}
            />
          </div>
          <span className="feed-battery-pct" style={{ color: batteryColor(batteryPct) }}>
            {Math.round(batteryPct)}%
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * SVG bounding-box overlay. The viewBox is the frame's native pixel space and
 * `preserveAspectRatio="xMidYMid slice"` mirrors the <img>'s `object-fit: cover`,
 * so each box (`[x1, y1, x2, y2]`) lands exactly on its subject at any panel size.
 */
function YoloOverlay({
  frameSize,
  detections,
}: {
  frameSize: FrameSize;
  detections: Detection[];
}) {
  // Tag text scales with the frame so it stays legible after the slice transform.
  const tagSize = Math.max(9, Math.round(frameSize.h * 0.035));

  return (
    <svg
      className="feed-yolo"
      viewBox={`0 0 ${frameSize.w} ${frameSize.h}`}
      preserveAspectRatio="xMidYMid slice"
    >
      {detections.map((d, i) => {
        const [x1, y1, x2, y2] = d.bbox;
        return (
          <g key={i}>
            <rect
              className="yolo-box"
              x={x1}
              y={y1}
              width={Math.max(0, x2 - x1)}
              height={Math.max(0, y2 - y1)}
            />
            <text
              className="yolo-tag"
              x={x1}
              y={Math.max(tagSize, y1 - 4)}
              fontSize={tagSize}
            >
              {`PERSON ${(d.confidence * 100).toFixed(0)}%`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
