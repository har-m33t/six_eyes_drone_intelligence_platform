/**
 * Code-review test suite — Module D · Task D2 (`useKeyboardControls`).
 *
 * Happy path (single-press kill, repeat guard, editable/modifier suppression)
 * plus "try to break it" cases pinning the review findings
 * (see `.claude/module_d_review.md`). Bug cases are tagged `[BUG D2-n]` and
 * assert the CURRENT behaviour.
 *
 *   cd frontend && npm install && npm test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useKeyboardControls } from './useKeyboardControls';
import type { WebSocketService } from '../services/websocket';

function makeService(sendResult = true) {
  const sendCommand = vi.fn(() => sendResult);
  return { service: { sendCommand } as unknown as WebSocketService, sendCommand };
}

function keydown(key: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}
function keyup(key: string) {
  window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

// ── Happy path ────────────────────────────────────────────────────────────

describe('useKeyboardControls — kill switch', () => {
  it('K dispatches a single KILL_DRONE frame targeting DRONE_3', () => {
    const { service, sendCommand } = makeService();
    const onKill = vi.fn();
    renderHook(() => useKeyboardControls({ service, onKill }));

    keydown('k');

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith('KILL_DRONE', { drone_id: 'DRONE_3' });
    expect(onKill).toHaveBeenCalledWith('DRONE_3', true);
  });

  it('is case-insensitive (Shift+K / capital K still fires)', () => {
    const { service, sendCommand } = makeService();
    renderHook(() => useKeyboardControls({ service }));

    keydown('K', { shiftKey: true });

    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('ignores auto-repeat keydown frames (event.repeat)', () => {
    const { service, sendCommand } = makeService();
    renderHook(() => useKeyboardControls({ service }));

    keydown('k', { repeat: true });

    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('a held key (keydown burst with NO keyup) fires exactly once — latch works', () => {
    const { service, sendCommand } = makeService();
    renderHook(() => useKeyboardControls({ service }));

    keydown('k');
    keydown('k'); // browser somehow delivers a 2nd non-repeat keydown, no keyup
    keydown('k');

    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('re-arms after a clean keyup', () => {
    const { service, sendCommand } = makeService();
    renderHook(() => useKeyboardControls({ service }));

    keydown('k');
    keyup('k');
    keydown('k');

    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  it('suppresses the binding while focus is in an editable element', () => {
    const { service, sendCommand } = makeService();
    renderHook(() => useKeyboardControls({ service }));

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));

    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('ignores Ctrl/Meta/Alt combos so it never shadows OS shortcuts', () => {
    const { service, sendCommand } = makeService();
    renderHook(() => useKeyboardControls({ service }));

    keydown('k', { ctrlKey: true });
    keydown('k', { metaKey: true });
    keydown('k', { altKey: true });

    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', () => {
    const { service, sendCommand } = makeService();
    renderHook(() => useKeyboardControls({ service, enabled: false }));

    keydown('k');

    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('detaches the listener on unmount', () => {
    const { service, sendCommand } = makeService();
    const { unmount } = renderHook(() => useKeyboardControls({ service }));

    unmount();
    keydown('k');

    expect(sendCommand).not.toHaveBeenCalled();
  });
});

// ── Break attempts / bug documentation ──────────────────────────────────────

describe('useKeyboardControls — [BUG D2-1] latch cannot bound a keyup-interleaved burst', () => {
  it('keydown/keyup/keydown (the X11 auto-repeat shape) fires TWICE', () => {
    // On X11/Linux, auto-repeat emits a keyup between each repeated keydown and
    // does NOT always set event.repeat. The per-press latch is released by that
    // interleaved keyup, so the "exactly one frame per physical press" guarantee
    // the hook documents does NOT hold there — event.repeat is the only real
    // guard, and it is unreliable on those platforms.
    const { service, sendCommand } = makeService();
    renderHook(() => useKeyboardControls({ service }));

    keydown('k'); // press
    keyup('k'); // synthetic release injected by X11 auto-repeat
    keydown('k'); // auto-repeat, repeat flag NOT set

    expect(sendCommand).toHaveBeenCalledTimes(2);
  });
});

describe('useKeyboardControls — [BUG D2-2] latch wedges when killKey changes mid-press', () => {
  it('changing killKey between keydown and keyup permanently wedges the kill switch', () => {
    const { service, sendCommand } = makeService();
    const { rerender } = renderHook((props: { killKey: string }) =>
      useKeyboardControls({ service, killKey: props.killKey }), {
      initialProps: { killKey: 'k' },
    });

    keydown('k'); // fires; latch set under killKey='k'
    expect(sendCommand).toHaveBeenCalledTimes(1);

    // Rebind the kill key, THEN the operator releases the original key.
    rerender({ killKey: 'j' });
    keyup('k'); // releaseLatch compares 'k' to killKey 'j' → does NOT release

    // Rebind back and press again — latch is still stuck, so nothing fires.
    rerender({ killKey: 'k' });
    keydown('k');

    expect(sendCommand).toHaveBeenCalledTimes(1); // wedged — second press lost
  });
});
