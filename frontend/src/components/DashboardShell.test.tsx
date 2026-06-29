/**
 * Tests for Task C1 — DashboardShell (layout scaffold + main-view tabs).
 *
 * Asserts the wireframe structure, the placeholder-until-filled behaviour, that
 * every slot renders its provided node, the panel-header default counters, AND
 * the VIDEO FOOTAGE / LIVE MAP tab switching (which view is shown, which counter
 * the header tracks, and that neither view unmounts on a switch).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DashboardShell from './DashboardShell';

describe('DashboardShell', () => {
  it('renders the two main-view tabs, the fleet header and the AI strip', () => {
    const { container } = render(<DashboardShell />);
    expect(screen.getByRole('tab', { name: 'VIDEO FOOTAGE' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'LIVE MAP' })).toBeInTheDocument();
    expect(screen.getByText('FLEET STATUS')).toBeInTheDocument();
    expect(container.querySelector('.shell-ai-strip')).toBeInTheDocument();
    // header logo
    expect(screen.getByText(/DRONE FLEET INTELLIGENCE/)).toBeInTheDocument();
  });

  it('shows a labelled placeholder for every empty body slot', () => {
    const { container } = render(<DashboardShell />);
    const placeholders = container.querySelectorAll('.shell-placeholder');
    // video feeds, map, sidebar, intel = 4 body placeholders (the map one is in
    // the hidden tab but still mounted in the DOM).
    expect(placeholders).toHaveLength(4);
    expect(screen.getByText('Video Feeds')).toBeInTheDocument();
    expect(screen.getByText('Map Frame')).toBeInTheDocument();
    expect(screen.getByText('Fleet Status')).toBeInTheDocument();
    expect(screen.getByText('AI Intel Log')).toBeInTheDocument();
  });

  it('renders each provided slot in place of its placeholder', () => {
    const { container } = render(
      <DashboardShell
        videoFeeds={<div data-testid="vf">VF</div>}
        map={<div data-testid="map">MAP</div>}
        sidebar={<div data-testid="sb">SB</div>}
        intel={<div data-testid="intel">INTEL</div>}
        connectionStatus={<span>ONLINE</span>}
        deployControls={<button>DEPLOY</button>}
        missionClock={<span>T+ 00:05:00</span>}
      />,
    );
    // Both views stay mounted (the map tab is hidden, not unmounted), so all four
    // slot nodes are in the document.
    for (const id of ['vf', 'map', 'sb', 'intel']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    // every body placeholder is gone once slots are filled
    expect(container.querySelectorAll('.shell-placeholder')).toHaveLength(0);
    expect(screen.getByText('ONLINE')).toBeInTheDocument();
    expect(screen.getByText('DEPLOY')).toBeInTheDocument();
    expect(screen.getByText('T+ 00:05:00')).toBeInTheDocument();
  });

  it('defaults to the VIDEO FOOTAGE tab (video shown, map hidden)', () => {
    render(
      <DashboardShell
        videoFeeds={<div data-testid="vf">VF</div>}
        map={<div data-testid="map">MAP</div>}
      />,
    );
    expect(screen.getByRole('tab', { name: 'VIDEO FOOTAGE' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'LIVE MAP' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    // The map view carries the `hidden` attribute; the video view does not.
    expect(screen.getByTestId('map').closest('[role="tabpanel"]')).toHaveAttribute('hidden');
    expect(screen.getByTestId('vf').closest('[role="tabpanel"]')).not.toHaveAttribute('hidden');
  });

  it('switches to the LIVE MAP tab on click without unmounting the video view', () => {
    render(
      <DashboardShell
        videoFeeds={<div data-testid="vf">VF</div>}
        map={<div data-testid="map">MAP</div>}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'LIVE MAP' }));

    expect(screen.getByRole('tab', { name: 'LIVE MAP' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Map now shown, video hidden — but BOTH remain in the DOM (state preserved).
    expect(screen.getByTestId('map').closest('[role="tabpanel"]')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('vf').closest('[role="tabpanel"]')).toHaveAttribute('hidden');
    expect(screen.getByTestId('vf')).toBeInTheDocument();
  });

  it('the header counter tracks the active view (feeds → coverage)', () => {
    render(<DashboardShell feedCount={<span>4/6 ONLINE</span>} coverage={<span>37% SEARCHED</span>} />);
    // Video tab active → feed count shown, coverage not.
    expect(screen.getByText('4/6 ONLINE')).toBeInTheDocument();
    expect(screen.queryByText('37% SEARCHED')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'LIVE MAP' }));
    // Map tab active → coverage shown, feed count not.
    expect(screen.getByText('37% SEARCHED')).toBeInTheDocument();
    expect(screen.queryByText('4/6 ONLINE')).toBeNull();
  });

  it('uses default counters until overridden', () => {
    render(<DashboardShell />);
    // Default active tab (video) shows the default feed counter.
    expect(screen.getByText('0/6 ONLINE')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'LIVE MAP' }));
    expect(screen.getByText('COVERAGE 0%')).toBeInTheDocument();
  });
});
