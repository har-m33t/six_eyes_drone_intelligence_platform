/**
 * SIX-EYES Tactical Map (Module B · Task B1 — Mapbox Core Layout)
 * ---------------------------------------------------------------
 * The hardware-accelerated geospatial plane of the dashboard. This component
 * owns the Mapbox GL JS base map — container, lifecycle, dark tactical styling,
 * navigation control — and is the single host that COMPOSES the rest of Module
 * B onto that map:
 *   - B2 (High-Frequency Marker Cache) ← `positions`        (`useDroneMarkers`)
 *   - B3 (Mapbox Draw Integration)     ↔ `onPerimeterDrawn` (`useMapboxDraw`)
 *   - B4 (Heatmap Append Pipeline)     ← `positions`        (`CoverageHeatmap`)
 *
 * It stays decoupled from the layout panels (Module C) and the store runtime
 * (Module A): everything flows through the Module B interface contract —
 * `positions` in, `onPerimeterDrawn` out — so a parent (Module D / integration)
 * supplies `useDronePositions()` and the deploy callback without this component
 * reaching across a boundary.
 *
 * Reverse-engineered from the legacy vanilla dashboard
 * (`six_eyes_dashboard.html`, "Task 1: Map Initialization & Styling"):
 *   - style   : mapbox://styles/mapbox/dark-v11
 *   - zoom    : 14
 *   - center  : RUNTIME_CONFIG.INITIAL_MAP_CENTER, else [0, 0]
 *   - controls: NavigationControl (top-right), attribution disabled
 *   - token   : window.SIX_EYES_CONFIG.MAPBOX_ACCESS_TOKEN (warn if absent)
 */

import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import './TacticalMap.css';

import type { LngLat } from '../types/telemetry';
// The store's derived view-model `{ id, lng, lat, status, hasDetection,
// coverageActive }` is the array Module B consumes from `useDronePositions()`
// (re-exported by the B2 marker module). Type-only import — no store runtime.
import { useDroneMarkers, type DronePosition } from '../map/droneMarkers';
import { useMapboxDraw, type MapboxDrawHandle } from '../map/useMapboxDraw';
import { CoverageHeatmap } from '../map/coverageHeatmap';

// ──────────────────────────────────────────────────────────────────────────
// Runtime configuration bridge
// ──────────────────────────────────────────────────────────────────────────

/**
 * Optional global config object injected by the host page, mirroring the
 * legacy `window.SIX_EYES_CONFIG`. Kept as a fallback so the migrated frontend
 * can be served by the existing `src/dashboard_server.py` without a rebuild.
 * Under Vite the canonical source is `import.meta.env.VITE_MAPBOX_ACCESS_TOKEN`.
 *
 * This component is the SOLE owner of the `Window.SIX_EYES_CONFIG` augmentation
 * (A3's `services/websocket.ts` reads it via a local cast to avoid the earlier
 * duplicate-declaration clash — see module_b_review.md §3).
 */
declare global {
  interface Window {
    SIX_EYES_CONFIG?: {
      MAPBOX_ACCESS_TOKEN?: string;
      INITIAL_MAP_CENTER?: LngLat;
      WS_URL?: string;
    };
  }
}

/** Tactical defaults — match the legacy dashboard exactly. */
const DEFAULT_STYLE = 'mapbox://styles/mapbox/dark-v11';
const DEFAULT_ZOOM = 14;
const DEFAULT_CENTER: LngLat = [0, 0];

/** Stable empty positions array so the marker/coverage effects don't re-run
 * every render when the parent omits `positions`. */
const NO_POSITIONS: readonly DronePosition[] = [];

/** True only for a finite `[lng, lat]` pair (port of legacy `validLngLatPair`). */
function isLngLatPair(value: unknown): value is LngLat {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/**
 * Resolve the Mapbox access token from the most specific source available:
 * explicit prop → Vite env → legacy injected global. Returns `''` when none is
 * configured (Mapbox renders a blank canvas + the component logs a warning,
 * matching legacy behaviour).
 */
function resolveAccessToken(explicit?: string): string {
  if (explicit) return explicit;
  const viteToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
  if (viteToken) return viteToken;
  return window.SIX_EYES_CONFIG?.MAPBOX_ACCESS_TOKEN ?? '';
}

// ──────────────────────────────────────────────────────────────────────────
// Interface contract (Module B)
// ──────────────────────────────────────────────────────────────────────────

export interface TacticalMapProps {
  /**
   * Live drone positions from the Module A store (`useDronePositions()`). Drives
   * the B2 marker cache and the B4 coverage footprint imperatively — never
   * re-rendering the map for a telemetry tick.
   */
  positions?: readonly DronePosition[];
  /**
   * Fired with the open `[lng, lat]` ring whenever the operator finishes/edits a
   * search perimeter (Task B3 → consumed by Module D's DEPLOY SWARM, Task D1),
   * and with `[]` when the polygon is cleared.
   */
  onPerimeterDrawn?: (coordinates: LngLat[]) => void;
  /**
   * Hands D1 the imperative draw handle (`startDrawing` / `clear` / `getPolygon`)
   * so the DEPLOY SWARM controls can drive drawing without owning the map.
   */
  onDrawReady?: (handle: MapboxDrawHandle) => void;
  /** Override the initial camera center (`[lng, lat]`). */
  initialCenter?: LngLat;
  /** Override the initial zoom level. */
  initialZoom?: number;
  /** Override the Mapbox access token (else env / global config). */
  accessToken?: string;
  /**
   * Notified once with the initialised `mapboxgl.Map` on its `load` event, for a
   * parent that needs raw map access. Read live (a swapped handler is honoured).
   */
  onReady?: (map: mapboxgl.Map) => void;
}

// ──────────────────────────────────────────────────────────────────────────
// Coverage footprint glue (B4) — drives the CoverageHeatmap from positions.
// Local to B1 (the map host) rather than added to B4's framework-agnostic file.
// ──────────────────────────────────────────────────────────────────────────

function useCoverageHeatmap(
  map: mapboxgl.Map | null,
  positions: readonly DronePosition[],
): void {
  const heatmapRef = useRef<CoverageHeatmap | null>(null);

  useEffect(() => {
    if (!map) return;
    const heatmap = new CoverageHeatmap(map);
    heatmap.attach();
    heatmapRef.current = heatmap;
    return () => {
      heatmap.detach();
      heatmapRef.current = null;
    };
  }, [map]);

  // Append a footprint for every actively-covering drone; break the trail
  // segment for any drone in transit (`coverageActive === false`) so we don't
  // draw a line across the gap. Depends on `map` too, so the first batch paints
  // as soon as the map readies even if `positions` has already settled.
  useEffect(() => {
    const heatmap = heatmapRef.current;
    if (!heatmap) return;
    for (const p of positions) {
      if (p.coverageActive) heatmap.append(p.lng, p.lat, p.id);
      else heatmap.breakSegment(p.id);
    }
  }, [map, positions]);
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

/**
 * Initialises the Mapbox base map into a `useRef` container and composes the
 * rest of Module B onto it. The map lives in state (not just a ref) so the
 * marker / draw / coverage hooks activate the moment it is ready; teardown via
 * `map.remove()` keeps it StrictMode-safe.
 */
export function TacticalMap({
  positions,
  onPerimeterDrawn,
  onDrawReady,
  initialCenter,
  initialZoom = DEFAULT_ZOOM,
  accessToken,
  onReady,
}: TacticalMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<mapboxgl.Map | null>(null);

  // BUG B1-3 fix: read `onReady` through a ref so a parent that swaps the
  // handler after first render is still honoured, even though the init effect
  // (correctly) runs once and must not recreate the map.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    if (!containerRef.current) return;

    const token = resolveAccessToken(accessToken);
    if (!token) {
      console.warn(
        'MAPBOX_ACCESS_TOKEN is not configured. Set VITE_MAPBOX_ACCESS_TOKEN ' +
          '(or window.SIX_EYES_CONFIG.MAPBOX_ACCESS_TOKEN) — the map will render blank.',
      );
    }
    mapboxgl.accessToken = token;

    const center: LngLat = isLngLatPair(initialCenter)
      ? initialCenter
      : isLngLatPair(window.SIX_EYES_CONFIG?.INITIAL_MAP_CENTER)
        ? (window.SIX_EYES_CONFIG!.INITIAL_MAP_CENTER as LngLat)
        : DEFAULT_CENTER;

    const m = new mapboxgl.Map({
      container: containerRef.current,
      style: DEFAULT_STYLE,
      center,
      zoom: initialZoom,
      attributionControl: false,
    });
    m.addControl(new mapboxgl.NavigationControl({ visualizePitch: false }), 'top-right');
    m.on('load', () => onReadyRef.current?.(m));

    setMap(m);

    return () => {
      m.remove();
      setMap(null);
    };
    // Init args are read once; re-running would destroy/recreate the map. The
    // dynamic data path (positions / onReady) is handled via state + refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const livePositions = positions ?? NO_POSITIONS;

  // B2 — live drone markers (imperative ref-cache; zero re-renders at 20 Hz).
  useDroneMarkers(map, livePositions);

  // B3 — polygon draw; surface the imperative handle to D1's DEPLOY controls.
  const draw = useMapboxDraw({ map, onPerimeterDrawn });
  useEffect(() => {
    onDrawReady?.(draw);
  }, [draw, onDrawReady]);

  // B4 — accumulating purple search footprint.
  useCoverageHeatmap(map, livePositions);

  return <div ref={containerRef} className="tactical-map" data-testid="tactical-map" />;
}

export default TacticalMap;
