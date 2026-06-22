/**
 * Tests for Task C1 — DashboardShell (pure layout scaffold).
 *
 * Asserts the wireframe structure, the placeholder-until-filled behaviour, that
 * every slot renders its provided node, and the panel-header default counters.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DashboardShell from './DashboardShell';

describe('DashboardShell', () => {
  it('renders the three panel headers and the AI strip region', () => {
    const { container } = render(<DashboardShell />);
    expect(screen.getByText('LIVE FEEDS')).toBeInTheDocument();
    expect(screen.getByText('POSITION // GPS')).toBeInTheDocument();
    expect(screen.getByText('FLEET STATUS')).toBeInTheDocument();
    expect(container.querySelector('.shell-ai-strip')).toBeInTheDocument();
    // header logo
    expect(screen.getByText(/DRONE FLEET INTELLIGENCE/)).toBeInTheDocument();
  });

  it('shows a labelled placeholder for every empty body slot', () => {
    const { container } = render(<DashboardShell />);
    const placeholders = container.querySelectorAll('.shell-placeholder');
    // video feeds, map, sidebar, intel = 4 body placeholders
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
    for (const id of ['vf', 'map', 'sb', 'intel']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    // every body placeholder is gone once slots are filled
    expect(container.querySelectorAll('.shell-placeholder')).toHaveLength(0);
    expect(screen.getByText('ONLINE')).toBeInTheDocument();
    expect(screen.getByText('DEPLOY')).toBeInTheDocument();
    expect(screen.getByText('T+ 00:05:00')).toBeInTheDocument();
  });

  it('uses default counters until overridden', () => {
    render(<DashboardShell />);
    expect(screen.getByText('0/6 ONLINE')).toBeInTheDocument();
    expect(screen.getByText('COVERAGE 0%')).toBeInTheDocument();
  });

  it('overrides the panel counters when feedCount / coverage are provided', () => {
    render(<DashboardShell feedCount={<span>4/6 ONLINE</span>} coverage={<span>37% SEARCHED</span>} />);
    expect(screen.getByText('4/6 ONLINE')).toBeInTheDocument();
    expect(screen.getByText('37% SEARCHED')).toBeInTheDocument();
    expect(screen.queryByText('0/6 ONLINE')).toBeNull();
  });
});
