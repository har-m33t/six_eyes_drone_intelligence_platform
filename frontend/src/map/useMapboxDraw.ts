/**
 * Mapbox Draw integration (Module B · Task B3)
 * --------------------------------------------
 * Mounts a `@mapbox/mapbox-gl-draw` instance directly onto a Mapbox GL map and
 * configures it EXCLUSIVELY for polygon drawing (the only geometry the SIX-EYES
 * search-area workflow uses). Reverse-engineered from the legacy vanilla
 * dashboard (`six_eyes_dashboard.html` §"Deploy Swarm: polygon drawing"), which
 * created the control with `displayControlsDefault: false` and
 * `controls: { polygon: true, trash: true }`.
 *
 * Decoupling: Task B1 (`TacticalMap.tsx`) owns the `mapboxgl.Map` instance; this
 * hook is the seam B1 composes. It takes the live map (or `null` until ready)
 * plus the Module-B interface-contract callback `onPerimeterDrawn(coordinates)`
 * and returns a stable imperative handle so the layout/controls (Task D1's
 * DEPLOY SWARM button) can drive drawing without reaching into Mapbox internals.
 *
 * This file owns ONLY the draw control + polygon extraction. It does NOT touch
 * the WebSocket (that is Task D1 wiring `onPerimeterDrawn` →
 * `webSocketService.sendCommand('START_MISSION', …)`).
 */

import { useEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
// Side-effect stylesheet for the draw toolbar (polygon/trash buttons + vertex
// handles). The legacy dashboard loaded this via a `<link>`; under Vite it must
// be imported here or the controls mount invisible/unstyled.
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import type { LngLat } from '../types/telemetry';

// ──────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit tests — no Mapbox runtime needed)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Pull the drawn polygon's outer ring as OPEN `[lng, lat]` vertices, matching
 * the legacy `getMissionPolygon()`. GeoJSON polygon rings are CLOSED (the last
 * vertex repeats the first); we drop that duplicate so consumers receive N
 * distinct vertices, exactly what the START_MISSION schema expects. Returns
 * `[]` when the feature collection has no usable polygon.
 */
export function extractPolygonRing(
  collection: GeoJSON.FeatureCollection,
): LngLat[] {
  const poly = collection.features.find(
    (f) => f.geometry && f.geometry.type === 'Polygon',
  );
  if (!poly || poly.geometry.type !== 'Polygon') return [];

  const ring = (poly.geometry.coordinates[0] ?? []) as LngLat[];
  const closed =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const open = closed ? ring.slice(0, -1) : ring;
  return open.map(([lng, lat]) => [lng, lat] as LngLat);
}

/**
 * Mapbox Draw construction options locked to polygon-only operation. `trash` is
 * the polygon's own delete affordance (not a separate geometry tool), so the
 * operator can remove a mis-drawn area — line/point tools stay hidden.
 */
export const POLYGON_ONLY_DRAW_OPTIONS: MapboxDraw.MapboxDrawOptions = {
  displayControlsDefault: false,
  controls: { polygon: true, trash: true },
  // Idle until `startDrawing()` (or autoStart) flips us into draw_polygon.
  defaultMode: 'simple_select',
};

// ──────────────────────────────────────────────────────────────────────────
// Hook
// ──────────────────────────────────────────────────────────────────────────

export interface UseMapboxDrawOptions {
  /** Live map from Task B1; `null` until the map has initialised. */
  map: MapboxMap | null;
  /**
   * Module-B interface-contract callback. Fires with the open `[lng, lat]` ring
   * whenever the operator finishes or edits a polygon (≥ 3 vertices), and with
   * `[]` when the polygon is deleted/cleared.
   */
  onPerimeterDrawn?: (coordinates: LngLat[]) => void;
  /** Enter `draw_polygon` mode immediately on mount. Default `false`. */
  autoStart?: boolean;
  /** Toolbar placement on the map canvas. Default `'top-left'` (legacy). */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

/** Imperative handle returned to the host component (B1) and controls (D1). */
export interface MapboxDrawHandle {
  /** Clear any prior polygon and enter `draw_polygon` mode. */
  startDrawing: () => void;
  /** Remove the drawn polygon (mirrors the toolbar trash / legacy CLEAR). */
  clear: () => void;
  /** Current polygon as open `[lng, lat]` vertices (`[]` when none/invalid). */
  getPolygon: () => LngLat[];
  /** Underlying draw instance, for advanced callers. `null` until mounted. */
  instance: MapboxDraw | null;
}

/**
 * Mount a polygon-only Mapbox Draw control on `map` and surface an imperative
 * handle. Re-mounts if the map identity changes; tears the control down on
 * unmount (StrictMode-safe).
 */
export function useMapboxDraw({
  map,
  onPerimeterDrawn,
  autoStart = false,
  position = 'top-left',
}: UseMapboxDrawOptions): MapboxDrawHandle {
  const drawRef = useRef<MapboxDraw | null>(null);

  // Keep the latest callback without re-subscribing the draw.* listeners. The
  // write lives in an effect (not the render body) so a discarded concurrent
  // render can't leave the ref pointing at a stale callback.
  const onPerimeterDrawnRef = useRef(onPerimeterDrawn);
  useEffect(() => {
    onPerimeterDrawnRef.current = onPerimeterDrawn;
  });

  // Stable handle — identity never changes, so consumers can pass it freely.
  const handle = useMemo<MapboxDrawHandle>(
    () => ({
      get instance() {
        return drawRef.current;
      },
      getPolygon() {
        const draw = drawRef.current;
        if (!draw) return [];
        return extractPolygonRing(draw.getAll() as GeoJSON.FeatureCollection);
      },
      startDrawing() {
        const draw = drawRef.current;
        if (!draw) return;
        // deleteAll() is silent (no draw.delete event — see mapbox-gl-draw
        // api.js), so notify consumers the old perimeter is gone, matching
        // clear(), before entering draw mode for the replacement polygon.
        draw.deleteAll();
        onPerimeterDrawnRef.current?.([]);
        draw.changeMode('draw_polygon');
      },
      clear() {
        const draw = drawRef.current;
        if (!draw) return;
        draw.deleteAll();
        onPerimeterDrawnRef.current?.([]);
      },
    }),
    [],
  );

  useEffect(() => {
    if (!map) return;

    const draw = new MapboxDraw(POLYGON_ONLY_DRAW_OPTIONS);
    map.addControl(draw, position);
    drawRef.current = draw;

    const emit = () =>
      onPerimeterDrawnRef.current?.(
        extractPolygonRing(draw.getAll() as GeoJSON.FeatureCollection),
      );

    // Mapbox Draw fires these as the operator draws / edits / deletes; keep the
    // perimeter callback in lockstep with the live geometry (legacy wired the
    // same three events to refreshDeployControls).
    map.on('draw.create', emit);
    map.on('draw.update', emit);
    map.on('draw.delete', emit);

    if (autoStart) draw.changeMode('draw_polygon');

    return () => {
      map.off('draw.create', emit);
      map.off('draw.update', emit);
      map.off('draw.delete', emit);
      // Guard: removeControl throws if the map is already being destroyed.
      try {
        if (map.hasControl(draw)) map.removeControl(draw);
      } catch {
        /* map already torn down */
      }
      drawRef.current = null;
    };
  }, [map, position, autoStart]);

  return handle;
}
