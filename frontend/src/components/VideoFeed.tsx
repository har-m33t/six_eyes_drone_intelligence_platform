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

export interface VideoFeedProps {
  droneId: DroneId;
  zone: Zone;
  /** Pre-derived render state (see `deriveFeedStatus`). */
  status: FeedStatus;
  /** Base64 JPEG for the current frame (no `data:` prefix); null/undefined when none. */
  frame?: string | null;
  /** YOLO person detections for the current frame; drives the overlay + badge. */
  detections?: Detection[];
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
}: VideoFeedProps) {
  // Native pixel dimensions of the streamed frame, captured on first decode.
  // The YOLO bboxes are in this same pixel space, so the overlay's SVG viewBox
  // is set from it to keep boxes registered to the video under `object-fit: cover`.
  const [frameSize, setFrameSize] = useState<FrameSize | null>(null);

  const isOffline = status === 'OFFLINE';
  const hasFrame = Boolean(frame);
  // Keep the (now frozen, greyscale) last frame visible while OFFLINE; only the
  // never-saw-a-frame NO_SIGNAL state shows the placeholder.
  const showImage = hasFrame && status !== 'NO_SIGNAL';
  const showPlaceholder = !hasFrame && status === 'NO_SIGNAL';
  const hasDetections = detections.length > 0;
  const showOverlay = status === 'LIVE' && hasFrame && hasDetections && frameSize !== null;

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
          src={`data:image/jpeg;base64,${frame}`}
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
