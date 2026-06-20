"""
coverage_planner.py — SIX-EYES mission planner.

Given a user-drawn search polygon, generate a boustrophedon ("lawnmower")
sweep that fully covers the area, then partition that sweep into contiguous
chunks — one per drone in the swarm.

Geometric backbone:
    * shapely  — polygon healing, bounding box, line/polygon intersection.
    * numpy    — vectorised generation of the sweep-line altitudes.

The output is plain ``(x, y)`` tuples (no shapely objects leak out) so the
rest of the SIX-EYES stack can serialise waypoints without a geometry
dependency.

Coordinate-system agnostic: the planner does plain planar geometry, so the
input perimeter can be SIM ``(x, y)`` units *or* geographic ``(lng, lat)``
degrees. Because a fixed sweep spacing means wildly different things in those
two spaces (10 SIM units vs. 10° ≈ 1100 km), ``sweep_spacing`` defaults to a
*scale-invariant* value derived from the polygon's own extent (see
``DEFAULT_SWEEP_ROWS``) so a degree-scale search area gets a degree-scale
spacing without the caller retuning anything.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

# Scale-invariant default density: when no explicit ``sweep_spacing`` is given,
# lay this many parallel sweep lines across the polygon's vertical extent. Chosen
# so a 100x50 rect yields spacing = 50 / 5 = 10.0 — the planner's historical
# default — while a (lng, lat) polygon a few hundredths of a degree tall gets a
# correspondingly tiny spacing instead of collapsing to a single sweep.
DEFAULT_SWEEP_ROWS = 5

import numpy as np
from shapely.geometry import (
    GeometryCollection,
    LineString,
    MultiLineString,
    Polygon,
)
from shapely.geometry.base import BaseGeometry

# A single waypoint and a list of them. Kept as aliases so the public
# signatures read clearly and stay strictly typed.
Waypoint = Tuple[float, float]
Path = List[Waypoint]


def _extract_line_coords(geometry: BaseGeometry) -> List[Waypoint]:
    """
    Pull ``(x, y)`` endpoints out of whatever a sweep-line ∩ polygon returns.

    A horizontal line clipped against a polygon can yield several geometry
    types depending on the polygon's shape at that altitude:

        * ``LineString``        — the common case: one segment spanning the area.
        * ``MultiLineString``   — a concave / multi-lobed polygon splits the
                                   sweep into two or more disjoint segments.
        * ``GeometryCollection``— a *mix*: a real line span alongside a vertex
                                   graze (``Point``) at the same altitude. We must
                                   recurse and keep the line span; dropping the
                                   whole collection would leave a coverage hole.
        * ``Point`` / empty     — the line only grazes a vertex, or misses the
                                   polygon entirely. These carry no usable span,
                                   so we drop them.

    Returns every endpoint we found as a flat list of coordinate tuples;
    sorting/ordering is handled by the caller.
    """
    # Nothing to do for empty intersections (line above/below the polygon).
    if geometry.is_empty:
        return []

    coords: List[Waypoint] = []

    if isinstance(geometry, LineString):
        # Single span — grab both endpoints.
        coords.extend((float(x), float(y)) for x, y in geometry.coords)
    elif isinstance(geometry, (MultiLineString, GeometryCollection)):
        # MultiLineString  → disjoint sub-segments from a concave polygon.
        # GeometryCollection → a heterogeneous mix (lines + grazing points).
        # Recurse into each member so genuine spans survive and bare points
        # fall through to the "ignored" case below.
        for part in geometry.geoms:
            coords.extend(_extract_line_coords(part))
    # Any other type (Point, etc.) is a degenerate graze with no width —
    # intentionally ignored.

    return coords


def _dedupe_consecutive(points: Path) -> Path:
    """
    Drop consecutive duplicate waypoints, collapsing zero-length hops.

    When a sweep altitude lands exactly on a horizontal polygon edge (e.g. the
    floor of a concave notch), the line ∩ polygon intersection returns that edge
    *plus* the crossing arms, so ``_extract_line_coords`` emits repeated points
    like ``[(0,5),(4,5),(4,5),(6,5)]``. Those repeats are redundant
    zero-distance hops for a flight controller. Collapsing only *consecutive*
    duplicates preserves the snake ordering and the legitimate revisits a
    boustrophedon path can make to the same X at different altitudes.
    """
    deduped: Path = []
    for pt in points:
        if not deduped or deduped[-1] != pt:
            deduped.append(pt)
    return deduped


def generate_lawnmower_path(
    polygon_coords: List[Waypoint],
    sweep_spacing: Optional[float] = None,
) -> Path:
    """
    Build a continuous boustrophedon (lawnmower) path that covers ``polygon``.

    Args:
        polygon_coords: Perimeter of the search area as ``(x, y)`` *or*
                        ``(lng, lat)`` tuples.
        sweep_spacing:  Vertical distance between parallel sweep lines, in the
                        same units as the coordinates. Smaller spacing → denser
                        coverage and more waypoints. When ``None`` (the default)
                        a scale-invariant spacing of
                        ``height / DEFAULT_SWEEP_ROWS`` is computed from the
                        polygon's own extent, so SIM and geographic polygons both
                        work without retuning.

    Returns:
        A flat, ordered list of waypoints forming one continuous snake path, in
        the input coordinate space. Empty if the polygon is unusable / no area.
    """
    # Only an *explicit* non-positive spacing is an error; ``None`` means "pick
    # one for me" and is resolved from the polygon bounds below.
    if sweep_spacing is not None and sweep_spacing <= 0:
        raise ValueError("sweep_spacing must be a positive distance.")

    # 1. Build the polygon. A user-drawn perimeter is frequently invalid —
    #    self-intersecting ("bow-tie") or with duplicate points. ``buffer(0)``
    #    is the classic shapely idiom to heal such geometry: it re-runs the
    #    polygon through the noder and returns a valid, cleaned equivalent.
    polygon = Polygon(polygon_coords)
    if not polygon.is_valid:
        polygon = polygon.buffer(0)

    # After healing the result can be empty (e.g. a zero-area scribble) — bail
    # out gracefully rather than emit garbage waypoints.
    if polygon.is_empty or polygon.area == 0:
        return []

    # 2. Axis-aligned bounding box gives us the vertical extent to sweep over.
    min_x, min_y, max_x, max_y = polygon.bounds

    # Resolve a scale-invariant spacing from the polygon's height when the caller
    # didn't pin one — keeps the planner unit-agnostic ((x, y) or (lng, lat)).
    if sweep_spacing is None:
        sweep_spacing = (max_y - min_y) / DEFAULT_SWEEP_ROWS

    # 3. Generate the Y-altitudes for each horizontal sweep line. We start half
    #    a spacing *inside* the bottom edge so the first/last lines sit within
    #    the area rather than exactly on the boundary (where intersections are
    #    fragile). ``np.arange`` gives us evenly spaced altitudes moving up.
    start_y = min_y + sweep_spacing / 2.0
    sweep_altitudes = np.arange(start_y, max_y, sweep_spacing)

    # Guard: if the polygon is shorter than half a spacing, arange is empty.
    # Fall back to a single sweep through the vertical midpoint so a tiny area
    # still gets covered.
    if sweep_altitudes.size == 0:
        sweep_altitudes = np.array([(min_y + max_y) / 2.0])

    waypoints: Path = []

    # 4. Walk each sweep altitude, clip it to the polygon, and stitch the
    #    surviving span into the path — alternating direction every other line.
    for index, y in enumerate(sweep_altitudes):
        # Build a horizontal probe line that is guaranteed to span the full
        # width of the bounding box (so it fully crosses the polygon).
        sweep_line = LineString([(min_x, y), (max_x, y)])

        # The intersection is exactly the portion of this altitude that lies
        # inside the search area.
        clipped = polygon.intersection(sweep_line)
        row_points = _extract_line_coords(clipped)
        if not row_points:
            # Line fell in a gap (concave notch) or missed entirely.
            continue

        # 5. Boustrophedon ordering: sort this row's points by X, then reverse
        #    on every odd row. Even rows run left→right, odd rows right→left,
        #    so the end of one row is adjacent to the start of the next — no
        #    long diagonal "fly-back" between sweeps.
        row_points.sort(key=lambda pt: pt[0])
        if index % 2 == 1:
            row_points.reverse()

        waypoints.extend(row_points)

    # Collapse any repeated/zero-length hops introduced when a sweep grazed a
    # horizontal edge (see _dedupe_consecutive). The half-spacing offset makes
    # this rare, but adversarial polygons can still trigger it.
    return _dedupe_consecutive(waypoints)


def split_path_for_drones(
    waypoints: Path,
    num_drones: int = 6,
) -> Dict[str, Path]:
    """
    Divide a continuous waypoint path into contiguous per-drone chunks.

    The split preserves order, so each drone flies an unbroken sub-segment of
    the original snake path (no drone teleports across the field). When the
    waypoint count isn't evenly divisible, the remainder is handed out one
    extra waypoint at a time to the lowest-numbered drones.

    Args:
        waypoints:  The full ordered path from ``generate_lawnmower_path``.
        num_drones: Number of drones / chunks to produce.

    Returns:
        Mapping of ``"drone_<n>"`` → its contiguous waypoint list. Drones that
        receive no waypoints (more drones than waypoints) map to an empty list.
    """
    if num_drones <= 0:
        raise ValueError("num_drones must be a positive integer.")

    total = len(waypoints)

    # Base chunk size and how many drones get one extra waypoint. e.g. 20
    # waypoints / 6 drones → base 3, remainder 2 → sizes [4, 4, 3, 3, 3, 3].
    base, remainder = divmod(total, num_drones)

    assignments: Dict[str, Path] = {}
    cursor = 0
    for drone_index in range(num_drones):
        # First ``remainder`` drones absorb the leftover waypoints.
        chunk_size = base + 1 if drone_index < remainder else base
        chunk = waypoints[cursor : cursor + chunk_size]
        assignments[f"drone_{drone_index + 1}"] = chunk
        cursor += chunk_size

    return assignments


def plan_mission(
    polygon_coords: List[Waypoint],
    num_drones: int = 6,
    sweep_spacing: Optional[float] = None,
) -> Dict[str, Path]:
    """
    End-to-end planner: polygon → lawnmower path → per-drone assignments.

    Args:
        polygon_coords: Search-area perimeter as ``(x, y)`` or ``(lng, lat)``
                        tuples.
        num_drones:     Size of the swarm.
        sweep_spacing:  Distance between parallel sweep lines, in the coordinate
                        units. ``None`` (default) self-scales from the polygon
                        extent (see ``generate_lawnmower_path``), so geographic
                        polygons need no retuning.

    Returns:
        ``{"drone_<n>": [(x, y), ...]}`` covering the whole search area.
    """
    full_path = generate_lawnmower_path(polygon_coords, sweep_spacing)
    return split_path_for_drones(full_path, num_drones)


if __name__ == "__main__":
    # --- Smoke test: a 100 x 50 rectangle ----------------------------------
    # With a 10-unit spacing the planner lays sweeps at y = 5, 15, 25, 35, 45
    # (5 rows), each clipped to x ∈ [0, 100], snaking left↔right.
    mock_polygon: List[Waypoint] = [(0, 0), (100, 0), (100, 50), (0, 50)]

    print("=== SIX-EYES coverage planner -- self test ===\n")

    path = generate_lawnmower_path(mock_polygon, sweep_spacing=10.0)
    print(f"Generated {len(path)} waypoints over the search area:")
    for waypoint in path:
        print(f"  {waypoint}")

    print("\nPer-drone assignments (num_drones=6):")
    mission = plan_mission(mock_polygon, num_drones=6, sweep_spacing=10.0)
    for drone_id, drone_path in mission.items():
        print(f"  {drone_id}: {len(drone_path)} waypoints -> {drone_path}")
