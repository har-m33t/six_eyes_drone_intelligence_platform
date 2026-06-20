/**
 * Stress tests for the SIX-EYES dashboard coverage feature (dashboard_coverage.md).
 *
 *   Task 1 — Canvas heatmap trail   (mapToCanvasX/Y, paintFootprint, recordCoverage)
 *   Task 2 — live "% SEARCHED" stat (updateCoverageStat, coverageProgress)
 *   plus the nav/full-packet router (isNavTelemetry, handleNavTelemetry)
 *
 * The dashboard is intentionally a single vanilla-JS file with no build step, so
 * there is no module to import. Instead we read six_eyes_dashboard.html, pull the
 * <script> out, and evaluate it inside a Node `vm` context against hand-rolled
 * stubs for the browser globals it touches (document, canvas 2d ctx, WebSocket,
 * requestAnimationFrame, …). Top-level `function` declarations attach to the vm
 * global, so we can call the real dashboard functions and assert on the stubbed
 * DOM / canvas they mutate. No DOM library, no npm install — Node built-ins only.
 *
 * Run:  node --test tests/test_dashboard_coverage.mjs
 *   (or:  node --test tests/   to include any other *.mjs test files)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, '..', 'six_eyes_dashboard.html');

// Canvas pixel size the harness pins the map-wrap to. Square so that
// mapToCanvasX and mapToCanvasY share one scale and assertions stay simple.
const CANVAS_PX = 700;

// --- Browser stubs --------------------------------------------------------- //

function makeCtx() {
  // Records the calls Task 1 makes so tests can assert footprint geometry.
  const ctx = {
    arcs: [],
    fills: 0,
    clears: 0,
    _fillStyle: '',
    get fillStyle() { return this._fillStyle; },
    set fillStyle(v) { this._fillStyle = v; },
    strokeStyle: '', lineWidth: 0, shadowColor: '', shadowBlur: 0,
    font: '', textAlign: '',
    beginPath() {}, closePath() {},
    arc(x, y, r) { this.arcs.push({ x, y, r, fillStyle: null }); },
    // paintFootprint sets fillStyle AFTER arc(), so stamp the colour at fill().
    fill() { this.fills++; if (this.arcs.length) this.arcs.at(-1).fillStyle = this._fillStyle; },
    fillRect() {}, clearRect() { this.clears++; },
    moveTo() {}, lineTo() {}, stroke() {}, fillText() {},
  };
  return ctx;
}

function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : force;
      on ? set.add(c) : set.delete(c);
      return on;
    },
  };
}

function makeEl(id = '') {
  const el = {
    id,
    style: {},
    classList: makeClassList(),
    textContent: '',
    innerHTML: '',
    className: '',
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    querySelector() { return makeEl(); },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: CANVAS_PX, height: CANVAS_PX }; },
    parentElement: null,
  };
  return el;
}

function makeCanvas(id, wrap) {
  const el = makeEl(id);
  el.width = CANVAS_PX;
  el.height = CANVAS_PX;
  el.parentElement = wrap;
  const ctx = makeCtx();
  el.getContext = () => ctx;
  el._ctx = ctx; // test-only handle to the same ctx the script captures
  return el;
}

function buildSandbox() {
  const elements = {};
  // Shared map-wrap parent for both canvases; the script reads clientWidth/Height.
  const wrap = makeEl('map-wrap');
  wrap.clientWidth = CANVAS_PX;
  wrap.clientHeight = CANVAS_PX;

  const document = {
    getElementById(id) {
      if (!elements[id]) {
        elements[id] = (id === 'map-canvas' || id === 'coverage-canvas')
          ? makeCanvas(id, wrap)
          : makeEl(id);
      }
      return elements[id];
    },
    createElement() { return makeEl(); },
  };

  class FakeWebSocket {
    constructor(url) { this.url = url; }
    close() {}
    send() {}
  }

  const sandbox = {
    document,
    window: { addEventListener() {} },
    WebSocket: FakeWebSocket,
    requestAnimationFrame() { return 0; }, // no-op: don't recurse renderLoop
    setInterval() { return 0; },
    setTimeout() { return 0; },
    clearInterval() {}, clearTimeout() {},
    console, JSON, Math, Date, Object, Number, String, Array, Set,
    parseInt, parseFloat, isNaN,
    _elements: elements, // test-only escape hatch
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

function loadDashboard() {
  const html = readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> block found in dashboard HTML');
  const sandbox = buildSandbox();
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox, { filename: 'six_eyes_dashboard.inline.js' });
  return sandbox;
}

// A fresh dashboard per test so coverageProgress / footprints never bleed across.
function fresh() {
  const s = loadDashboard();
  return {
    s,
    zoneText: () => s._elements['zoneCoverage'].textContent,
    coverageArcs: () => s._elements['coverage-canvas']._ctx.arcs,
    coverageCtx: () => s._elements['coverage-canvas']._ctx,
  };
}

// =========================================================================== //
// Sanity: the harness actually evaluated the dashboard.
// =========================================================================== //
test('dashboard script loads and exposes the coverage functions', () => {
  const { s } = fresh();
  for (const fn of [
    'mapToCanvasX', 'mapToCanvasY', 'paintFootprint', 'recordCoverage',
    'redrawCoverage', 'isNavTelemetry', 'handleNavTelemetry', 'updateCoverageStat',
  ]) {
    assert.equal(typeof s[fn], 'function', `${fn} should be defined`);
  }
});

// =========================================================================== //
// TASK 1 — Canvas heatmap trail
// =========================================================================== //
test('T1: mapToCanvasX/Y scale sim coords into canvas pixels', () => {
  const { s } = fresh();
  // SIM_WORLD is 1000x1000, canvas is 700x700 → factor 0.7.
  assert.equal(s.mapToCanvasX(0), 0);
  assert.equal(s.mapToCanvasX(1000), 700);
  assert.equal(s.mapToCanvasX(500), 350);
  assert.equal(s.mapToCanvasY(250), 175);
});

test('T1: paintFootprint draws a 20px purple semi-transparent circle', () => {
  const { s, coverageArcs } = fresh();
  s.paintFootprint(500, 500);
  const arc = coverageArcs().at(-1);
  assert.equal(arc.x, 350);
  assert.equal(arc.y, 350);
  assert.equal(arc.r, 20, 'footprint radius must be ~20px per spec');
  assert.equal(arc.fillStyle, 'rgba(147, 51, 234, 0.15)', 'spec-mandated tactical purple');
});

test('T1: recordCoverage paints one footprint per valid nav tick', () => {
  const { s, coverageArcs } = fresh();
  const before = coverageArcs().length;
  s.recordCoverage(100, 200);
  s.recordCoverage(300, 400);
  assert.equal(coverageArcs().length - before, 2);
});

test('T1: recordCoverage rejects undefined/null/string coords', () => {
  const { s, coverageArcs } = fresh();
  const before = coverageArcs().length;
  s.recordCoverage(undefined, 5);
  s.recordCoverage(5, null);
  s.recordCoverage('120', '450'); // strings from a sloppy JSON producer
  assert.equal(coverageArcs().length, before, 'no footprint should be drawn for bad input');
});

// SHORTCOMING (F-T1-3): the guard is `typeof x !== 'number'`, but typeof NaN is
// 'number', so a NaN coordinate slips through and is pushed into the unbounded
// coverageFootprints array (and arc()'d at NaN, a silent canvas no-op). Pinned.
test('T1: NaN coords slip the typeof guard (documents F-T1-3)', () => {
  const { s, coverageArcs } = fresh();
  const before = coverageArcs().length;
  s.recordCoverage(NaN, NaN);
  assert.equal(coverageArcs().length - before, 1, 'NaN currently paints (a stored, wasted footprint)');
  assert.ok(Number.isNaN(coverageArcs().at(-1).x), 'arc centre is NaN');
});

test('T1: heatmap accumulates — canvas is never cleared on a normal tick', () => {
  const { s, coverageCtx } = fresh();
  const clearsAtStart = coverageCtx().clears;
  for (let i = 0; i < 50; i++) s.recordCoverage(i * 10, i * 5);
  // recordCoverage must NOT clearRect; only an explicit redraw/resize may.
  assert.equal(coverageCtx().clears, clearsAtStart, 'footprints must persist (no per-tick clear)');
  assert.ok(coverageCtx().arcs.length >= 50);
});

test('T1: redrawCoverage replays the whole accumulated heatmap after a clear', () => {
  const { s, coverageCtx } = fresh();
  for (let i = 0; i < 10; i++) s.recordCoverage(i * 100, i * 100);
  const clearsBefore = coverageCtx().clears;
  const arcsBefore = coverageCtx().arcs.length;
  s.redrawCoverage();
  assert.equal(coverageCtx().clears, clearsBefore + 1, 'redraw clears once');
  assert.equal(coverageCtx().arcs.length, arcsBefore + 10, 'redraw repaints all 10 footprints');
});

test('T1 STRESS: 10k footprints stay on-canvas for in-range sim coords', () => {
  const { s, coverageArcs } = fresh();
  for (let i = 0; i < 10000; i++) {
    const x = (i * 37) % 1000;      // walk the full [0,1000) sim range
    const y = (i * 53) % 1000;
    s.recordCoverage(x, y);
  }
  const arcs = coverageArcs();
  assert.equal(arcs.length, 10000);
  for (const a of arcs) {
    assert.ok(a.x >= 0 && a.x <= CANVAS_PX, `x ${a.x} on-canvas`);
    assert.ok(a.y >= 0 && a.y <= CANVAS_PX, `y ${a.y} on-canvas`);
  }
});

// SHORTCOMING (F-T1-1): coords outside SIM_WORLD (1000x1000) map off-canvas and
// vanish — there is no clamp and no agreed coordinate contract with the planner,
// whose demo polygons live in a 100x50 space. This test PINS that current
// behavior so a future coordinate-contract fix is a deliberate change.
test('T1: out-of-range sim coords map off-canvas (documents F-T1-1)', () => {
  const { s } = fresh();
  assert.ok(s.mapToCanvasX(5000) > CANVAS_PX, 'x past SIM_WORLD.width lands off the right edge');
  // A planner using the 100x50 demo space puts everything in the top-left ~10%.
  assert.ok(s.mapToCanvasX(100) < CANVAS_PX * 0.2, '100/1000 sim x crams into the left 20%');
});

// SHORTCOMING (F-T1-2): the heatmap canvas does NOT flip the Y axis, while the
// live GPS map (project()) does. So a footprint and the GPS dot for the same
// world point sit on opposite vertical halves. Pinned here.
test('T1: heatmap Y is not flipped vs the GPS map (documents F-T1-2)', () => {
  const { s } = fresh();
  // Sim y=0 maps to canvas y=0 (top). A flipped/consistent map would put low y
  // near the bottom (canvas height). It does not.
  assert.equal(s.mapToCanvasY(0), 0, 'low sim-y paints at the TOP, unlike the flipped GPS map');
});

// =========================================================================== //
// Nav / full-packet router
// =========================================================================== //
test('router: nav telemetry is recognised, full DronePacket is not', () => {
  const { s } = fresh();
  assert.equal(s.isNavTelemetry({ drone_id: 'drone_1', current_waypoint_idx: 3, waypoints_remaining: 7 }), true);
  assert.equal(s.isNavTelemetry({ drone_id: 'drone_1', x: 12, y: 34 }), true);
  // A full packet always carries gps → must route to handlePacket, not nav.
  const full = { drone_id: 'DRONE_1', gps: { lat: 1, lon: 2 }, health: {}, detections: [], x: 9, y: 9 };
  assert.equal(s.isNavTelemetry(full), false, 'presence of gps must veto the nav path');
});

test('router: handleNavTelemetry both paints AND advances the stat', () => {
  const { s, coverageArcs, zoneText } = fresh();
  const before = coverageArcs().length;
  s.handleNavTelemetry({ drone_id: 'drone_1', x: 500, y: 500, current_waypoint_idx: 5, waypoints_remaining: 5 });
  assert.equal(coverageArcs().length - before, 1, 'painted a footprint');
  assert.equal(zoneText(), '50% SEARCHED', 'and updated the stat');
});

// =========================================================================== //
// TASK 2 — live "% SEARCHED" global statistic
// =========================================================================== //
test('T2: total = current + remaining, single drone fraction', () => {
  const { s, zoneText } = fresh();
  s.updateCoverageStat({ drone_id: 'drone_1', current_waypoint_idx: 42, waypoints_remaining: 58 });
  assert.equal(zoneText(), '42% SEARCHED'); // 42 / (42+58)
});

test('T2: zero progress reads 0%', () => {
  const { s, zoneText } = fresh();
  s.updateCoverageStat({ drone_id: 'drone_1', current_waypoint_idx: 0, waypoints_remaining: 100 });
  assert.equal(zoneText(), '0% SEARCHED');
});

test('T2: global is the mean of per-drone completion fractions', () => {
  const { s, zoneText } = fresh();
  s.updateCoverageStat({ drone_id: 'drone_1', current_waypoint_idx: 100, waypoints_remaining: 0 });   // 100%
  s.updateCoverageStat({ drone_id: 'drone_2', current_waypoint_idx: 0, waypoints_remaining: 100 });   // 0%
  // mean(100%, 0%) = 50%
  assert.equal(zoneText(), '50% SEARCHED');
});

test('T2: drone_id is case-normalised (lowercase payload, one key per drone)', () => {
  const { s, zoneText } = fresh();
  s.updateCoverageStat({ drone_id: 'drone_1', current_waypoint_idx: 10, waypoints_remaining: 10 }); // 50%
  s.updateCoverageStat({ drone_id: 'DRONE_1', current_waypoint_idx: 30, waypoints_remaining: 10 }); // overwrite → 75%
  // Same drone, not two — so the mean is just the latest single fraction.
  assert.equal(zoneText(), '75% SEARCHED');
});

test('T2: mission_complete clamps a drone to 100% even if remaining is 0/missing', () => {
  const { s, zoneText } = fresh();
  s.updateCoverageStat({ drone_id: 'drone_1', current_waypoint_idx: 85, waypoints_remaining: 0, mission_complete: true });
  assert.equal(zoneText(), '100% SEARCHED');
});

test('T2: telemetry with no drone_id is ignored', () => {
  const { s, zoneText } = fresh();
  s.updateCoverageStat({ current_waypoint_idx: 50, waypoints_remaining: 50 });
  // updateCoverageStat returns BEFORE touching the DOM, so the lazily-created
  // zoneCoverage element is never even instantiated — proof it wrote nothing.
  assert.equal(s._elements['zoneCoverage'], undefined, 'stat element never written when drone_id missing');
});

test('T2: all-zero totals leave the stat at 0% (no divide-by-zero / NaN)', () => {
  const { s, zoneText } = fresh();
  s.updateCoverageStat({ drone_id: 'drone_1', current_waypoint_idx: 0, waypoints_remaining: 0 });
  assert.equal(zoneText(), '0% SEARCHED');
});

test('T2 STRESS: full 6-drone swarm averages correctly', () => {
  const { s, zoneText } = fresh();
  // Give each drone a known fraction; mean of 0,20,40,60,80,100 = 50.
  [0, 20, 40, 60, 80, 100].forEach((pct, i) => {
    s.updateCoverageStat({
      drone_id: `drone_${i + 1}`,
      current_waypoint_idx: pct,
      waypoints_remaining: 100 - pct,
    });
  });
  assert.equal(zoneText(), '50% SEARCHED');
});

test('T2 STRESS: thousands of progress updates stay numeric and in [0,100]', () => {
  const { s, zoneText } = fresh();
  for (let i = 0; i < 5000; i++) {
    const id = `drone_${(i % 6) + 1}`;
    const current = i % 101;
    s.updateCoverageStat({ drone_id: id, current_waypoint_idx: current, waypoints_remaining: 100 - current });
  }
  const m = zoneText().match(/^(\d+)% SEARCHED$/);
  assert.ok(m, `stat should read "N% SEARCHED", got "${zoneText()}"`);
  const pct = Number(m[1]);
  assert.ok(pct >= 0 && pct <= 100, `global pct in range, got ${pct}`);
});

// --- Known shortcomings, PINNED as current behavior ------------------------ //
// These two tests assert the CURRENT (flawed) output so the suite is green and
// the behavior is locked in. The DESIRED behavior is in the comment + the review
// doc (F-T2-1 / F-T2-2); flip the expected value when the fix lands.

test('T2: only-reported drones counted → over-reports swarm coverage (F-T2-1)', () => {
  const { s, zoneText } = fresh();
  // Only ONE of six drones has reported, at 100%. The global average is taken
  // over *tracked* drones only, so the swarm reads fully searched while five
  // drones have not started.
  s.updateCoverageStat({ drone_id: 'drone_1', current_waypoint_idx: 100, waypoints_remaining: 0 });
  assert.equal(zoneText(), '100% SEARCHED');
  // DESIRED (F-T2-1): denominator should be the whole swarm (6) → ~17% SEARCHED.
});

test('T2: global is mean-of-fractions, not waypoint-weighted (F-T2-2)', () => {
  const { s, zoneText } = fresh();
  // Lopsided routes expose the difference: drone 1 has a 2-waypoint route (0 done),
  // drone 2 a 198-waypoint route (all done).
  s.updateCoverageStat({ drone_id: 'drone_1', current_waypoint_idx: 0, waypoints_remaining: 2 });   // 0%
  s.updateCoverageStat({ drone_id: 'drone_2', current_waypoint_idx: 198, waypoints_remaining: 0 }); // 100%
  // Current: mean(0%, 100%) = 50%.
  assert.equal(zoneText(), '50% SEARCHED');
  // DESIRED (F-T2-2): waypoint-weighted = (0+198)/(2+198) = 99% SEARCHED.
});
