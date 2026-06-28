/**
 * Tests for Task C2 — VideoGrid + VideoFeed.
 *
 * Covers the pure status-derivation logic, the always-six-feeds invariant, the
 * three render states, the detection badge/overlay, and a batch of adversarial
 * inputs aimed at breaking the components.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { VideoGrid, countOnlineFeeds, type DroneFeedData } from './VideoGrid';
import {
  VideoFeed,
  deriveFeedStatus,
  frameToImageSrc,
  hasRenderableFrame,
} from './VideoFeed';
import { DRONE_IDS, ZONES } from '../constants/drones';
import type { DroneId } from '../types/telemetry';
import { makeDetection, FAKE_FRAME_B64 } from '../test/factories';

// ── deriveFeedStatus — the single source of the signal→state rule ──────────
describe('deriveFeedStatus', () => {
  it('LOST signal ⇒ OFFLINE regardless of frame', () => {
    expect(deriveFeedStatus('LOST', true)).toBe('OFFLINE');
    expect(deriveFeedStatus('LOST', false)).toBe('OFFLINE');
  });

  it('a frame with a non-lost link ⇒ LIVE', () => {
    expect(deriveFeedStatus('STRONG', true)).toBe('LIVE');
    expect(deriveFeedStatus('WEAK', true)).toBe('LIVE');
    expect(deriveFeedStatus(undefined, true)).toBe('LIVE');
  });

  it('no frame yet (and not lost) ⇒ NO_SIGNAL', () => {
    expect(deriveFeedStatus('STRONG', false)).toBe('NO_SIGNAL');
    expect(deriveFeedStatus(undefined, false)).toBe('NO_SIGNAL');
  });
});

describe('frame normalization', () => {
  it('matches the legacy dashboard by prefixing bare backend frame_b64', () => {
    expect(frameToImageSrc(FAKE_FRAME_B64)).toBe(`data:image/jpeg;base64,${FAKE_FRAME_B64}`);
  });

  it('accepts already-prefixed data URLs without double-prefixing', () => {
    const url = `data:image/png;base64,${FAKE_FRAME_B64}`;
    expect(frameToImageSrc(url)).toBe(url);
  });

  it('does not treat empty or whitespace-only frame strings as renderable', () => {
    expect(hasRenderableFrame('')).toBe(false);
    expect(hasRenderableFrame('   ')).toBe(false);
    expect(frameToImageSrc('   ')).toBeNull();
  });
});

// ── countOnlineFeeds ───────────────────────────────────────────────────────
describe('countOnlineFeeds', () => {
  it('is 0 for undefined / empty feeds', () => {
    expect(countOnlineFeeds(undefined)).toBe(0);
    expect(countOnlineFeeds({})).toBe(0);
  });

  it('counts only LIVE feeds (a frame flowing, link not LOST)', () => {
    const feeds: Partial<Record<DroneId, DroneFeedData>> = {
      DRONE_1: { signal: 'STRONG', frame: FAKE_FRAME_B64 }, // LIVE
      DRONE_2: { signal: 'WEAK', frame: FAKE_FRAME_B64 }, //   LIVE
      DRONE_3: { signal: 'LOST', frame: FAKE_FRAME_B64 }, //   OFFLINE
      DRONE_4: { signal: 'STRONG' }, //                        NO_SIGNAL (no frame)
    };
    expect(countOnlineFeeds(feeds)).toBe(2);
  });

  it('does not count a whitespace-only frame as LIVE', () => {
    const feeds: Partial<Record<DroneId, DroneFeedData>> = {
      DRONE_1: { signal: 'STRONG', frame: '   ' },
    };
    expect(countOnlineFeeds(feeds)).toBe(0);
  });

  it('never exceeds six even if extra ids are present', () => {
    const feeds = {} as Partial<Record<DroneId, DroneFeedData>>;
    for (const id of DRONE_IDS) feeds[id] = { signal: 'STRONG', frame: FAKE_FRAME_B64 };
    // a junk id outside the roster must be ignored by the roster-driven count
    (feeds as Record<string, DroneFeedData>)['DRONE_99'] = {
      signal: 'STRONG',
      frame: FAKE_FRAME_B64,
    };
    expect(countOnlineFeeds(feeds)).toBe(6);
  });
});

// ── VideoGrid — always six, fixed order ─────────────────────────────────────
describe('VideoGrid', () => {
  it('always renders exactly six feed tiles in DRONE_IDS order with correct zones', () => {
    const { container } = render(<VideoGrid />);
    const tiles = container.querySelectorAll('.feed');
    expect(tiles).toHaveLength(6);

    DRONE_IDS.forEach((id, i) => {
      const tile = tiles[i] as HTMLElement;
      expect(tile.getAttribute('data-drone-id')).toBe(id);
      // each tile shows its short label (D1…D6) and zone callsign
      expect(within(tile).getByText(id.replace('DRONE_', 'D'))).toBeInTheDocument();
      expect(within(tile).getByText(ZONES[id])).toBeInTheDocument();
    });
  });

  it('renders all six when feeds is sparse: streamed tiles show <img>, the rest NO SIGNAL', () => {
    const { container } = render(
      <VideoGrid feeds={{ DRONE_1: { signal: 'STRONG', frame: FAKE_FRAME_B64 } }} />,
    );
    expect(container.querySelectorAll('.feed')).toHaveLength(6);
    // The one drone with a backend frame renders an <img>; the other five have no
    // live frame and show the NO SIGNAL placeholder. Video is backend-streamed
    // only — the grid never plays a local MP4, so there are zero <video> tags.
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelectorAll('video')).toHaveLength(0);
    expect(container.querySelectorAll('.feed-placeholder')).toHaveLength(5);
  });

  it('shows six NO SIGNAL placeholders (no local video) before any frame streams', () => {
    const { container } = render(<VideoGrid />);
    expect(container.querySelectorAll('video')).toHaveLength(0);
    expect(container.querySelectorAll('.feed-placeholder')).toHaveLength(6);
  });
});

// ── VideoFeed — render states ──────────────────────────────────────────────
describe('VideoFeed render states', () => {
  it('NO_SIGNAL shows the placeholder and no <img>', () => {
    const { container } = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="NO_SIGNAL" />,
    );
    expect(screen.getByText('NO SIGNAL')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('LIVE shows the frame image (with data URI prefix) and no offline class', () => {
    const { container } = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="LIVE" frame={FAKE_FRAME_B64} />,
    );
    const img = container.querySelector('img')!;
    expect(img).toBeInTheDocument();
    expect(img.getAttribute('src')).toBe(`data:image/jpeg;base64,${FAKE_FRAME_B64}`);
    expect(container.querySelector('.feed')!.classList.contains('offline')).toBe(false);
  });

  it('OFFLINE keeps the frozen frame visible and adds the .offline class', () => {
    const { container } = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="OFFLINE" frame={FAKE_FRAME_B64} />,
    );
    expect(container.querySelector('img')).toBeInTheDocument(); // frozen last frame
    expect(container.querySelector('.feed')!.classList.contains('offline')).toBe(true);
    expect(screen.queryByText('NO SIGNAL')).toBeNull();
  });

  it('OFFLINE with no frame ever received renders neither image nor placeholder', () => {
    const { container } = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="OFFLINE" />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.feed-placeholder')).toBeNull();
    expect(container.querySelector('.feed')!.classList.contains('offline')).toBe(true);
  });

  it('OFFLINE renders the SIGNAL LOST emergency warning as a real, accessible node', () => {
    // Regression: the warning used to be a CSS `::after` content string, so it
    // was absent from the DOM/accessibility tree and unassertable. It must now
    // be a real `role="alert"` element, present whether or not a frame exists.
    const withFrame = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="OFFLINE" frame={FAKE_FRAME_B64} />,
    );
    expect(withFrame.getByRole('alert')).toHaveTextContent('SIGNAL LOST');
    withFrame.unmount();

    const noFrame = render(<VideoFeed droneId="DRONE_1" zone="ALPHA" status="OFFLINE" />);
    expect(noFrame.getByText('SIGNAL LOST')).toBeInTheDocument();
  });

  it('does NOT show the SIGNAL LOST warning when LIVE or NO_SIGNAL', () => {
    const live = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="LIVE" frame={FAKE_FRAME_B64} />,
    );
    expect(live.queryByText('SIGNAL LOST')).toBeNull();
    expect(live.queryByRole('alert')).toBeNull();
    live.unmount();

    const idle = render(<VideoFeed droneId="DRONE_1" zone="ALPHA" status="NO_SIGNAL" />);
    expect(idle.queryByText('SIGNAL LOST')).toBeNull();
  });
});

// ── VideoFeed — backend-streamed only (no local MP4 playback) ──────────────
describe('VideoFeed never plays a local clip', () => {
  it('NO_SIGNAL shows the placeholder and never renders a <video>', () => {
    const { container } = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="NO_SIGNAL" />,
    );
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText('NO SIGNAL')).toBeInTheDocument();
  });

  it('LIVE renders the streamed frame as an <img>, never a <video>', () => {
    const { container } = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="LIVE" frame={FAKE_FRAME_B64} />,
    );
    expect(container.querySelector('img')).toBeInTheDocument();
    expect(container.querySelector('video')).toBeNull();
  });

  it('OFFLINE with no frame shows SIGNAL LOST over black, with no <video>', () => {
    const { container } = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="OFFLINE" />,
    );
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('.feed')!.classList.contains('offline')).toBe(true);
    expect(screen.getByRole('alert')).toHaveTextContent('SIGNAL LOST');
  });

  it('does not render the removed REPLAY tag in any state', () => {
    const { rerender } = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="NO_SIGNAL" />,
    );
    expect(screen.queryByText('REPLAY')).toBeNull();
    rerender(<VideoFeed droneId="DRONE_1" zone="ALPHA" status="LIVE" frame={FAKE_FRAME_B64} />);
    expect(screen.queryByText('REPLAY')).toBeNull();
  });
});

// ── VideoFeed — detection badge + YOLO overlay ─────────────────────────────
describe('VideoFeed detections', () => {
  it('shows the PERSON DETECTED badge only when LIVE with detections', () => {
    const dets = [makeDetection()];
    const { rerender, container } = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="LIVE" frame={FAKE_FRAME_B64} detections={dets} />,
    );
    expect(screen.getByText(/PERSON DETECTED/)).toBeInTheDocument();

    // OFFLINE must suppress the badge even if detections linger on the packet
    rerender(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="OFFLINE" frame={FAKE_FRAME_B64} detections={dets} />,
    );
    expect(screen.queryByText(/PERSON DETECTED/)).toBeNull();
    expect(container.querySelector('.feed-detect-badge')).toBeNull();
  });

  it('appends ×N to the badge for multiple detections', () => {
    render(
      <VideoFeed
        droneId="DRONE_1"
        zone="ALPHA"
        status="LIVE"
        frame={FAKE_FRAME_B64}
        detections={[makeDetection(), makeDetection(), makeDetection()]}
      />,
    );
    expect(screen.getByText(/PERSON DETECTED ×3/)).toBeInTheDocument();
  });

  it('renders the YOLO overlay registered to the frame pixel space after load', () => {
    const dets = [makeDetection({ bbox: [10, 20, 110, 220], confidence: 0.91 })];
    const { container } = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="LIVE" frame={FAKE_FRAME_B64} detections={dets} />,
    );
    // overlay is gated on frameSize, which is only known once the <img> decodes;
    // jsdom doesn't decode, so stub natural dims then fire load.
    const img = container.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 640, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 480, configurable: true });
    fireEvent.load(img);

    const svg = container.querySelector('svg.feed-yolo')!;
    expect(svg).toBeInTheDocument();
    expect(svg.getAttribute('viewBox')).toBe('0 0 640 480');
    const rect = svg.querySelector('rect.yolo-box')!;
    expect(rect.getAttribute('x')).toBe('10');
    expect(rect.getAttribute('width')).toBe('100'); // x2-x1
    expect(rect.getAttribute('height')).toBe('200'); // y2-y1
    expect(within(svg as unknown as HTMLElement).getByText('PERSON 91%')).toBeInTheDocument();
  });
});

// ── Adversarial: try to break the components ───────────────────────────────
describe('VideoFeed adversarial inputs', () => {
  it('survives an inverted bbox (x2<x1, y2<y1) by clamping w/h to 0, not negative', () => {
    const dets = [makeDetection({ bbox: [200, 200, 50, 50] })];
    const { container } = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="LIVE" frame={FAKE_FRAME_B64} detections={dets} />,
    );
    const img = container.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 640, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 480, configurable: true });
    fireEvent.load(img);
    const rect = container.querySelector('rect.yolo-box')!;
    expect(rect.getAttribute('width')).toBe('0');
    expect(rect.getAttribute('height')).toBe('0');
  });

  it('does not crash on a large detection burst', () => {
    const many = Array.from({ length: 200 }, () => makeDetection());
    render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="LIVE" frame={FAKE_FRAME_B64} detections={many} />,
    );
    expect(screen.getByText(/PERSON DETECTED ×200/)).toBeInTheDocument();
  });

  it('treats an empty-string frame as "no frame" (placeholder, not a broken <img>)', () => {
    // status is still passed by the parent; with frame='' an upstream
    // deriveFeedStatus('STRONG','') would be NO_SIGNAL. Render that combination.
    const { container } = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="NO_SIGNAL" frame="" />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('NO SIGNAL')).toBeInTheDocument();
  });
});
