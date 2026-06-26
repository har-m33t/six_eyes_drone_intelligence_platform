/**
 * SIX-EYES coverage heatmap pipeline (Module B · Task B4)
 * -------------------------------------------------------
 * Mapbox-native "search footprint" trail. Reverse-engineered 1:1 from the legacy
 * vanilla dashboard (`six_eyes_dashboard.html` → "Coverage Heatmap Layer (Task 4)",
 * lines ~665-764) so the migrated React app paints an identical purple footprint.
 *
 * WHY a GeoJSON source + circle layer (not a 2D canvas overlay):
 *   - The source is map-anchored, so the accumulated trail stays geographically
 *     correct through any pan/zoom (Output Constraint #4). A canvas heatmap could
 *     not survive a pan without re-rasterising.
 *   - A single `geojson` source we keep appending to and re-push via `setData()`
 *     is the fast path for high-frequency (20Hz) telemetry — we mutate an
 *     in-memory FeatureCollection and hand the whole thing to Mapbox in one call,
 *     rather than diffing React state per tick (mirrors the B2 marker ref-cache
 *     philosophy: bypass React for hot-path map mutations).
 *   - Overlapping translucent circles (#9333EA @ 0.15 opacity) accumulate into a
 *     continuous, permanent search footprint that reads as a heatmap.
 *
 * The layer is registered UNDER the drone markers (Mapbox Markers always draw
 * above style layers), so it reads as the footprint beneath the live drones.
 *
 * Framework-agnostic on purpose: this class takes only a `mapboxgl.Map` instance,
 * so it conforms to Module B's strict interface boundary and can be instantiated
 * from `TacticalMap.tsx` (B1) via a `useRef` once that component lands — no
 * dependency on the React tree, the store, or the layout panels.
 */

import type { Map as MapboxMap, GeoJSONSource } from 'mapbox-gl';
import type { LngLat } from '../types/telemetry';

// ──────────────────────────────────────────────────────────────────────────
// Tunables (kept identical to the legacy dashboard so the footprint matches)
// ──────────────────────────────────────────────────────────────────────────

/** Source id for the single accumulating coverage FeatureCollection. */
export const COVERAGE_SOURCE_ID = 'coverage-source';
/** Layer id for the purple circle layer rendered from the source. */
export const COVERAGE_LAYER_ID = 'coverage-layer';

/** Tactical purple footprint fill. */
export const COVERAGE_COLOR = '#9333EA';
/** Low opacity so overlapping footprints accumulate into a heatmap. */
export const COVERAGE_OPACITY = 0.15;
/** Soft edge → heatmap-like blend rather than hard dots. */
export const COVERAGE_BLUR = 0.4;

/**
 * Spacing (in degrees) between interpolated footprints along a drone's path.
 * Telemetry packets arrive faster than the drone moves a footprint-width, but
 * when it does jump we backfill points so the trail has no visible gaps.
 */
export const COVERAGE_INTERPOLATION_STEP_DEGREES = 0.00002;
/** Hard cap on interpolated points per segment, so a teleport can't flood the source. */
export const COVERAGE_MAX_INTERPOLATED_POINTS = 160;

/**
 * Minimum movement (in degrees) required before a drone paints another footprint.
 * [BUG B4-1 fix] Without this, a hovering/creeping drone appends one coincident
 * point per tick (`distance === 0` → `steps = max(1, …) = 1`), growing the source
 * without bound at 20 Hz × 6 drones. Set to one footprint-spacing so sub-threshold
 * motion is ignored; because the anchor is NOT advanced when a tick is skipped,
 * slow drift still paints once it accumulates past one step — no gaps, no bloat.
 */
export const COVERAGE_MIN_MOVE_DEGREES = COVERAGE_INTERPOLATION_STEP_DEGREES;

/**
 * Zoom → circle-radius (px) ramp. Scales the footprint with zoom so it covers a
 * roughly constant ground area, preventing holes from opening as the operator
 * zooms in. Copied verbatim from the legacy paint expression.
 */
const COVERAGE_RADIUS_EXPRESSION: unknown[] = [
  'interpolate',
  ['exponential', 2],
  ['zoom'],
  10, 2,
  12, 7,
  14, 26,
  16, 102,
  18, 408,
];

// ──────────────────────────────────────────────────────────────────────────
// Lightweight GeoJSON shapes (avoids a hard @types/geojson dependency)
// ──────────────────────────────────────────────────────────────────────────

interface CoveragePointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: LngLat };
  properties: Record<string, never>;
}

interface CoverageFeatureCollection {
  type: 'FeatureCollection';
  features: CoveragePointFeature[];
}

// ──────────────────────────────────────────────────────────────────────────
// Controller
// ──────────────────────────────────────────────────────────────────────────

/**
 * Owns the coverage source/layer lifecycle and the fast append path.
 *
 * Usage (from B1's TacticalMap once the map exists):
 * ```ts
 * const heatmap = new CoverageHeatmap(map);
 * heatmap.attach();                 // idempotent; safe before/after style load
 * heatmap.append(lng, lat, droneId); // hot path, every telemetry tick
 * heatmap.clear();                  // on new mission / fresh search area
 * ```
 */
export class CoverageHeatmap {
  private readonly map: MapboxMap;

  /**
   * Accumulation buffer. We never clear this per-tick — overlapping translucent
   * circles build into the permanent, interactive search trail. `setData()`
   * re-pushes the whole collection (the documented fast path for a frequently
   * updated geojson source).
   */
  private readonly geojson: CoverageFeatureCollection = {
    type: 'FeatureCollection',
    features: [],
  };

  /** Per-drone last coordinate, used to interpolate gap-free segments. */
  private readonly lastByDrone: Record<string, { lng: number; lat: number }> = {};

  /** Bound so it can be added/removed as a `'load'` listener cleanly. */
  private readonly onLoad = () => this.registerSourceAndLayer();

  constructor(map: MapboxMap) {
    this.map = map;
  }

  /**
   * Register the source + layer. Idempotent (a no-op if already present, via the
   * `getSource` guard in `registerSourceAndLayer`) and safe to call before the
   * style has loaded — it defers to the one-shot `'load'` event.
   *
   * NOTE: this does NOT survive a `map.setStyle()`. `setStyle` drops custom
   * sources/layers and does NOT re-fire `'load'` (that fires once per map), so
   * the trail would silently vanish after a style swap. The SIX-EYES map uses a
   * single fixed style (`dark-v11`) and never calls `setStyle`, so this is not
   * exercised; a caller that adds style switching must re-`attach()` afterwards
   * (e.g. on `'style.load'`).
   */
  attach(): void {
    if (this.map.isStyleLoaded()) {
      this.registerSourceAndLayer();
    } else {
      this.map.on('load', this.onLoad);
    }
  }

  /**
   * Full teardown of this controller's map artefacts — call from the React
   * cleanup path. Removes the deferred-load listener AND the coverage layer +
   * source.
   *
   * [BUG B4-2 fix] Previously this removed only the `'load'` listener, so the
   * source/layer leaked whenever the map outlived the controller (style reload,
   * or a React remount on a still-mounted map). The layer is removed before the
   * source (Mapbox forbids dropping a source still in use by a layer), and both
   * are existence-guarded so teardown is safe before `attach()` or after a style
   * reload already dropped them. The accumulated `geojson` buffer is retained, so
   * a later `attach()` re-exposes the trail (matching the pre-attach buffering
   * behaviour).
   */
  detach(): void {
    this.map.off('load', this.onLoad);
    // The map may already be torn down — on a React unmount the map-host's own
    // `map.remove()` cleanup can run before this one, after which `getLayer` etc.
    // throw because the style is gone. Guard the whole teardown so detach is a
    // safe no-op in that case (there is nothing left to remove anyway).
    try {
      if (this.map.getLayer(COVERAGE_LAYER_ID)) this.map.removeLayer(COVERAGE_LAYER_ID);
      if (this.map.getSource(COVERAGE_SOURCE_ID)) this.map.removeSource(COVERAGE_SOURCE_ID);
    } catch {
      /* map already removed — nothing to clean up */
    }
  }

  private registerSourceAndLayer(): void {
    if (this.map.getSource(COVERAGE_SOURCE_ID)) return;

    this.map.addSource(COVERAGE_SOURCE_ID, {
      type: 'geojson',
      data: this.geojson as unknown as GeoJSON.FeatureCollection,
    });
    this.map.addLayer({
      id: COVERAGE_LAYER_ID,
      type: 'circle',
      source: COVERAGE_SOURCE_ID,
      paint: {
        'circle-color': COVERAGE_COLOR,
        'circle-opacity': COVERAGE_OPACITY,
        'circle-blur': COVERAGE_BLUR,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'circle-radius': COVERAGE_RADIUS_EXPRESSION as any,
      },
    });
  }

  /**
   * Fast append: drop a coverage footprint at `[lng, lat]` for `droneId` and
   * repaint via `getSource().setData()`. Interpolates footprints from that
   * drone's previous coordinate so the trail has no gaps between telemetry
   * packets. `Number.isFinite` rejects undefined/NaN/Infinity, so a malformed
   * packet can never inject a junk coordinate.
   *
   * `droneId` is REQUIRED [BUG B4-3 fix]: it keys the per-drone interpolation
   * anchor. The old `droneId = null` default funnelled every caller into a shared
   * `'__global__'` chain, so two unrelated drones appended without ids would be
   * bridged by one long bogus line. Making it required removes that footgun at
   * compile time — the only caller (per-drone telemetry) always has an id.
   *
   * Returns the number of footprint points appended (0 if the coord was junk or
   * the drone has not moved at least `COVERAGE_MIN_MOVE_DEGREES` — see B4-1).
   */
  append(lng: number, lat: number, droneId: string): number {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return 0;

    const prev = this.lastByDrone[droneId];
    let appended = 0;

    if (prev) {
      const distLng = lng - prev.lng;
      const distLat = lat - prev.lat;
      const distance = Math.hypot(distLng, distLat);

      // [BUG B4-1 fix] Ignore sub-threshold motion. The anchor is deliberately
      // left in place (no update below) so a slowly-drifting drone still paints
      // once its accumulated displacement crosses one footprint-spacing.
      if (distance < COVERAGE_MIN_MOVE_DEGREES) return 0;

      const steps = Math.min(
        COVERAGE_MAX_INTERPOLATED_POINTS,
        Math.max(1, Math.ceil(distance / COVERAGE_INTERPOLATION_STEP_DEGREES)),
      );
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        this.appendPoint(prev.lng + distLng * t, prev.lat + distLat * t);
        appended++;
      }
    } else {
      this.appendPoint(lng, lat);
      appended++;
    }
    this.lastByDrone[droneId] = { lng, lat };

    this.flush();
    return appended;
  }

  /**
   * Drop the per-drone interpolation anchor without clearing the trail. Call this
   * when a drone stops actively covering ground (e.g. `coverage_active === false`)
   * so the next active packet starts a fresh segment instead of drawing a long
   * line across the transit gap.
   */
  breakSegment(droneId: string): void {
    delete this.lastByDrone[droneId];
  }

  /**
   * Wipe the accumulated trail (e.g. when a fresh search area is deployed). Not
   * called on reconnect — the trail is meant to stay "permanent" per the spec.
   */
  clear(): void {
    this.geojson.features.length = 0;
    for (const key of Object.keys(this.lastByDrone)) delete this.lastByDrone[key];
    this.flush();
  }

  /** Current footprint count — handy for tests and the coverage stat. */
  get pointCount(): number {
    return this.geojson.features.length;
  }

  private appendPoint(lng: number, lat: number): void {
    this.geojson.features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {} as Record<string, never>,
    });
  }

  /** Re-push the whole FeatureCollection to Mapbox (the documented fast path). */
  private flush(): void {
    const src = this.map.getSource(COVERAGE_SOURCE_ID) as GeoJSONSource | undefined;
    if (src) src.setData(this.geojson as unknown as GeoJSON.FeatureCollection);
  }
}
