/**
 * SIX-EYES high-frequency drone marker cache (Module B · Task B2)
 * ---------------------------------------------------------------
 * Maps incoming drone positions from Module A directly onto mutable Mapbox
 * `Marker` DOM elements held in an internal ref cache — the deliberate escape
 * hatch from React's render loop. At 20 Hz telemetry a `useState`-driven list of
 * `<Marker/>` components would reconcile six subtrees ~20×/sec and the Mapbox
 * canvas would visibly jitter as markers are torn down and recreated. Instead
 * each drone owns ONE long-lived `mapboxgl.Marker` whose position and appearance
 * are mutated in place; Mapbox re-projects `[lng,lat]→pixel` every frame, so
 * pan/zoom never desyncs the dots either.
 *
 * Reverse-engineered 1:1 from the legacy vanilla dashboard
 * (`six_eyes_dashboard.html` → "Live drone markers (Task 3)":
 * `droneMarkers` / `makeMarkerElement` / `updateDroneMarker` / `statusColor`),
 * with one refinement: per-field dirty-checking so we only write to the DOM when
 * a value actually changes, not on every redundant tick.
 *
 * Framework-agnostic on purpose — it takes only a `mapboxgl.Map` instance and a
 * plain `DronePosition[]`, exactly like the sibling `CoverageHeatmap` (Task B4).
 * So it conforms to Module B's strict interface boundary and is instantiated from
 * `TacticalMap.tsx` (B1) via a `useRef` once the map exists, with no dependency
 * on the React tree, the store runtime, or the layout panels. The optional
 * `useDroneMarkers` hook below is the thin B1-facing glue.
 *
 * Usage (from B1's TacticalMap once the map is ready):
 * ```ts
 * const markers = new DroneMarkerCache(map);
 * markers.sync(positions); // hot path, every store tick
 * markers.clear();         // on new mission / teardown
 * ```
 */

import { useEffect, useRef, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap, Marker } from 'mapbox-gl';
import type { DroneId, DroneStatus } from '../types/telemetry';
import type { DronePosition } from '../store/useSwarmStore';
import './droneMarkers.css';

// `DronePosition` (the store's derived view-model — `{ id, lng, lat, status,
// hasDetection, coverageActive }`) is the documented array Module B consumes
// from `useDronePositions()`. Re-exported so B1/D can import the contract from
// the marker module without reaching into the store.
export type { DronePosition } from '../store/useSwarmStore';

// ──────────────────────────────────────────────────────────────────────────
// Presentation helpers (ported from legacy `statusColor` / `makeMarkerElement`)
// ──────────────────────────────────────────────────────────────────────────

/** Status → glow color, identical to the legacy `statusColor()`. */
const STATUS_COLOR: Record<DroneStatus, string> = {
  CRITICAL: '#ff5c5c',
  WARNING: '#ffb84d',
  ONLINE: '#a78bfa',
};

/** Resolve a drone status to its marker glow color (defaults to ONLINE purple). */
export function statusColor(status: DroneStatus): string {
  return STATUS_COLOR[status] ?? STATUS_COLOR.ONLINE;
}

/**
 * Build the custom HTML element (glowing dot + id label) for one drone marker.
 * Mirrors legacy `makeMarkerElement`. `.drone-marker` (see `droneMarkers.css`)
 * reads the `--marker-color` custom property we set per status.
 */
function makeMarkerElement(id: DroneId): { el: HTMLDivElement; dot: HTMLDivElement } {
  const el = document.createElement('div');
  const dot = document.createElement('div');
  dot.className = 'drone-marker';

  const label = document.createElement('span');
  label.className = 'drone-marker-label';
  label.textContent = id.replace('DRONE_', 'D');

  dot.appendChild(label);
  el.appendChild(dot);
  return { el, dot };
}

// ──────────────────────────────────────────────────────────────────────────
// Internal cache entry — the live marker plus a shadow of its last-applied
// state, so we can skip no-op DOM writes (the 20 Hz jitter guard).
// ──────────────────────────────────────────────────────────────────────────

interface MarkerEntry {
  marker: Marker;
  dot: HTMLDivElement;
  lng: number;
  lat: number;
  status: DroneStatus | null;
  detected: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// The cache
// ──────────────────────────────────────────────────────────────────────────

export class DroneMarkerCache {
  private readonly map: MapboxMap;
  private readonly cache = new Map<DroneId, MarkerEntry>();

  constructor(map: MapboxMap) {
    this.map = map;
  }

  /**
   * Create-or-update a single drone's marker. Lazily creates the marker on the
   * drone's first valid fix, then mutates only fields that actually changed.
   * Junk coordinates are rejected so a malformed packet can never fling a dot
   * off-map (mirrors the legacy `Number.isFinite` guard).
   */
  update(pos: DronePosition): void {
    if (!Number.isFinite(pos.lng) || !Number.isFinite(pos.lat)) return;

    let entry = this.cache.get(pos.id);

    if (!entry) {
      const { el, dot } = makeMarkerElement(pos.id);
      const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat([pos.lng, pos.lat])
        .addTo(this.map);
      entry = { marker, dot, lng: pos.lng, lat: pos.lat, status: null, detected: false };
      this.cache.set(pos.id, entry);
    } else if (entry.lng !== pos.lng || entry.lat !== pos.lat) {
      // Smooth in-place reposition — no re-create, no React reconcile.
      entry.marker.setLngLat([pos.lng, pos.lat]);
      entry.lng = pos.lng;
      entry.lat = pos.lat;
    }

    // Recolor the glowing dot only when status actually flips, so we are not
    // rewriting the same CSS variable 20×/sec.
    if (entry.status !== pos.status) {
      entry.dot.style.setProperty('--marker-color', statusColor(pos.status));
      entry.status = pos.status;
    }

    // Toggle the amber human-detection ring only on edge changes.
    if (entry.detected !== pos.hasDetection) {
      entry.dot.classList.toggle('detected', pos.hasDetection);
      entry.detected = pos.hasDetection;
    }
  }

  /**
   * Reconcile the cache against the latest array of drone positions — the single
   * entry point the React hook (or a raw store subscription) calls on each store
   * change. O(n) over the six drones, cheap enough to run at 20 Hz.
   *
   * By default markers for drones absent from `positions` are LEFT in place,
   * mirroring the legacy dashboard where the six drones persist for the whole
   * mission and a momentary packet gap must not drop a dot. Pass `prune` to
   * remove stale markers (e.g. on a fresh mission).
   */
  sync(positions: readonly DronePosition[], options: { prune?: boolean } = {}): void {
    for (const pos of positions) this.update(pos);

    if (options.prune) {
      const live = new Set(positions.map((p) => p.id));
      for (const id of this.cache.keys()) {
        if (!live.has(id)) this.remove(id);
      }
    }
  }

  /** Remove a single drone's marker from the map and cache. */
  remove(id: DroneId): void {
    const entry = this.cache.get(id);
    if (!entry) return;
    entry.marker.remove();
    this.cache.delete(id);
  }

  /** Whether a marker currently exists for a drone (test/diagnostic helper). */
  has(id: DroneId): boolean {
    return this.cache.has(id);
  }

  /** Number of live markers (test/diagnostic helper). */
  get size(): number {
    return this.cache.size;
  }

  /** Remove every marker (teardown / fresh mission). */
  clear(): void {
    for (const entry of this.cache.values()) entry.marker.remove();
    this.cache.clear();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// React glue (Task B1-facing) — keeps the cache in a ref so it is never part of
// the render output, the way `useMapboxDraw` (B3) holds its draw instance.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Drive a {@link DroneMarkerCache} from React. Build the cache once per map
 * instance and sync it imperatively whenever `positions` changes — so the
 * markers themselves never re-render.
 *
 * Pair with the store selector: `useDroneMarkers(map, useDronePositions())`.
 *
 * @param map        Live Mapbox map from Task B1, or `null` until it initialises.
 * @param positions  Latest drone positions (`useDronePositions()`).
 * @param prune      Remove markers for drones absent from `positions`.
 * @returns          A ref to the live cache, for imperative use by B3/B4/D.
 */
export function useDroneMarkers(
  map: MapboxMap | null,
  positions: readonly DronePosition[],
  prune = false,
): MutableRefObject<DroneMarkerCache | null> {
  const cacheRef = useRef<DroneMarkerCache | null>(null);

  // (Re)build the cache whenever the underlying map *instance* changes (B1 mounts
  // it asynchronously; a remounted TacticalMap yields a fresh map), tearing the
  // old markers down cleanly. Note: a Mapbox style reload (`setStyle`) does NOT
  // change the map identity and does NOT drop DOM Markers, so it correctly does
  // not rebuild here (unlike B4's coverage source/layer, which must re-add).
  useEffect(() => {
    if (!map) return;
    const cache = new DroneMarkerCache(map);
    cacheRef.current = cache;
    return () => {
      cache.clear();
      cacheRef.current = null;
    };
  }, [map]);

  // Per-update sync. The cache mutates marker DOM directly, so this effect never
  // triggers a React re-render of the marker layer.
  //
  // `map` is in the deps deliberately: the map usually initialises asynchronously
  // (B1 fires `onReady` on the Mapbox `load` event) AFTER the store already holds
  // stable `positions`. Keyed only on `[positions, prune]`, this effect would not
  // re-run when the cache is (re)created, leaving a freshly-built cache empty —
  // no drones would appear until the next position change. Depending on `map`
  // re-syncs against the new cache the moment it exists. (Effects run in
  // declaration order, so the cache-build effect above has already populated
  // `cacheRef` by the time this runs on a `map` change.)
  useEffect(() => {
    cacheRef.current?.sync(positions, { prune });
  }, [map, positions, prune]);

  return cacheRef;
}
