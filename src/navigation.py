"""Waypoint navigation for the SIX-EYES swarm (Deploy Swarm — Task 3).

``.claude/deploy-swarm-integration.md`` Task 3 drives a drone step-by-step along
the boustrophedon route that ``coverage_planner.plan_mission()`` assigns it,
calling ``navigator.tick()`` each producer frame and broadcasting the movement
back to the dashboard's nav-telemetry stream.

The task wording ("Do not rewrite ... navigation.py; simply import and use them")
assumes this module already existed — it did not (see the Task 2 note in
deploy-swarm-integration.md). It is created here to the contract pinned by the
specs ``tests/test_thread_activation.py`` (happy path) and
``tests/test_navigation.py`` (edge cases): a *continuous* mover whose
``tick(dt)`` advances ``speed * dt`` units along the polyline, retiring every
waypoint it passes and clamping onto the last one, and which exposes the
dashboard's nav-telemetry surface
``{x, y, current_waypoint_idx, waypoints_remaining, mission_complete}``. Route
*generation* stays entirely in ``coverage_planner.py``; this module only flies a
pre-computed route.

Coordinates are route-local ``(x, y)`` units. Legacy missions use SIM_WORLD;
Mapbox-drawn missions use ``(lng, lat)`` degrees. Default speed is scaled for
small geographic routes so a city-scale polygon remains visible in the demo.
"""
from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

from . import config

Waypoint = Tuple[float, float]


def _path_length(waypoints: List[Waypoint]) -> float:
    return sum(
        math.hypot(x2 - x1, y2 - y1)
        for (x1, y1), (x2, y2) in zip(waypoints, waypoints[1:])
    )


def _looks_like_small_lnglat_route(waypoints: List[Waypoint]) -> bool:
    """Detect city-scale Mapbox routes without relabeling legacy SIM routes."""
    if len(waypoints) < 2:
        return False
    xs = [pt[0] for pt in waypoints]
    ys = [pt[1] for pt in waypoints]
    if not all(math.isfinite(v) for v in xs + ys):
        return False
    if not all(-180 <= x <= 180 for x in xs) or not all(-90 <= y <= 90 for y in ys):
        return False
    if max(max(xs) - min(xs), max(ys) - min(ys)) > 1.0:
        return False
    # Avoid treating tiny local SIM test routes near the origin as geography.
    return any(abs(x) > 1.0 for x in xs) or any(abs(y) > 1.0 for y in ys)


def _default_speed_for_route(waypoints: List[Waypoint]) -> float:
    if _looks_like_small_lnglat_route(waypoints):
        duration = max(config.NAV_GEO_ROUTE_DURATION_S, 1.0)
        length = _path_length(waypoints)
        if length > 0:
            return length / duration
    return config.NAV_SPEED_UNITS_S


class WaypointNavigator:
    """Flies one drone along an ordered list of ``(x, y)`` waypoints.

    Continuous mover: each :meth:`tick` consumes a ``speed * dt`` movement budget
    along the straight line to the current target waypoint, snapping and advancing
    the index on arrival (a single tick can cross several closely-spaced
    waypoints). It never spends more budget than the distance to a waypoint, so
    the position stays exactly on its segments (inside the route's bounding box)
    and lands precisely on the final waypoint — no overshoot. Once the last
    waypoint is reached the navigator is *complete* and ``tick()`` is inert.

    Navigation is *paused* until :meth:`activate` is called — the "unpause the
    navigation loop" step in Task 3. A fresh navigator does not move on its own;
    the producer only ticks the ones it has armed.
    """

    def __init__(
        self,
        waypoints: List[Waypoint],
        speed: Optional[float] = None,
        start: Optional[Waypoint] = None,
    ):
        # Ground speed in route units/second. Explicit speed is respected as-is.
        # The default remains the legacy SIM_WORLD speed for large SIM routes,
        # but city-scale Mapbox [lng, lat] routes are auto-paced in _load().
        self._speed_explicit = speed is not None
        self.speed = config.NAV_SPEED_UNITS_S if speed is None else float(speed)
        self.active = False
        self._load(waypoints, start)

    # -- route management ----------------------------------------------------
    def _load(self, waypoints: List[Waypoint], start: Optional[Waypoint] = None):
        # Defensive copy: never alias the caller's list (the planner may reuse a
        # buffer; a later mutation must not corrupt an in-flight route).
        new_waypoints: List[Waypoint] = [(float(x), float(y)) for x, y in waypoints]
        if not self._speed_explicit:
            self.speed = _default_speed_for_route(new_waypoints)
        if start is not None:
            self.x, self.y = float(start[0]), float(start[1])
        elif new_waypoints:
            self.x, self.y = new_waypoints[0]
        else:
            self.x, self.y = 0.0, 0.0
        # ``target`` is the waypoint we fly toward and the count already reached.
        # Position starts on the first waypoint; the first tick retires waypoint 0
        # and heads for waypoint 1. Publish target before waypoints so a concurrent
        # reader (a ticking producer) never pairs a fresh short route with a stale
        # large index — see tick()'s capture-once guard.
        self.target = 0
        self.waypoints = new_waypoints

    def set_waypoints(self, waypoints: List[Waypoint], start: Optional[Waypoint] = None):
        """Replace the route in place (a re-deploy onto a new polygon). Resets
        progress to the new route's start; leaves the active flag untouched."""
        self._load(waypoints, start)

    def activate(self):
        """Unpause navigation — the drone flies on subsequent ticks."""
        self.active = True

    def deactivate(self):
        self.active = False

    # -- progress ------------------------------------------------------------
    @property
    def is_complete(self) -> bool:
        return self.target >= len(self.waypoints)

    @property
    def current_waypoint_idx(self) -> int:
        """Waypoints reached so far (also the index of the next target)."""
        return self.target

    @property
    def waypoints_remaining(self) -> int:
        return max(0, len(self.waypoints) - self.target)

    @property
    def position(self) -> Waypoint:
        return (self.x, self.y)

    def tick(self, dt: float) -> dict:
        """Advance the drone by ``speed * dt`` along its route and return the
        current nav-telemetry snapshot. A no-op (other than returning state) when
        paused, finished, or handed a non-positive / non-finite ``dt``."""
        # Capture the route reference and index together so a concurrent
        # set_waypoints() swap can't pair this list with a mismatched index and
        # IndexError (the producer thread ticks while the WS thread redeploys).
        waypoints = self.waypoints
        n = len(waypoints)
        target = self.target
        if self.active and target < n and dt > 0:
            x, y = self.x, self.y
            budget = self.speed * dt
            while budget > 0 and target < n:
                tx, ty = waypoints[target]
                dx, dy = tx - x, ty - y
                dist = math.hypot(dx, dy)
                if not (dist > budget):
                    # Reach (or already sit on) this waypoint: snap, bank leftover
                    # budget, advance. ``not (dist > budget)`` also retires a NaN
                    # segment (NaN comparisons are False) so a bad waypoint can't
                    # wedge the loop — fail soft, never hang the producer.
                    x, y = tx, ty
                    budget -= dist
                    target += 1
                else:
                    # Partway there — slide along the bearing and stop (dist > 0
                    # here, so the normalisation is safe for duplicate waypoints).
                    x += dx / dist * budget
                    y += dy / dist * budget
                    budget = 0.0
            self.x, self.y = x, y
            self.target = target
        return self.telemetry()

    def telemetry(self) -> dict:
        """Drone-agnostic progress snapshot (the producer stamps drone_id)."""
        target = self.target
        total = len(self.waypoints)
        return {
            "x": round(self.x, 2),
            "y": round(self.y, 2),
            "current_waypoint_idx": target,
            "waypoints_remaining": max(0, total - target),
            "mission_complete": target >= total,
        }


def build_navigators(plan: Dict[str, List[Waypoint]]) -> Dict[str, WaypointNavigator]:
    """Convenience: turn a ``plan_mission`` result into ``{key: navigator}``
    (paused). The producer uses its own activation path; this is handy for tests
    and any non-threaded consumer."""
    return {key: WaypointNavigator(waypoints) for key, waypoints in plan.items()}
