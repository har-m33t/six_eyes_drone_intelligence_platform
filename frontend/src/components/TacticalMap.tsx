/**
 * SIX-EYES Tactical Map (Module B · Task B1 — Mapbox Core Layout)
 * ---------------------------------------------------------------
 * The hardware-accelerated geospatial plane of the dashboard. This component
 * owns *only* the Mapbox GL JS base map: container, lifecycle, dark tactical
 * styling, and navigation control. It is deliberately isolated from layout
 * panels (Module C) and the data store (Module A) — it speaks purely through
 * the Module B interface contract so the four B-tasks can land independently.
 *
 * Reverse-engineered from the legacy vanilla dashboard
 * (`six_eyes_dashboard.html`, "Task 1: Map Initialization & Styling"):
 *   - style   : mapbox://styles/mapbox/dark-v11
 *   - zoom    : 14
 *   - center  : RUNTIME_CONFIG.INITIAL_MAP_CENTER, else [0, 0]
 *   - controls: NavigationControl (top-right), attribution disabled
 *   - token   : window.SIX_EYES_CONFIG.MAPBOX_ACCESS_TOKEN (warn if absent)
 *
 * SCOPE — this file is Task B1 ONLY. The remaining B-tasks plug into the
 * `mapRef` / `onReady` seam exposed here without touching init:
 *   - B2 (High-Frequency Marker Cache) consumes `positions`.
 *   - B3 (Mapbox Draw Integration)     wires `onPerimeterDrawn`.
 *   - B4 (Heatmap Append Pipeline)     adds the coverage GeoJSON source/layer.
 * Those props are declared on the contract below but intentionally not yet
 * read here — see the `frontend-migration.md` changelog for the handoff notes.
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import './TacticalMap.css';

import type { DroneId, DroneStatus, LngLat, SignalState } from '../types/telemetry';

// ──────────────────────────────────────────────────────────────────────────
// Runtime configuration bridge
// ──────────────────────────────────────────────────────────────────────────

/**
 * Optional global config object injected by the host page, mirroring the
 * legacy `window.SIX_EYES_CONFIG`. Kept as a fallback so the migrated frontend
 * can be served by the existing `src/dashboard_server.py` without a rebuild.
 * Under Vite the canonical source is `import.meta.env.VITE_MAPBOX_ACCESS_TOKEN`.
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
  const viteToken = (import.meta as ImportMeta & { env?: Record<string, string | undefined> })
    .env?.VITE_MAPBOX_ACCESS_TOKEN;
  if (viteToken) return viteToken;
  return window.SIX_EYES_CONFIG?.MAPBOX_ACCESS_TOKEN ?? '';
}

// ──────────────────────────────────────────────────────────────────────────
// Interface contract (Module B)
// ──────────────────────────────────────────────────────────────────────────

/**
 * A single live drone position for the marker cache (consumed by Task B2).
 * Declared now so the contract is stable for parallel work.
 */
export interface DronePosition {
  drone_id: DroneId;
  /** `[lng, lat]`, GeoJSON order. */
  position: LngLat;
  status?: DroneStatus;
  signal?: SignalState;
}

export interface TacticalMapProps {
  /** Live drone positions from the Module A store (Task B2). */
  positions?: DronePosition[];
  /**
   * Fired when the operator finishes drawing a search perimeter with Mapbox
   * Draw (Task B3 → consumed by Module D's DEPLOY SWARM, Task D1).
   */
  onPerimeterDrawn?: (coordinates: LngLat[]) => void;
  /** Override the initial camera center (`[lng, lat]`). */
  initialCenter?: LngLat;
  /** Override the initial zoom level. */
  initialZoom?: number;
  /** Override the Mapbox access token (else env / global config). */
  accessToken?: string;
  /**
   * Escape hatch handing the initialised `mapboxgl.Map` to later B-tasks so
   * they can attach markers / draw / sources without re-initialising the map.
   */
  onReady?: (map: mapboxgl.Map) => void;
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

/**
 * Initialises the Mapbox base map into a `useRef` container exactly once and
 * tears it down on unmount. Idempotent under React 18 StrictMode's double-mount
 * via the `mapRef` guard + `map.remove()` cleanup.
 */
export function TacticalMap({
  initialCenter,
  initialZoom = DEFAULT_ZOOM,
  accessToken,
  onReady,
}: TacticalMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  useEffect(() => {
    // Guard against StrictMode double-invocation and missing container.
    if (mapRef.current || !containerRef.current) return;

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

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: DEFAULT_STYLE,
      center,
      zoom: initialZoom,
      attributionControl: false,
    });
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: false }), 'top-right');

    mapRef.current = map;
    map.on('load', () => onReady?.(map));

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Init args are read once; re-running would destroy/recreate the map. The
    // dynamic data path (positions) is handled imperatively in Task B2.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="tactical-map" data-testid="tactical-map" />;
}

export default TacticalMap;
