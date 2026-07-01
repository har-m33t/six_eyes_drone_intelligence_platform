/**
 * Tests for the live battery bar on a VideoFeed tile.
 *
 * The requirement: a battery gauge under each drone that (a) only appears once
 * the feed is connected/streaming (status LIVE), (b) tracks `health.battery`,
 * and (c) colour-codes by severity (accent → amber → red). NO_SIGNAL and
 * SIGNAL-LOST tiles must NOT show it, so it materialises on connection and is
 * torn down again on a drop.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VideoFeed, batteryColor } from './VideoFeed';

describe('VideoFeed — live battery bar', () => {
  it('shows the battery meter once the feed is LIVE (connected)', () => {
    render(<VideoFeed droneId="DRONE_1" zone="ALPHA" status="LIVE" frame="x" battery={72} />);
    const meter = screen.getByRole('meter', { name: /battery/i });
    expect(meter).toBeInTheDocument();
    expect(meter).toHaveAttribute('aria-valuenow', '72');
    expect(screen.getByText('72%')).toBeInTheDocument();
  });

  it('hides the meter before connection (NO_SIGNAL placeholder)', () => {
    render(<VideoFeed droneId="DRONE_1" zone="ALPHA" status="NO_SIGNAL" battery={80} />);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('hides the meter when the drone drops offline (SIGNAL LOST)', () => {
    render(<VideoFeed droneId="DRONE_1" zone="ALPHA" status="OFFLINE" frame="x" battery={80} />);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('hides the meter when no battery telemetry is present', () => {
    render(<VideoFeed droneId="DRONE_1" zone="ALPHA" status="LIVE" frame="x" />);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('clamps out-of-range battery values into [0, 100]', () => {
    const { rerender } = render(
      <VideoFeed droneId="DRONE_1" zone="ALPHA" status="LIVE" frame="x" battery={140} />,
    );
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
    rerender(<VideoFeed droneId="DRONE_1" zone="ALPHA" status="LIVE" frame="x" battery={-5} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
  });

  it('colour-codes by severity: accent (healthy) → amber (warning) → red (critical)', () => {
    expect(batteryColor(80)).toContain('--accent');
    expect(batteryColor(30)).toContain('--amber');
    expect(batteryColor(10)).toContain('--red');
    expect(batteryColor(5)).toContain('--red');
  });
});
