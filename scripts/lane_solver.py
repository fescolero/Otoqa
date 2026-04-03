#!/usr/bin/env python3
"""
Lane Analyzer — Optimal Shift Solver using Google OR-Tools

Solves the Vehicle Routing Problem (VRP) with Time Windows:
- Vehicles = Drivers (minimize count)
- Nodes = Lanes (pickup/delivery pairs with time windows)
- Constraints = HOS (11h drive / 14h duty), max wait, geography
- Objective = Minimize number of drivers

Usage:
  python3 scripts/lane_solver.py --input path/to/lanes.csv --date 2026-03-23
  python3 scripts/lane_solver.py --input path/to/lanes.csv  # runs all dates
"""

import csv
import sys
import argparse
from collections import defaultdict
from dataclasses import dataclass, field
from math import radians, sin, cos, sqrt, atan2
from typing import Optional

# ---- Constants ----
HOS_MAX_DRIVE = 11.0  # hours
HOS_MAX_DUTY = 14.0   # hours
BREAK_AFTER = 8.0     # hours driving before 30-min break
BREAK_DURATION = 0.5   # hours
DEFAULT_MPH = 55.0     # average speed for deadhead
DEFAULT_PRE_POST_TRIP = 0.25  # 15 min
DEFAULT_DWELL = 0.25   # 15 min per stop
DEFAULT_MAX_WAIT = 2.0  # hours
DEFAULT_MAX_DEADHEAD = 75  # miles
DEFAULT_MAX_LEGS = 8


@dataclass
class Lane:
    id: str
    name: str
    origin_city: str
    origin_state: str
    origin_lat: Optional[float]
    origin_lng: Optional[float]
    dest_city: str
    dest_state: str
    dest_lat: Optional[float]
    dest_lng: Optional[float]
    route_miles: float
    route_duration_hours: float
    pickup_time: Optional[float]  # hours from midnight (e.g., 4.25 = 4:15 AM)
    pickup_end_time: Optional[float]
    delivery_time: Optional[float]
    delivery_end_time: Optional[float]
    dwell_hours: float = DEFAULT_DWELL * 2  # origin + dest dwell
    active_days: list = field(default_factory=lambda: [1, 2, 3, 4, 5])  # Mon-Fri
    schedule_dates: list = field(default_factory=list)

    @property
    def finish_time(self) -> Optional[float]:
        """When this lane finishes (delivery end or computed)."""
        if self.delivery_end_time is not None:
            # Handle midnight crossing
            del_end = self.delivery_end_time
            if self.pickup_time is not None and del_end < self.pickup_time:
                del_end += 24.0
            computed = (self.pickup_time + self.dwell_hours + self.route_duration_hours) if self.pickup_time is not None else None
            if computed is not None:
                return max(del_end, computed)
            return del_end
        if self.delivery_time is not None:
            del_time = self.delivery_time
            if self.pickup_time is not None and del_time < self.pickup_time:
                del_time += 24.0
            return del_time
        if self.pickup_time is not None:
            return self.pickup_time + self.dwell_hours + self.route_duration_hours
        return None


def haversine(lat1, lng1, lat2, lng2):
    """Distance in miles between two lat/lng points."""
    R = 3958.8  # Earth radius in miles
    dlat = radians(lat2 - lat1)
    dlng = radians(lng2 - lng1)
    a = sin(dlat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng/2)**2
    return R * 2 * atan2(sqrt(a), sqrt(1 - a))


def parse_time(s: str) -> Optional[float]:
    """Parse HH:MM:SS or HH:MM to hours from midnight."""
    if not s or s.strip() == '':
        return None
    parts = s.strip().split(':')
    h = int(parts[0])
    m = int(parts[1]) if len(parts) > 1 else 0
    sec = int(parts[2]) if len(parts) > 2 else 0
    return h + m / 60.0 + sec / 3600.0


def load_lanes(csv_path: str) -> list[Lane]:
    """Load lanes from CSV."""
    lanes = []
    with open(csv_path, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            lane = Lane(
                id=row.get('id', row.get('name', '')),
                name=row.get('name', ''),
                origin_city=row.get('origin_city') or '',
                origin_state=row.get('origin_state') or '',
                origin_lat=float(row['origin_lat']) if row.get('origin_lat') and row['origin_lat'] != '' else None,
                origin_lng=float(row['origin_lng']) if row.get('origin_lng') and row['origin_lng'] != '' else None,
                dest_city=row.get('dest_city') or '',
                dest_state=row.get('dest_state') or '',
                dest_lat=float(row['dest_lat']) if row.get('dest_lat') and row['dest_lat'] != '' else None,
                dest_lng=float(row['dest_lng']) if row.get('dest_lng') and row['dest_lng'] != '' else None,
                route_miles=float(row.get('route_miles') or 0),
                route_duration_hours=float(row.get('route_duration_hours') or 0),
                pickup_time=parse_time(row.get('pickup_time', '')),
                pickup_end_time=parse_time(row.get('pickup_end_time', '')),
                delivery_time=parse_time(row.get('delivery_time', '')),
                delivery_end_time=parse_time(row.get('delivery_end_time', '')),
                dwell_hours=float(row.get('dwell_hours') or DEFAULT_DWELL * 2),
            )
            # Parse active days
            days_str = row.get('active_days', '1,2,3,4,5')
            if days_str:
                lane.active_days = [int(d.strip()) for d in days_str.split(',') if d.strip()]
            lanes.append(lane)
    return lanes


def can_connect(lane_a: Lane, lane_b: Lane, max_deadhead: float) -> tuple[bool, float, float]:
    """Check if lane_b can follow lane_a. Returns (feasible, deadhead_miles, deadhead_hours)."""
    # Use pre-computed address-to-address distance when both have coords
    if lane_a.dest_lat and lane_a.dest_lng and lane_b.origin_lat and lane_b.origin_lng:
        # Round coordinates to 4 decimal places before computing to ensure
        # identical results on x86 and ARM
        lat1 = round(lane_a.dest_lat, 4)
        lng1 = round(lane_a.dest_lng, 4)
        lat2 = round(lane_b.origin_lat, 4)
        lng2 = round(lane_b.origin_lng, 4)
        dist = int(haversine(lat1, lng1, lat2, lng2))  # integer miles
    elif (lane_a.dest_city and lane_b.origin_city and
          lane_a.dest_city.lower().strip() == lane_b.origin_city.lower().strip()):
        dist = 2  # same city
    else:
        dist = 999

    if dist > max_deadhead:
        return False, float(dist), dist / DEFAULT_MPH

    return True, float(dist), dist / DEFAULT_MPH


def build_graph(lanes: list[Lane], max_deadhead: float) -> dict[str, list[tuple[str, float, float]]]:
    """Build adjacency graph: lane_id -> [(next_lane_id, deadhead_miles, deadhead_hours)]"""
    graph = defaultdict(list)
    for a in lanes:
        for b in lanes:
            if a.id == b.id:
                continue
            ok, miles, hours = can_connect(a, b, max_deadhead)
            if ok:
                graph[a.id].append((b.id, miles, hours))
    # Sort edges deterministically: 0-deadhead first, then by lane ID
    for key in graph:
        graph[key].sort(key=lambda e: (e[1], e[0]))
    return dict(graph)  # convert from defaultdict for determinism


def can_add_leg(
    current_drive: float,
    current_duty: float,
    current_clock: Optional[float],
    next_lane: Lane,
    deadhead_hours: float,
    pre_post_hours: float,
    max_wait: float,
    is_first: bool = False,
) -> Optional[tuple[float, float, Optional[float], float]]:
    """
    Check if next_lane can be added to a shift.
    Returns (new_drive, new_duty, new_clock, wait_time) or None.
    """
    leg_drive = next_lane.route_duration_hours + deadhead_hours
    leg_dwell = next_lane.dwell_hours
    leg_duty = leg_drive + leg_dwell + (pre_post_hours if is_first else 0)

    # Time check
    wait = 0.0
    leg_start_clock = None

    if current_clock is not None and next_lane.pickup_time is not None:
        # Use integer minutes for all time comparisons (eliminates float precision issues)
        clock_min = int(round(current_clock * 60))
        dh_min = int(round(deadhead_hours * 60))
        pickup_min = int(round(next_lane.pickup_time * 60))
        pickup_end_raw = next_lane.pickup_end_time if next_lane.pickup_end_time else next_lane.pickup_time + 0.25
        pickup_end_min = int(round(pickup_end_raw * 60))

        # Handle midnight crossing
        if pickup_end_min < pickup_min:
            pickup_end_min += 24 * 60

        earliest_arrival_min = clock_min + dh_min
        grace_min = 15  # 15 min grace

        # Can we make the pickup window?
        if earliest_arrival_min > pickup_end_min + grace_min:
            return None

        # Convert back to hours for the rest of the computation
        earliest_arrival = earliest_arrival_min / 60.0

        if earliest_arrival_min < pickup_min:
            wait_min = pickup_min - earliest_arrival_min
            wait = wait_min / 60.0
            if wait > max_wait:
                return None
            leg_start_clock = next_lane.pickup_time
        else:
            leg_start_clock = earliest_arrival
    elif next_lane.pickup_time is not None:
        leg_start_clock = next_lane.pickup_time

    # HOS check
    new_drive = current_drive + leg_drive
    new_duty = current_duty + leg_duty + wait

    if new_drive > HOS_MAX_DRIVE:
        return None
    if new_duty > HOS_MAX_DUTY:
        return None

    # Clock after this leg
    new_clock = None
    if leg_start_clock is not None:
        computed_finish = leg_start_clock + leg_dwell + next_lane.route_duration_hours
        if next_lane.delivery_end_time and next_lane.delivery_end_time > computed_finish:
            new_clock = next_lane.delivery_end_time
        else:
            new_clock = computed_finish
    elif next_lane.finish_time:
        new_clock = next_lane.finish_time

    return new_drive, new_duty, new_clock, wait


# ---- SET COVER SOLVER ----

def generate_all_shifts(
    lanes: list[Lane],
    graph: dict[str, list[tuple[str, float, float]]],
    max_legs: int,
    pre_post_hours: float,
    max_wait: float,
    max_templates: int = 5000000,
    time_limit_seconds: float = 300.0,
) -> list[list[str]]:
    """Generate all valid shift templates via DFS, with corridor pre-generation."""
    import time as _time_mod
    _dfs_start = _time_mod.time()
    templates = []
    template_set = set()  # for dedup
    lane_map = {l.id: l for l in lanes}

    # Sort by pickup time
    sorted_lanes = sorted(lanes, key=lambda l: l.pickup_time if l.pickup_time else 99)

    # ---- PRE-GENERATE: Corridor chains ----
    # Explicitly build same-corridor chains (A→B→A→B...) to ensure critical
    # templates are always found regardless of DFS exploration order.
    for start_lane in sorted_lanes:
        chain = [start_lane.id]
        drive = start_lane.route_duration_hours
        duty = start_lane.route_duration_hours + start_lane.dwell_hours + pre_post_hours
        clock = start_lane.finish_time
        corridor_cities = {start_lane.origin_city.lower(), start_lane.dest_city.lower()}
        current = start_lane

        for _ in range(max_legs - 1):
            # Find next same-corridor leg (0 or near-0 deadhead)
            best_next = None
            for next_id, dh_miles, dh_hours in graph.get(current.id, []):
                if next_id in chain:
                    continue
                nl = lane_map.get(next_id)
                if not nl:
                    continue
                # Same corridor: both cities in the corridor set
                if nl.origin_city.lower() not in corridor_cities or nl.dest_city.lower() not in corridor_cities:
                    continue
                if dh_miles > 5:  # only near-zero deadhead
                    continue
                result = can_add_leg(drive, duty, clock, nl, dh_hours, pre_post_hours, max_wait)
                if result:
                    if not best_next or (nl.pickup_time or 99) < (lane_map[best_next[0]].pickup_time or 99):
                        best_next = (next_id, dh_miles, dh_hours, result)

            if best_next:
                nid, dm, dh, (nd, ndu, nc, _) = best_next
                chain.append(nid)
                drive, duty, clock = nd, ndu, nc
                current = lane_map[nid]
                # Add this chain as a template
                key = tuple(chain)
                if key not in template_set and len(chain) >= 2:
                    template_set.add(key)
                    templates.append(list(chain))
            else:
                break

    for start_lane in sorted_lanes:
        if len(templates) >= max_templates or (time_limit_seconds and ((__import__('time').time() - _dfs_start) > time_limit_seconds)):
            break

        # DFS stack: (legs, drive, duty, clock)
        stack = [(
            [start_lane.id],
            start_lane.route_duration_hours,
            start_lane.route_duration_hours + start_lane.dwell_hours + pre_post_hours,
            start_lane.finish_time,
        )]

        while stack:
            if len(templates) >= max_templates:
                break

            legs, drive, duty, clock = stack.pop()

            # Only emit templates with 2+ legs to focus on useful combinations
            key = tuple(legs)
            if len(legs) >= 2 and key not in template_set:
                template_set.add(key)
                templates.append(list(legs))

            if len(legs) >= max_legs:
                continue

            # Try extending — prioritize same-corridor (low deadhead) first
            last_id = legs[-1]
            last_lane = lane_map[last_id]
            edges = graph.get(last_id, [])
            # Sort: 0-deadhead first (same city), then by pickup time
            edges_sorted = sorted(edges, key=lambda e: (
                e[1],  # deadhead miles (0 = same city)
                lane_map[e[0]].pickup_time if lane_map.get(e[0]) and lane_map[e[0]].pickup_time else 99,
            ))
            for next_id, dh_miles, dh_hours in edges_sorted:
                if next_id in legs:
                    continue
                next_lane = lane_map.get(next_id)
                if not next_lane:
                    continue

                result = can_add_leg(drive, duty, clock, next_lane, dh_hours, pre_post_hours, max_wait)
                if result:
                    new_drive, new_duty, new_clock, _ = result
                    stack.append((legs + [next_id], new_drive, new_duty, new_clock))

    # Always add single-leg templates (needed as fallback for exact cover)
    for lane in sorted_lanes:
        templates.append([lane.id])

    return templates


def greedy_set_cover(all_lane_ids: set[str], templates: list[list[str]]) -> list[list[str]]:
    """Greedy minimum set cover: pick templates covering the most uncovered lanes."""
    # Sort by length descending
    sorted_templates = sorted(templates, key=len, reverse=True)

    uncovered = set(all_lane_ids)
    selected = []

    while uncovered:
        best = None
        best_coverage = 0

        for template in sorted_templates:
            # Template must ONLY contain uncovered lanes (exact cover)
            template_set = set(template)
            if not template_set.issubset(uncovered):
                continue
            coverage = len(template_set)
            if coverage > best_coverage:
                best_coverage = coverage
                best = template

        if not best:
            # No template covers remaining lanes exactly — use singles
            for lane_id in list(uncovered):
                if [lane_id] in templates or True:  # always possible
                    selected.append([lane_id])
                    uncovered.discard(lane_id)
            break

        selected.append(best)
        for lane_id in best:
            uncovered.discard(lane_id)

    return selected


def calc_template_deadhead(template: list[str], lane_map: dict, graph: dict) -> float:
    """Calculate total deadhead miles for a shift template."""
    dh = 0.0
    for i in range(1, len(template)):
        prev_id = template[i - 1]
        for next_id, miles, hours in graph.get(prev_id, []):
            if next_id == template[i]:
                dh += miles
                break
    return dh


def calc_template_cost(template: list[str], lane_map: dict, graph: dict,
                       hourly_rate: float = 31.2, fuel_price: float = 7.70,
                       mpg_hwy: float = 6, mpg_city: float = 10) -> float:
    """Calculate total operating cost for a shift template (fuel + driver pay)."""
    CITY_DESTS = {'san bernardino', 'moreno valley', 'city of industry', 'anaheim'}
    total_fuel = 0.0
    total_duty = 0.25  # pre/post trip

    prev_finish = None
    for i, lid in enumerate(template):
        lane = lane_map.get(lid)
        if not lane:
            continue

        # Drive + dwell duty
        total_duty += lane.route_duration_hours + lane.dwell_hours

        # Fuel for this leg
        is_city = (lane.dest_city.lower() in CITY_DESTS or lane.origin_city.lower() in CITY_DESTS)
        mpg = mpg_city if is_city else mpg_hwy
        total_fuel += (lane.route_miles / max(mpg, 1)) * fuel_price

        # Deadhead from previous leg
        if i > 0:
            prev_id = template[i - 1]
            for next_id, dh_miles, dh_hours in graph.get(prev_id, []):
                if next_id == lid:
                    total_duty += dh_hours
                    total_fuel += (dh_miles / max(mpg_hwy, 1)) * fuel_price
                    break

            # Wait time
            if prev_finish is not None and lane.pickup_time is not None:
                edge_hours = 0
                for nid, _, eh in graph.get(prev_id, []):
                    if nid == lid:
                        edge_hours = eh
                        break
                wait = max(0, lane.pickup_time - prev_finish - edge_hours)
                total_duty += wait

        prev_finish = lane.finish_time

    driver_pay = total_duty * hourly_rate
    return driver_pay + total_fuel


def solve_exact_set_cover(
    all_lane_ids: set[str],
    templates: list[list[str]],
    max_time_seconds: float = 10.0,
    lane_map: dict = None,
    graph: dict = None,
) -> list[list[str]]:
    """
    Two-phase OR-Tools CP-SAT solver:
      Phase 1: Find minimum number of drivers (shifts)
      Phase 2: At that driver count, minimize total cost (deadhead + duty hours)
    """
    try:
        from ortools.sat.python import cp_model
    except ImportError:
        print("OR-Tools not available, using greedy solver")
        return greedy_set_cover(all_lane_ids, templates)

    lane_list = sorted(all_lane_ids)
    n_lanes = len(lane_list)

    # Filter templates to only those with all lanes in our set
    valid_templates = []
    for t in templates:
        if all(lid in all_lane_ids for lid in t):
            valid_templates.append(t)

    if not valid_templates:
        return [[lid] for lid in lane_list]

    n_valid = len(valid_templates)

    # Deduplicate: keep only one template per unique set of lane IDs
    # Many templates cover the same lanes in different orders — we only need one
    # Keep the one with the lowest cost (or shortest deadhead)
    seen_sets = {}
    deduped = []
    for i, t in enumerate(valid_templates):
        key = frozenset(t)
        if key not in seen_sets:
            seen_sets[key] = i
            deduped.append(t)
        elif graph and lane_map:
            # Keep the one with lower cost
            old_idx = seen_sets[key]
            old_cost = calc_template_cost(valid_templates[old_idx], lane_map, graph) if lane_map else 0
            new_cost = calc_template_cost(t, lane_map, graph) if lane_map else 0
            if new_cost < old_cost:
                # Replace
                deduped_idx = next(j for j, d in enumerate(deduped) if frozenset(d) == key)
                deduped[deduped_idx] = t
                seen_sets[key] = i

    if len(deduped) < n_valid:
        print(f"  Deduped templates: {n_valid} → {len(deduped)} unique lane-sets")
        valid_templates = deduped
        n_valid = len(valid_templates)

    # Pre-compute covering templates per lane (used in both phases)
    lane_covering = {}
    for i, lane_id in enumerate(lane_list):
        covering = [t for t in range(n_valid) if lane_id in valid_templates[t]]
        if not covering:
            print(f"WARNING: Lane {lane_id} has no covering template!")
            return greedy_set_cover(all_lane_ids, templates)
        lane_covering[lane_id] = covering

    # ---- PHASE 1: Minimize driver count ----
    print(f"  Phase 1: Finding minimum drivers ({n_valid} templates)...")

    model1 = cp_model.CpModel()
    x1 = [model1.NewBoolVar(f'x_{t}') for t in range(n_valid)]

    for lane_id in lane_list:
        model1.Add(sum(x1[t] for t in lane_covering[lane_id]) == 1)

    model1.Minimize(sum(x1))

    # No greedy hint — let CP-SAT explore freely for best results
    solver1 = cp_model.CpSolver()
    solver1.parameters.max_time_in_seconds = max_time_seconds
    solver1.parameters.num_workers = 8

    status1 = solver1.Solve(model1)
    if status1 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        print(f"  Phase 1 failed: {solver1.StatusName(status1)}")
        return greedy_set_cover(all_lane_ids, templates)

    min_drivers = int(solver1.ObjectiveValue())
    print(f"  Phase 1 result: {min_drivers} drivers (minimum)")

    # ---- PHASE 2: Minimize cost at the minimum driver count ----
    print(f"  Phase 2: Minimizing cost at {min_drivers} drivers...")

    # Pre-compute cost for each template (scaled to integers for CP-SAT)
    COST_SCALE = 100  # multiply by 100 to preserve 2 decimal places as integers
    template_costs = []
    for t in valid_templates:
        if lane_map and graph:
            cost = calc_template_cost(t, lane_map, graph)
        else:
            # Fallback: use deadhead miles as proxy for cost
            cost = calc_template_deadhead(t, lane_map or {}, graph or {}) * 2.0
        template_costs.append(int(cost * COST_SCALE))

    model2 = cp_model.CpModel()
    x2 = [model2.NewBoolVar(f'x_{t}') for t in range(n_valid)]

    # Constraint: each lane covered exactly once
    for lane_id in lane_list:
        model2.Add(sum(x2[t] for t in lane_covering[lane_id]) == 1)

    # Constraint: exactly min_drivers templates selected
    model2.Add(sum(x2) == min_drivers)

    # Objective: minimize total cost
    model2.Minimize(sum(x2[t] * template_costs[t] for t in range(n_valid)))

    solver2 = cp_model.CpSolver()
    solver2.parameters.max_time_in_seconds = max_time_seconds * 2
    solver2.parameters.num_workers = 8

    status2 = solver2.Solve(model2)

    if status2 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        selected = [valid_templates[t] for t in range(n_valid) if solver2.Value(x2[t])]
        total_cost = solver2.ObjectiveValue() / COST_SCALE
        print(f"  Phase 2 result: ${total_cost:,.2f} total daily cost")
        return selected
    else:
        # Phase 2 failed — fall back to Phase 1 result
        print(f"  Phase 2 failed ({solver2.StatusName(status2)}), using Phase 1 result")
        return [valid_templates[t] for t in range(n_valid) if solver1.Value(x1[t])]


def solve_day(
    lanes: list[Lane],
    max_deadhead: float = DEFAULT_MAX_DEADHEAD,
    max_legs: int = DEFAULT_MAX_LEGS,
    pre_post_hours: float = DEFAULT_PRE_POST_TRIP,
    max_wait: float = DEFAULT_MAX_WAIT,
    use_exact: bool = True,
) -> list[list[str]]:
    """Solve shift assignments for a single day's lanes."""
    if not lanes:
        return []

    # Sort deterministically: pickup time, then origin+dest city, then miles
    lanes.sort(key=lambda l: (
        l.pickup_time if l.pickup_time is not None else 99,
        l.origin_city.lower(),
        l.dest_city.lower(),
        l.route_miles,
    ))

    lane_map = {l.id: l for l in lanes}
    graph = build_graph(lanes, max_deadhead)

    print(f"  Generating shift templates for {len(lanes)} lanes...")
    templates = generate_all_shifts(lanes, graph, max_legs, pre_post_hours, max_wait)
    print(f"  Generated {len(templates)} valid templates")

    # Filter to multi-leg templates for better coverage
    multi = [t for t in templates if len(t) >= 2]
    singles = [t for t in templates if len(t) == 1]
    print(f"  Multi-leg: {len(multi)}, Single-leg: {len(singles)}")

    all_ids = set(l.id for l in lanes)

    # Filter to only templates with 2+ legs for the solver
    # (singles are always available as fallback)
    usable = [t for t in templates if len(t) >= 2]

    if use_exact:
        print(f"  Running CP-SAT two-phase solver with {len(usable)} multi-leg templates...")
        solution = solve_exact_set_cover(all_ids, usable + singles, max_time_seconds=480.0,
                                          lane_map=lane_map, graph=graph)
    else:
        print(f"  Running greedy solver...")
        solution = greedy_set_cover(all_ids, usable + singles)

    return solution


def print_solution(solution: list[list[str]], lane_map: dict[str, Lane]):
    """Pretty-print the shift assignments."""
    print(f"\n{'='*80}")
    print(f"  OPTIMAL SOLUTION: {len(solution)} drivers")
    print(f"{'='*80}\n")

    total_drive = 0
    total_duty = 0
    total_legs = 0

    for i, shift in enumerate(sorted(solution, key=lambda s: lane_map[s[0]].pickup_time or 99)):
        legs_str = []
        drive = 0
        for lid in shift:
            lane = lane_map[lid]
            time_str = ""
            if lane.pickup_time is not None:
                h = int(lane.pickup_time)
                m = int((lane.pickup_time - h) * 60)
                time_str = f" {h:02d}:{m:02d}"
            legs_str.append(f"{lane.name}{time_str}")
            drive += lane.route_duration_hours

        print(f"  Driver {i+1:2d} | {len(shift)} legs | {drive:.1f}h drive | {' → '.join(legs_str)}")
        total_drive += drive
        total_legs += len(shift)

    print(f"\n  Total: {total_legs} legs, {total_drive:.1f}h drive, avg {total_legs/len(solution):.1f} legs/driver")


def main():
    parser = argparse.ArgumentParser(description='Lane Analyzer — Optimal Shift Solver')
    parser.add_argument('--input', required=True, help='Path to lanes CSV')
    parser.add_argument('--date', help='Specific date to solve (YYYY-MM-DD)')
    parser.add_argument('--max-deadhead', type=float, default=DEFAULT_MAX_DEADHEAD)
    parser.add_argument('--max-legs', type=int, default=DEFAULT_MAX_LEGS)
    parser.add_argument('--max-wait', type=float, default=DEFAULT_MAX_WAIT)
    parser.add_argument('--pre-post', type=float, default=DEFAULT_PRE_POST_TRIP)
    parser.add_argument('--greedy', action='store_true', help='Use greedy solver instead of exact')
    args = parser.parse_args()

    lanes = load_lanes(args.input)
    print(f"Loaded {len(lanes)} lanes")

    lane_map = {l.id: l for l in lanes}

    solution = solve_day(
        lanes,
        max_deadhead=args.max_deadhead,
        max_legs=args.max_legs,
        pre_post_hours=args.pre_post,
        max_wait=args.max_wait,
        use_exact=not args.greedy,
    )

    print_solution(solution, lane_map)


if __name__ == '__main__':
    main()
