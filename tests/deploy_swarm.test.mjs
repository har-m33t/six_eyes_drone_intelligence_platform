/**
 * Acceptance tests for Task 1 of `.claude/deploy-swarm-integration.md`
 * ("Frontend UI & Payload Generation") — the "DEPLOY SWARM" trigger.
 *
 * These verify the SHIPPED behavior in `six_eyes_dashboard.html`:
 *   - a visible "DEPLOY SWARM" button styled with the black/purple system,
 *   - operator draws a search-area polygon by clicking the GPS map,
 *   - clicking DEPLOY transmits the STRICT wire schema
 *         { "command": "START_MISSION", "polygon": [[x, y], ...] }
 *     over the existing WebSocket.
 *
 * Why Node's built-in runner + `vm`: the frontend is kept "strictly vanilla
 * HTML/JS" with no package.json / npm deps, so we avoid jest/jsdom. We extract
 * the dashboard's <script>, run it in a `vm` context against a minimal mock DOM,
 * and exercise the *real* wiring rather than a copy.
 *
 * Run (Node >= 18; this repo is on v24):
 *   node --test tests/deploy_swarm.test.mjs
 *
 * ---------------------------------------------------------------------------
 * Observed Task 1 contract (what these tests pin to the implementation):
 *   - <button id="deploySwarmBtn">DEPLOY SWARM</button> (+ a CLEAR button).
 *   - `missionPolygon` : top-level array of `[x, y]` SIM_WORLD vertices, filled
 *     by clicking `canvas.parentElement` (the map). >=3 vertices = a polygon.
 *   - `refreshDeployControls()` enables DEPLOY only at >=3 vertices.
 *   - `deploySwarm()` : bound to the button; sends
 *       JSON.stringify({ command: "START_MISSION", polygon: missionPolygon })
 *     ONLY when there are >=3 vertices AND `ws.readyState === WebSocket.OPEN`;
 *     otherwise it flashes a hint and sends nothing (fail-soft, no throw).
 * ---------------------------------------------------------------------------
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'six_eyes_dashboard.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

// The mock canvas/map is 300x300 and SIM_WORLD is 1000x1000, so a map click at
// pixel (px, py) maps to sim (px/300*1000, py/300*1000). Pick pixels that land
// on round sim coords for readable assertions.
const CANVAS_PX = 300;
const SIM_SPAN = 1000;
const simFromPx = (px) => Math.round((px / CANVAS_PX) * SIM_SPAN);
// Clicks at (3,3),(30,3),(30,30) -> sim (10,10),(100,10),(100,100).
const CLICK_PTS = [
  { clientX: 3, clientY: 3 },
  { clientX: 30, clientY: 3 },
  { clientX: 30, clientY: 30 },
];
const EXPECTED_POLY = CLICK_PTS.map((c) => [simFromPx(c.clientX), simFromPx(c.clientY)]);

// --------------------------------------------------------------------------- //
// Mock DOM / browser environment
// --------------------------------------------------------------------------- //

// A 2D canvas context where every method is a no-op and every property is
// settable — enough for drawMap()/paintFootprint()/drawMissionPolygon() to run.
function makeCtx() {
  return new Proxy(
    {},
    { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) }
  );
}

function makeClassList() {
  const s = new Set();
  return {
    add: (...c) => c.forEach((x) => s.add(x)),
    remove: (...c) => c.forEach((x) => s.delete(x)),
    toggle: (c, force) => {
      const want = force === undefined ? !s.has(c) : !!force;
      want ? s.add(c) : s.delete(c);
      return want;
    },
    contains: (c) => s.has(c),
  };
}

function makeElement(tagOrId, ctx, makeParent = true) {
  const handlers = {};
  const el = {
    id: tagOrId,
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: undefined,
    width: CANVAS_PX,
    height: CANVAS_PX,
    clientWidth: CANVAS_PX,
    clientHeight: CANVAS_PX,
    style: {},
    dataset: {},
    classList: makeClassList(),
    addEventListener: (ev, fn) => ((handlers[ev] ||= []).push(fn)),
    removeEventListener: () => {},
    dispatchEvent: () => {},
    // Test helper: fire registered listeners for an event (e.g. 'click').
    _fire: (ev, arg) => (handlers[ev] || []).forEach((fn) => fn(arg)),
    querySelector: () => makeElement('q', ctx, false),
    querySelectorAll: () => [],
    appendChild: () => {},
    setAttribute(k, v) {
      this[k] = v;
    },
    getAttribute(k) {
      return this[k];
    },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: CANVAS_PX, height: CANVAS_PX }),
  };
  // A real parent element so `canvas.parentElement.addEventListener(...)` and
  // `.getBoundingClientRect()` (the map-click vertex capture) work.
  el.parentElement = makeParent
    ? makeElement('parent-of-' + tagOrId, ctx, false)
    : { clientWidth: CANVAS_PX, clientHeight: CANVAS_PX };
  return el;
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = this.onclose = this.onerror = this.onmessage = null;
    MockWebSocket.last = this;
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose();
  }
}

// Captures whatever the dashboard exposes (typeof-guarded so a missing binding
// can never raise a ReferenceError inside the vm).
const EPILOGUE = `
;globalThis.__SIXEYES_TEST__ = {
  ws: (typeof ws !== 'undefined') ? ws : null,
  deploySwarm: (typeof deploySwarm === 'function') ? deploySwarm : null,
  missionPolygon: (typeof missionPolygon !== 'undefined') ? missionPolygon : null,
  mapEl: (typeof canvas !== 'undefined') ? canvas.parentElement : null,
  deployBtn: (typeof deploySwarmBtn !== 'undefined') ? deploySwarmBtn : null,
  clearBtn: (typeof clearPolygonBtn !== 'undefined') ? clearPolygonBtn : null,
};
`;

function extractScript(html) {
  const matches = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(matches.length > 0, 'dashboard HTML should contain a <script> block');
  return matches[matches.length - 1][1];
}

/** Build a fresh sandbox, run the dashboard script + epilogue, return handle. */
function loadDashboard() {
  const ctx = makeCtx();
  const registry = {};
  const document = {
    getElementById: (id) => (registry[id] ||= makeElement(id, ctx)),
    createElement: (tag) => makeElement(tag, ctx),
    addEventListener: () => {},
    querySelector: () => makeElement('q', ctx, false),
  };
  const sandbox = {
    document,
    window: { addEventListener: () => {}, document },
    WebSocket: MockWebSocket,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0, // never fire reconnect / hint-reset timers
    clearTimeout: () => {},
    requestAnimationFrame: () => 0, // never invoke callback -> no render loop
    cancelAnimationFrame: () => {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractScript(HTML) + EPILOGUE, sandbox, {
    filename: 'six_eyes_dashboard.html',
  });
  const handle = sandbox.__SIXEYES_TEST__;
  handle._registry = registry;
  return handle;
}

/** Put the mock socket into OPEN state the way the real onopen would. */
function openSocket(handle) {
  const sock = handle.ws;
  assert.ok(sock, 'dashboard should have created a WebSocket (global `ws`)');
  sock.readyState = MockWebSocket.OPEN;
  if (typeof sock.onopen === 'function') sock.onopen();
  return sock;
}

/** Simulate the operator clicking the map to drop polygon vertices. */
function drawPolygon(handle, points = CLICK_PTS) {
  assert.ok(handle.mapEl, 'expected the map (canvas.parentElement) to be wired for clicks');
  points.forEach((p) => handle.mapEl._fire('click', p));
}

// `missionPolygon` lives in the vm realm, so its Array.prototype differs from
// the test realm and deepStrictEqual would reject identical-looking arrays.
// Normalize through JSON (matches how it actually goes over the wire anyway).
const norm = (v) => JSON.parse(JSON.stringify(v));

// --------------------------------------------------------------------------- //
// Harness sanity — proves the mock environment runs the real dashboard script.
// --------------------------------------------------------------------------- //
test('harness: the dashboard script executes in the mock DOM', () => {
  const handle = loadDashboard();
  assert.ok(handle, 'epilogue should expose a test handle');
  assert.ok(handle.ws instanceof MockWebSocket, 'connect() should open a socket');
});

// --------------------------------------------------------------------------- //
// 1. UI trigger — the "DEPLOY SWARM" button
// --------------------------------------------------------------------------- //
test('UI: a visible "DEPLOY SWARM" button exists', () => {
  assert.match(
    HTML,
    /<button\b[^>]*>[\s\S]*?DEPLOY\s*SWARM[\s\S]*?<\/button>/i,
    'expected a <button> labelled "DEPLOY SWARM"'
  );
});

test('UI: the deploy button is wired via id="deploySwarmBtn"', () => {
  assert.match(HTML, /id\s*=\s*["']deploySwarmBtn["']/i);
  const handle = loadDashboard();
  assert.ok(handle.deployBtn, 'deploySwarmBtn should be resolvable via getElementById');
});

test('UI: the deploy button uses the black/purple design system, not raw defaults', () => {
  const btn = HTML.match(/<button\b[^>]*>[\s\S]*?DEPLOY\s*SWARM[\s\S]*?<\/button>/i);
  assert.ok(btn, 'deploy button must exist before its styling can be checked');
  assert.match(btn[0], /class\s*=/, 'deploy button should be styled via a CSS class, not browser defaults');
  // The .deploy-btn class should pull from the design-system tokens.
  assert.match(HTML, /\.deploy-btn[\s\S]*?(--accent|--bg-panel|--line|#a78bfa)/i);
});

// --------------------------------------------------------------------------- //
// 2. Polygon extraction — map clicks build `missionPolygon`
// --------------------------------------------------------------------------- //
test('extraction: a map click drops a [x, y] vertex in SIM_WORLD coords', () => {
  const handle = loadDashboard();
  assert.ok(handle.missionPolygon, 'expected a global missionPolygon array');
  assert.equal(handle.missionPolygon.length, 0, 'starts empty before any click');
  drawPolygon(handle, [CLICK_PTS[0]]);
  assert.deepEqual(norm(handle.missionPolygon), [EXPECTED_POLY[0]]);
});

test('extraction: vertices accumulate in click order', () => {
  const handle = loadDashboard();
  drawPolygon(handle);
  assert.deepEqual(norm(handle.missionPolygon), EXPECTED_POLY);
});

test('controls: DEPLOY is disabled below 3 vertices and enabled at 3', () => {
  const handle = loadDashboard();
  assert.ok(handle.deployBtn, 'expected deploySwarmBtn');
  drawPolygon(handle, CLICK_PTS.slice(0, 2)); // 2 vertices
  assert.equal(handle.deployBtn.disabled, true, 'still disabled with 2 vertices');
  drawPolygon(handle, CLICK_PTS.slice(2)); // 3rd vertex
  assert.equal(handle.deployBtn.disabled, false, 'enabled once a polygon (3 pts) exists');
});

test('controls: CLEAR empties the polygon', () => {
  const handle = loadDashboard();
  assert.ok(handle.clearBtn, 'expected clearPolygonBtn');
  drawPolygon(handle);
  assert.equal(handle.missionPolygon.length, 3);
  handle.clearBtn._fire('click');
  assert.equal(handle.missionPolygon.length, 0, 'CLEAR should reset the drawn polygon');
});

// --------------------------------------------------------------------------- //
// 3. Transmission — strict START_MISSION schema over the WebSocket
// --------------------------------------------------------------------------- //
test('schema: the START_MISSION command string is present in the frontend', () => {
  assert.match(HTML, /START_MISSION/, 'frontend must send the literal command "START_MISSION"');
});

test('transmit: deploySwarm() sends one strict START_MISSION frame over an open socket', () => {
  const handle = loadDashboard();
  assert.ok(handle.deploySwarm, 'expected a global deploySwarm()');
  const sock = openSocket(handle);
  drawPolygon(handle);
  handle.deploySwarm();

  assert.equal(sock.sent.length, 1, 'exactly one frame per deploy');
  const parsed = JSON.parse(sock.sent[0]);
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['command', 'polygon'],
    'payload must contain ONLY "command" and "polygon" (strict schema)'
  );
  assert.equal(parsed.command, 'START_MISSION');
  assert.deepEqual(parsed.polygon, EXPECTED_POLY);
});

test('transmit: sent polygon is an array of [number, number] pairs', () => {
  const handle = loadDashboard();
  const sock = openSocket(handle);
  drawPolygon(handle);
  handle.deploySwarm();
  const { polygon } = JSON.parse(sock.sent[0]);
  assert.ok(Array.isArray(polygon));
  for (const pt of polygon) {
    assert.ok(Array.isArray(pt) && pt.length === 2, `vertex must be a 2-pair, got ${JSON.stringify(pt)}`);
    assert.equal(typeof pt[0], 'number');
    assert.equal(typeof pt[1], 'number');
  }
});

test('transmit: clicking the wired button triggers the same send', () => {
  const handle = loadDashboard();
  const sock = openSocket(handle);
  drawPolygon(handle);
  handle.deployBtn._fire('click');
  assert.equal(sock.sent.length, 1, 'a click on DEPLOY should send one START_MISSION frame');
  assert.deepEqual(JSON.parse(sock.sent[0]), { command: 'START_MISSION', polygon: EXPECTED_POLY });
});

test('transmit: deploySwarm() does NOT send with fewer than 3 vertices', () => {
  const handle = loadDashboard();
  const sock = openSocket(handle);
  drawPolygon(handle, CLICK_PTS.slice(0, 2)); // only 2 vertices
  handle.deploySwarm();
  assert.equal(sock.sent.length, 0, 'a 2-point line is not a deployable polygon');
});

test('transmit: deploySwarm() fails soft when the socket is not open', () => {
  const handle = loadDashboard();
  drawPolygon(handle);
  handle.ws.readyState = MockWebSocket.CONNECTING;
  assert.doesNotThrow(() => handle.deploySwarm(), 'deploy on a closed socket must not throw');
  assert.equal(handle.ws.sent.length, 0, 'nothing should be transmitted on a closed socket');
});
