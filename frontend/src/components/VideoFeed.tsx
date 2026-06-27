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
   * URL of the drone's pre-recorded clip, played on loop as the tile's base
   * layer when no live frame is flowing — so the dashboard shows video even
   * without the Python producer. Live frames (above) take over when present.
   * Omitted ⇒ the tile falls back to the neutral NO SIGNAL placeholder.
   */
  videoSrc?: string;
  /** Seconds to seek to on first play, to desync drones sharing a clip. */
  videoStartOffsetS?: number;
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
  videoSrc,
  videoStartOffsetS = 0,
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
  // No live frame? Loop the pre-recorded clip so the tile still shows video.
  // While OFFLINE it greys out under the SIGNAL LOST overlay (same as a frame).
  const showVideo = !showImage && Boolean(videoSrc);
  // The neutral placeholder is the last resort — only when there's neither a
  // live frame nor a clip to fall back to (e.g. tests that pass no `videoSrc`).
  const showPlaceholder = !showImage && !showVideo && status === 'NO_SIGNAL';
  const hasDetections = detections.length > 0;
  const showOverlay = status === 'LIVE' && hasFrame && hasDetections && frameSize !== null;
  // Tag the tile as recorded footage (not a live feed) so a playing clip is not
  // mistaken for a live link — but not while OFFLINE, where SIGNAL LOST rules.
  const showReplayTag = showVideo && !isOffline;

  return (
    <div className={`feed${isOffline ? ' offline' : ''}`} data-drone-id={droneId}>
      {showPlaceholder && (
        <div className="feed-placeholder">
          <div className="pulse" />
          NO SIGNAL
        </div>
      )}

      {showVideo && (
        <video
          className="feed-video"
          src={videoSrc}
          autoPlay
          loop
          muted
          playsInline
          // Seek to the per-drone offset once metadata is known, so drones
          // sharing a clip don't play in lockstep. Guard against an offset past
          // the clip length (we'd otherwise seek to the very end and stall).
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (videoStartOffsetS > 0 && Number.isFinite(v.duration) && videoStartOffsetS < v.duration) {
              v.currentTime = videoStartOffsetS;
            }
          }}
        />
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

      {showReplayTag && (
        // Recorded footage stand-in (no live link yet). `role="status"` keeps it
        // out of the way of the assertive SIGNAL LOST alert.
        <div className="feed-replay-badge" role="status">
          <span className="rec-dot" />
          REPLAY
        </div>
      )}

      {status === 'LIVE' && hasDetections && (
        <div className="feed-detect-badge">
          PERSON DETECTED{detections.length > 1 ? ` ×${detections.length}` : ''}
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
