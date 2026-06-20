/**
 * Acceptance tests for Task 2 of `.claude/map-box-integration.md`
 * ("Polygon Drawing Tool — Mapbox Draw") — the "DEPLOY SWARM" trigger.
 *
 * These verify the SHIPPED behavior in `six_eyes_dashboard.html`:
 *   - a visible "DEPLOY SWARM" button styled with the black/purple system,
 *   - the operator draws a search-area polygon with the Mapbox GL Draw control
 *     (draw_polygon only) instead of the old canvas clicks,
 *   - clicking DEPLOY extracts the drawn polygon's GeoJSON ring and transmits the
 *     STRICT wire schema
 *         { "command": "START_MISSION", "polygon": [[lng, lat], ...] }
 *     over the existing WebSocket.
 *
 * Why Node's built-in runner + `vm`: the frontend is kept "strictly vanilla
 * HTML/JS" with no package.json / npm deps, so we avoid jest/jsdom. We extract
 * the dashboard's <script>, run it in a `vm` context against a minimal mock DOM
 * + mocked `mapboxgl` / `MapboxDraw` (the CDN libs aren't loaded in tests), and
 * exercise the *real* wiring rather than a copy.
 *
 * Run (Node >= 18; this repo is on v24):
 *   node --test tests/deploy_swarm.test.mjs
 *
 * ---------------------------------------------------------------------------
 * Observed Task 2 contract (what these tests pin to the implementation):
 *   - <button id="deploySwarmBtn">DEPLOY SWARM</button> (+ a CLEAR button).
 *   - `draw` : a MapboxDraw instance added to the map, restricted to polygon
 *     and trash controls.
 *   - `getMissionPolygon()` : returns the drawn polygon's outer ring as
 *     `[lng, lat]` vertices with the GeoJSON closing vertex dropped.
 *   - `refreshDeployControls()` (fired on draw.create/update/delete) enables
 *     DEPLOY only at >=3 vertices.
 *   - `deploySwarm()` : bound to the button; sends
 *       JSON.stringify({ command: "START_MISSION", polygon: [[lng,lat],...] })
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

// A search-area polygon in geographic [lng, lat] near the map's default center
// (Irvine, CA). Three distinct vertices = a deployable polygon.
const POLY_LNGLAT = [
  [-117.83, 33.67],
  [-117.81, 33.67],
  [-117.81, 33.69],
];

// --------------------------------------------------------------------------- //
// Mock DOM / browser environment
// --------------------------------------------------------------------------- //

// A 2D canvas context where every method is a no-op and every property is
// settable — enough for drawMap()/paintFootprint() to run.
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

const CANVAS_PX = 300;

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
    style: { setProperty() {} },
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

// --- Mapbox GL JS mock (Task 1 surface the dashboard boots against) --------- //
// The dashboard creates a `map`, adds controls, and registers draw.* handlers.
// We capture the handlers so tests can fire 'draw.create' etc.
class MockMap {
  constructor(opts) {
    this.opts = opts;
    this._handlers = {};
    this._sources = {}; // id -> { setData() } (Task 4 coverage source)
    this._layers = [];
  }
  addControl() {
    return this;
  }
  on(ev, fn) {
    (this._handlers[ev] ||= []).push(fn);
    return this;
  }
  // Task 4 GeoJSON source/layer API the coverage trail uses.
  isStyleLoaded() {
    return true; // style is "ready" so initCoverageLayer() runs at load
  }
  getSource(id) {
    return this._sources[id];
  }
  addSource(id, opts) {
    this._sources[id] = { _data: opts && opts.data, setData(d) { this._data = d; } };
    return this;
  }
  addLayer(opts) {
    this._layers.push(opts);
    return this;
  }
  // Test helper: fire a registered map event (e.g. 'draw.create').
  _fire(ev, arg) {
    (this._handlers[ev] || []).forEach((fn) => fn(arg));
  }
}
const mapboxglMock = {
  accessToken: '',
  Map: MockMap,
  NavigationControl: class {
    constructor(o) {
      this.o = o;
    }
  },
  Marker: class {
    constructor(o) {
      this.o = o;
    }
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
  },
};

// --- Mapbox GL Draw mock (Task 2) ------------------------------------------- //
// Stands in for @mapbox/mapbox-gl-draw. Holds a GeoJSON FeatureCollection that
// the dashboard reads via getAll(); a test helper seeds a drawn polygon.
class MockMapboxDraw {
  constructor(opts) {
    this.opts = opts;
    this._features = [];
    this.modeChanges = [];
  }
  getAll() {
    return { type: 'FeatureCollection', features: this._features };
  }
  deleteAll() {
    this._features = [];
    return this;
  }
  changeMode(mode) {
    this.modeChanges.push(mode);
    return this;
  }
  // Test helper: stage a drawn polygon from [[lng,lat], ...], auto-closing the
  // ring the way Mapbox Draw does (last vertex repeats the first).
  _setPolygon(coords) {
    const ring = coords.map((c) => c.slice());
    if (ring.length) ring.push(ring[0].slice());
    this._features = [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } },
    ];
  }
}

// Captures whatever the dashboard exposes (typeof-guarded so a missing binding
// can never raise a ReferenceError inside the vm).
const EPILOGUE = `
;globalThis.__SIXEYES_TEST__ = {
  ws: (typeof ws !== 'undefined') ? ws : null,
  deploySwarm: (typeof deploySwarm === 'function') ? deploySwarm : null,
  getMissionPolygon: (typeof getMissionPolygon === 'function') ? getMissionPolygon : null,
  draw: (typeof draw !== 'undefined') ? draw : null,
  map: (typeof map !== 'undefined') ? map : null,
  drawBtn: (typeof drawPolygonBtn !== 'undefined') ? drawPolygonBtn : null,
  deployBtn: (typeof deploySwarmBtn !== 'undefined') ? deploySwarmBtn : null,
  clearBtn: (typeof clearPolygonBtn !== 'undefined') ? clearPolygonBtn : null,
};
`;

function extractScript(html) {
  const matches = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(matches.length > 0, 'dashboard HTML should contain a <script> block');
  // The CDN <script src=...> tags have empty bodies; take the last NON-EMPTY
  // block, which is the dashboard's inline logic.
  const nonEmpty = matches.filter((m) => m[1].trim().length > 0);
  assert.ok(nonEmpty.length > 0, 'dashboard HTML should contain an inline <script>');
  return nonEmpty[nonEmpty.length - 1][1];
}

/** Build a fresh sandbox, run the dashboard script + epilogue, return handle. */
function loadDashboard({ withMapboxDraw = true } = {}) {
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
    window: {
      addEventListener: () => {},
      document,
      SIX_EYES_CONFIG: {
        MAPBOX_ACCESS_TOKEN: 'test-mapbox-token',
        WS_URL: 'ws://localhost:8765',
        INITIAL_MAP_CENTER: [-118.2437, 34.0522],
      },
    },
    WebSocket: MockWebSocket,
    mapboxgl: mapboxglMock,
    MapboxDraw: withMapboxDraw ? MockMapboxDraw : undefined,
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

/**
 * Simulate the operator drawing a polygon with the Mapbox Draw control: stage
 * the geometry on the draw instance, then fire the 'draw.create' map event the
 * dashboard listens on (which refreshes the deploy controls).
 */
function drawPolygon(handle, coords = POLY_LNGLAT) {
  assert.ok(handle.draw, 'expected a MapboxDraw instance (global `draw`)');
  assert.ok(handle.map, 'expected the Mapbox map (global `map`)');
  handle.draw._setPolygon(coords);
  handle.map._fire('draw.create');
}

function fallbackClickPolygon(handle, coords = POLY_LNGLAT) {
  assert.ok(handle.map, 'expected the Mapbox map (global `map`)');
  handle.drawBtn._fire('click');
  coords.forEach(([lng, lat]) => handle.map._fire('click', { lngLat: { lng, lat } }));
}

// Values cross the vm realm boundary, so Array.prototype differs and
// deepStrictEqual would reject identical-looking arrays. Normalize through JSON
// (matches how it actually goes over the wire anyway).
const norm = (v) => JSON.parse(JSON.stringify(v));

// --------------------------------------------------------------------------- //
// Harness sanity — proves the mock environment runs the real dashboard script.
// --------------------------------------------------------------------------- //
test('harness: the dashboard script executes in the mock DOM', () => {
  const handle = loadDashboard();
  assert.ok(handle, 'epilogue should expose a test handle');
  assert.ok(handle.ws instanceof MockWebSocket, 'connect() should open a socket');
  assert.ok(handle.draw instanceof MockMapboxDraw, 'a MapboxDraw control should be created');
});

test('config: the Mapbox map starts from runtime drone base center, not Irvine', () => {
  const handle = loadDashboard();
  assert.deepEqual(norm(handle.map.opts.center), [-118.2437, 34.0522]);
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

test('UI: a visible DRAW AREA button starts polygon drawing mode', () => {
  assert.match(HTML, /id\s*=\s*["']drawPolygonBtn["']/i);
  const handle = loadDashboard();
  assert.ok(handle.drawBtn, 'drawPolygonBtn should be resolvable via getElementById');
  handle.drawBtn._fire('click');
  assert.deepEqual(handle.draw.modeChanges, ['draw_polygon']);
});

test('UI: the deploy button uses the black/purple design system, not raw defaults', () => {
  const btn = HTML.match(/<button\b[^>]*>[\s\S]*?DEPLOY\s*SWARM[\s\S]*?<\/button>/i);
  assert.ok(btn, 'deploy button must exist before its styling can be checked');
  assert.match(btn[0], /class\s*=/, 'deploy button should be styled via a CSS class, not browser defaults');
  // The .deploy-btn class should pull from the design-system tokens.
  assert.match(HTML, /\.deploy-btn[\s\S]*?(--accent|--bg-panel|--line|#a78bfa)/i);
});

// --------------------------------------------------------------------------- //
// 2. Polygon extraction — Mapbox Draw geometry -> [lng, lat] ring
// --------------------------------------------------------------------------- //
test('config: the Mapbox Draw control is restricted to polygon and trash only', () => {
  const handle = loadDashboard();
  assert.ok(handle.draw, 'expected a MapboxDraw instance');
  const opts = norm(handle.draw.opts) || {};
  assert.equal(opts.displayControlsDefault, false, 'must not show the default control set');
  assert.ok(opts.controls && opts.controls.polygon === true, 'polygon control must be enabled');
  assert.ok(opts.controls && opts.controls.trash === true, 'trash control must be enabled');
  // No line/point tools or advanced feature-combine controls.
  for (const k of ['line_string', 'point', 'combine_features', 'uncombine_features']) {
    assert.notEqual(opts.controls[k], true, `control "${k}" must not be enabled`);
  }
});

test('extraction: getMissionPolygon() returns the drawn ring as [lng, lat], unclosed', () => {
  const handle = loadDashboard();
  assert.ok(handle.getMissionPolygon, 'expected a global getMissionPolygon()');
  assert.deepEqual(norm(handle.getMissionPolygon()), [], 'empty before anything is drawn');
  drawPolygon(handle);
  // The GeoJSON closing vertex (== first) must be dropped: 3 in -> 3 out.
  assert.deepEqual(norm(handle.getMissionPolygon()), POLY_LNGLAT);
});

test('fallback: DRAW AREA still captures a deployable polygon if MapboxDraw is unavailable', () => {
  const handle = loadDashboard({ withMapboxDraw: false });
  const sock = openSocket(handle);

  assert.equal(handle.draw, null, 'MapboxDraw should be absent in this fixture');
  fallbackClickPolygon(handle);

  assert.deepEqual(norm(handle.getMissionPolygon()), POLY_LNGLAT);
  assert.equal(handle.deployBtn.disabled, false, 'fallback polygon enables DEPLOY');
  handle.deploySwarm();
  assert.deepEqual(JSON.parse(sock.sent[0]), { command: 'START_MISSION', polygon: POLY_LNGLAT });
});

test('controls: DEPLOY is disabled below 3 vertices and enabled at 3', () => {
  const handle = loadDashboard();
  assert.ok(handle.deployBtn, 'expected deploySwarmBtn');
  drawPolygon(handle, POLY_LNGLAT.slice(0, 2)); // 2 vertices
  assert.equal(handle.deployBtn.disabled, true, 'still disabled with 2 vertices');
  drawPolygon(handle, POLY_LNGLAT); // 3 vertices
  assert.equal(handle.deployBtn.disabled, false, 'enabled once a polygon (3 pts) exists');
});

test('controls: CLEAR empties the drawn polygon', () => {
  const handle = loadDashboard();
  assert.ok(handle.clearBtn, 'expected clearPolygonBtn');
  drawPolygon(handle);
  assert.equal(handle.getMissionPolygon().length, 3);
  handle.clearBtn._fire('click');
  assert.equal(handle.getMissionPolygon().length, 0, 'CLEAR should reset the drawn polygon');
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
  assert.deepEqual(parsed.polygon, POLY_LNGLAT);
});

test('transmit: sent polygon is an array of [lng, lat] number pairs', () => {
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
  assert.deepEqual(JSON.parse(sock.sent[0]), { command: 'START_MISSION', polygon: POLY_LNGLAT });
});

test('transmit: deploySwarm() does NOT send with fewer than 3 vertices', () => {
  const handle = loadDashboard();
  const sock = openSocket(handle);
  drawPolygon(handle, POLY_LNGLAT.slice(0, 2)); // only 2 vertices
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
