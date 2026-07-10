#!/usr/bin/env python3
"""
Lane Solver — OR-Tools Vehicle Routing Problem (CVRPTW)

No pre-generated templates. The routing solver directly finds the optimal
assignment of lanes to drivers, respecting:
  - HOS (11h drive / 14h duty per shift)
  - Time windows (pickup/delivery appointments)
  - Geography (deadhead between lane endpoints)
  - Max wait between legs
  - Minimize drivers first, then minimize cost

Usage:
  python3 scripts/lane_solver_vrp.py --input scripts/lanes_full.csv
"""

import csv
import sys
import argparse
from math import radians, sin, cos, sqrt, atan2
from typing import Optional
from dataclasses import dataclass, field

# ---- Constants ----
HOS_MAX_DRIVE = 11.0
HOS_MAX_DUTY = 14.0
DEFAULT_MPH = 55.0
DEFAULT_PRE_POST_TRIP = 0.25  # 15 min
DEFAULT_DWELL = 0.25
DEFAULT_MAX_WAIT = 2.0
DEFAULT_MAX_DEADHEAD = 75
DEFAULT_MAX_LEGS = 8
MINUTES_PER_HOUR = 60
# Time horizon: one day in minutes (0:00 to 30:00 = 30 hours to handle midnight crossing)
TIME_HORIZON = 30 * MINUTES_PER_HOUR


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
    pickup_time: Optional[float]  # hours from midnight
    pickup_end_time: Optional[float]
    delivery_time: Optional[float]
    delivery_end_time: Optional[float]
    dwell_hours: float = DEFAULT_DWELL * 2
    active_days: list = field(default_factory=lambda: [1, 2, 3, 4, 5])

    @property
    def finish_time(self) -> Optional[float]:
        if self.delivery_end_time is not None:
            del_end = self.delivery_end_time
            if self.pickup_time is not None and del_end < self.pickup_time:
                del_end += 24.0
            computed = (self.pickup_time + self.dwell_hours + self.route_duration_hours) if self.pickup_time is not None else None
            if computed is not None:
                return max(del_end, computed)
            return del_end
        if self.delivery_time is not None:
            dt = self.delivery_time
            if self.pickup_time is not None and dt < self.pickup_time:
                dt += 24.0
            return dt
        if self.pickup_time is not None:
            return self.pickup_time + self.dwell_hours + self.route_duration_hours
        return None

    @property
    def pickup_minutes(self) -> int:
        if self.pickup_time is None:
            return 0
        return int(self.pickup_time * MINUTES_PER_HOUR)

    @property
    def pickup_end_minutes(self) -> int:
        if self.pickup_end_time is None:
            return self.pickup_minutes + 15  # 15 min default window
        pe = self.pickup_end_time
        if self.pickup_time is not None and pe < self.pickup_time:
            pe += 24.0
        return int(pe * MINUTES_PER_HOUR) + 15  # +15 grace

    @property
    def service_minutes(self) -> int:
        """Total time at this stop: dwell + drive to destination."""
        return int((self.dwell_hours + self.route_duration_hours) * MINUTES_PER_HOUR)

    @property
    def finish_minutes(self) -> int:
        ft = self.finish_time
        if ft is None:
            return self.pickup_minutes + self.service_minutes
        return int(ft * MINUTES_PER_HOUR)


def haversine(lat1, lng1, lat2, lng2) -> float:
    R = 3958.8
    dlat = radians(lat2 - lat1)
    dlng = radians(lng2 - lng1)
    a = sin(dlat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng/2)**2
    return round(R * 2 * atan2(sqrt(a), sqrt(1 - a)), 1)


def parse_time(s: str) -> Optional[float]:
    if not s or s.strip() == '':
        return None
    parts = s.strip().split(':')
    h = int(parts[0])
    m = int(parts[1]) if len(parts) > 1 else 0
    sec = int(parts[2]) if len(parts) > 2 else 0
    return h + m / 60.0 + sec / 3600.0


def load_lanes(csv_path: str) -> list[Lane]:
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
            if lane.name:
                lanes.append(lane)
    return lanes


def lanes_from_json(data: list[dict]) -> list[Lane]:
    """Convert JSON lane objects (from Convex) to Lane instances."""
    lanes = []
    for row in data:
        lane = Lane(
            id=row.get('id', row.get('name', '')),
            name=row.get('name', ''),
            origin_city=row.get('originCity', row.get('origin_city', '')) or '',
            origin_state=row.get('originState', row.get('origin_state', '')) or '',
            origin_lat=row.get('originLat', row.get('origin_lat')),
            origin_lng=row.get('originLng', row.get('origin_lng')),
            dest_city=row.get('destinationCity', row.get('dest_city', '')) or '',
            dest_state=row.get('destinationState', row.get('dest_state', '')) or '',
            dest_lat=row.get('destinationLat', row.get('dest_lat')),
            dest_lng=row.get('destinationLng', row.get('dest_lng')),
            route_miles=float(row.get('routeMiles', row.get('route_miles', 0)) or 0),
            route_duration_hours=float(row.get('routeDurationHours', row.get('route_duration_hours', 0)) or 0),
            pickup_time=parse_time(str(row.get('originScheduledTime', row.get('pickup_time', '')) or '')),
            pickup_end_time=parse_time(str(row.get('originScheduledEndTime', row.get('pickup_end_time', '')) or '')),
            delivery_time=parse_time(str(row.get('destinationScheduledTime', row.get('delivery_time', '')) or '')),
            delivery_end_time=parse_time(str(row.get('destinationScheduledEndTime', row.get('delivery_end_time', '')) or '')),
            dwell_hours=float(row.get('dwell_hours', 0.5)),
        )
        if lane.name or lane.id:
            lanes.append(lane)
    return lanes


def deadhead_between(lane_a: Lane, lane_b: Lane) -> float:
    """Deadhead miles from lane_a's destination to lane_b's origin."""
    if lane_a.dest_lat and lane_a.dest_lng and lane_b.origin_lat and lane_b.origin_lng:
        return haversine(lane_a.dest_lat, lane_a.dest_lng, lane_b.origin_lat, lane_b.origin_lng)
    if (lane_a.dest_city and lane_b.origin_city and
        lane_a.dest_city.lower().strip() == lane_b.origin_city.lower().strip()):
        return 2.0  # same city
    return 999.0


def travel_minutes(miles: float) -> int:
    """Convert miles to travel time in minutes at DEFAULT_MPH."""
    if miles <= 0:
        return 0
    return max(1, int((miles / DEFAULT_MPH) * MINUTES_PER_HOUR))


def solve_vrp(
    lanes: list[Lane],
    max_deadhead: float = DEFAULT_MAX_DEADHEAD,
    max_legs: int = DEFAULT_MAX_LEGS,
    max_wait_hours: float = DEFAULT_MAX_WAIT,
    pre_post_hours: float = DEFAULT_PRE_POST_TRIP,
    max_drivers: int = 0,  # 0 = auto (num lanes)
    solver_time_seconds: int = 120,
) -> dict:
    """
    Solve the lane assignment problem using OR-Tools CVRPTW.

    Model:
    - Each lane is a "node" that must be visited exactly once
    - A "depot" node represents the base (start/end of each vehicle route)
    - Vehicles = drivers, each with HOS capacity
    - Transit time between nodes = deadhead travel + service time at destination
    - Time windows = pickup appointment windows
    - Capacity constraint = max drive hours per vehicle (HOS)
    """
    from ortools.constraint_solver import routing_enums_pb2, pywrapcp

    n = len(lanes)
    if n == 0:
        return {'success': True, 'driverCount': 0, 'shifts': [], 'summary': {}}

    if max_drivers <= 0:
        max_drivers = n  # upper bound: one driver per lane

    # Node 0 = depot (base), nodes 1..n = lanes
    num_nodes = n + 1
    DEPOT = 0

    # ---- Distance/time matrices ----
    # Transit time from node i to node j (in minutes):
    #   depot -> lane: 0 (driver starts fresh)
    #   lane_i -> lane_j: deadhead travel time + service time at lane_j
    #   lane -> depot: 0 (driver returns, not counted)

    # Build transit time callback
    lane_by_node = {0: None}  # depot
    for i, lane in enumerate(lanes):
        lane_by_node[i + 1] = lane

    # Pre-compute deadhead matrix
    dh_matrix = {}
    for i in range(n):
        for j in range(n):
            if i == j:
                dh_matrix[(i, j)] = 999.0  # can't go to self
            else:
                dh = deadhead_between(lanes[i], lanes[j])
                dh_matrix[(i, j)] = dh if dh <= max_deadhead else 999.0

    max_wait_min = int(max_wait_hours * MINUTES_PER_HOUR)

    def transit_time(from_index, to_index):
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)

        if from_node == DEPOT:
            # Depot to lane: pre-trip time
            return int(pre_post_hours * MINUTES_PER_HOUR)
        if to_node == DEPOT:
            # Lane to depot: 0 (shift ends)
            return 0

        lane_from = lanes[from_node - 1]
        lane_to = lanes[to_node - 1]

        # Deadhead travel
        dh = dh_matrix.get((from_node - 1, to_node - 1), 999.0)
        if dh > max_deadhead:
            return TIME_HORIZON  # effectively infinite — blocks this arc

        dh_min = travel_minutes(dh)

        # Service time at destination = dwell + drive duration of the TO lane
        service = lane_to.service_minutes

        return dh_min + service

    def drive_time(from_index, to_index):
        """Drive hours dimension: only counts actual driving (no dwell/wait)."""
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)

        if to_node == DEPOT:
            return 0

        lane_to = lanes[to_node - 1]

        if from_node == DEPOT:
            # First lane's drive time
            return int(lane_to.route_duration_hours * MINUTES_PER_HOUR)

        dh = dh_matrix.get((from_node - 1, to_node - 1), 999.0)
        if dh > max_deadhead:
            return int(HOS_MAX_DRIVE * MINUTES_PER_HOUR * 2)  # block

        dh_drive_min = travel_minutes(dh)
        lane_drive_min = int(lane_to.route_duration_hours * MINUTES_PER_HOUR)

        return dh_drive_min + lane_drive_min

    # ---- Create routing model ----
    manager = pywrapcp.RoutingIndexManager(num_nodes, max_drivers, DEPOT)
    routing = pywrapcp.RoutingModel(manager)

    # Transit time callback
    transit_callback_index = routing.RegisterTransitCallback(transit_time)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

    # ---- Dimension: Time (clock time for time windows) ----
    # This tracks the absolute clock time (minutes from midnight).
    # NOT the same as duty hours — duty is tracked implicitly by the transit callback.
    routing.AddDimension(
        transit_callback_index,
        max_wait_min,       # max waiting time at each node
        TIME_HORIZON,       # max cumulative time (30h horizon)
        False,              # don't force start cumulative to zero
        'Time',
    )
    time_dimension = routing.GetDimensionOrDie('Time')

    # ---- Dimension: Duty hours (HOS 14h limit) ----
    # Separate from clock time — tracks actual on-duty duration
    def duty_callback(from_index, to_index):
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        if to_node == DEPOT:
            return 0
        lane_to = lanes[to_node - 1]
        if from_node == DEPOT:
            # Pre-trip + first lane's service
            return int(pre_post_hours * MINUTES_PER_HOUR) + lane_to.service_minutes
        dh = dh_matrix.get((from_node - 1, to_node - 1), 999.0)
        if dh > max_deadhead:
            return int(HOS_MAX_DUTY * MINUTES_PER_HOUR * 2)
        dh_min = travel_minutes(dh)
        service = lane_to.service_minutes
        return dh_min + service

    duty_callback_index = routing.RegisterTransitCallback(duty_callback)
    duty_limit_min = int(HOS_MAX_DUTY * MINUTES_PER_HOUR)
    routing.AddDimension(
        duty_callback_index,
        max_wait_min,       # waiting counts as on-duty
        duty_limit_min,     # 14h max
        True,               # start at 0
        'Duty',
    )

    # ---- Dimension: Drive hours ----
    drive_callback_index = routing.RegisterTransitCallback(drive_time)
    drive_limit_min = int(HOS_MAX_DRIVE * MINUTES_PER_HOUR)
    routing.AddDimension(
        drive_callback_index,
        0,                  # no slack for drive hours
        drive_limit_min,    # max 11h driving
        True,               # start at 0
        'DriveTime',
    )

    # ---- Dimension: Leg count ----
    def leg_count_callback(from_index, to_index):
        to_node = manager.IndexToNode(to_index)
        return 0 if to_node == DEPOT else 1

    leg_callback_index = routing.RegisterTransitCallback(leg_count_callback)
    routing.AddDimension(
        leg_callback_index,
        0,
        max_legs,
        True,
        'LegCount',
    )

    # ---- Time windows for each lane ----
    for i, lane in enumerate(lanes):
        node = i + 1
        index = manager.NodeToIndex(node)

        # Pickup window
        tw_start = lane.pickup_minutes
        tw_end = lane.pickup_end_minutes

        # Clamp to time horizon
        tw_start = max(0, min(tw_start, TIME_HORIZON))
        tw_end = max(tw_start, min(tw_end, TIME_HORIZON))

        time_dimension.CumulVar(index).SetRange(tw_start, tw_end)

    # Depot time windows (full day)
    for v in range(max_drivers):
        start_index = routing.Start(v)
        end_index = routing.End(v)
        time_dimension.CumulVar(start_index).SetRange(0, TIME_HORIZON)
        time_dimension.CumulVar(end_index).SetRange(0, TIME_HORIZON)

    # ---- Minimize vehicles used ----
    # Add a fixed cost per vehicle to encourage using fewer vehicles
    for v in range(max_drivers):
        routing.SetFixedCostOfVehicle(10000, v)

    # ---- Solve ----
    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    )
    search_parameters.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    search_parameters.time_limit.FromSeconds(solver_time_seconds)
    search_parameters.log_search = False

    print(f"  Solving VRP with {n} lanes, up to {max_drivers} drivers...")
    solution = routing.SolveWithParameters(search_parameters)

    if not solution:
        print(f"  VRP solver failed! Status: {routing.status()}")
        return {'success': False, 'error': f'Solver status: {routing.status()}'}

    # ---- Extract solution ----
    shifts = []
    total_cost = 0
    active_drivers = 0

    CITY_DESTS = {'san bernardino', 'moreno valley', 'city of industry', 'anaheim'}

    for v in range(max_drivers):
        index = routing.Start(v)
        route_lanes = []

        while not routing.IsEnd(index):
            node = manager.IndexToNode(index)
            if node != DEPOT:
                route_lanes.append(lanes[node - 1])
            index = solution.Value(routing.NextVar(index))

        if not route_lanes:
            continue  # empty vehicle

        active_drivers += 1

        # Calculate shift metrics
        shift_drive = 0
        shift_duty = pre_post_hours
        shift_miles = 0
        shift_dh = 0
        shift_fuel = 0
        legs_detail = []

        for i, lane in enumerate(route_lanes):
            shift_drive += lane.route_duration_hours
            shift_duty += lane.route_duration_hours + lane.dwell_hours
            shift_miles += lane.route_miles

            is_city = lane.dest_city.lower() in CITY_DESTS or lane.origin_city.lower() in CITY_DESTS
            mpg = 10 if is_city else 6
            shift_fuel += (lane.route_miles / max(mpg, 1)) * 7.70

            dh_miles = 0
            dh_hours = 0
            wait_hours = 0

            if i > 0:
                prev = route_lanes[i - 1]
                dh_miles = deadhead_between(prev, lane)
                if dh_miles > max_deadhead:
                    dh_miles = 0
                dh_hours = dh_miles / DEFAULT_MPH
                shift_drive += dh_hours
                shift_duty += dh_hours
                shift_miles += dh_miles
                shift_dh += dh_miles
                shift_fuel += (dh_miles / 6) * 7.70

                if prev.finish_time and lane.pickup_time:
                    wait_hours = max(0, lane.pickup_time - prev.finish_time - dh_hours)
                    shift_duty += wait_hours

            legs_detail.append({
                'laneId': lane.id,
                'name': lane.name,
                'originCity': lane.origin_city,
                'destCity': lane.dest_city,
                'driveHours': round(lane.route_duration_hours, 2),
                'miles': round(lane.route_miles, 1),
                'pickupTime': f"{int(lane.pickup_time)}:{int((lane.pickup_time % 1) * 60):02d}" if lane.pickup_time else None,
                'deadheadMiles': round(dh_miles, 1),
                'waitHours': round(wait_hours, 2),
            })

        hourly_rate = 31.2
        driver_pay = shift_duty * hourly_rate
        shift_cost = shift_fuel + driver_pay

        shifts.append({
            'legs': [l.id for l in route_lanes],
            'legDetails': legs_detail,
            'legCount': len(route_lanes),
            'driveHours': round(shift_drive, 1),
            'dutyHours': round(shift_duty, 1),
            'miles': round(shift_miles),
            'deadheadMiles': round(shift_dh),
            'fuelCost': round(shift_fuel, 2),
            'driverPay': round(driver_pay, 2),
            'totalCost': round(shift_cost, 2),
        })
        total_cost += shift_cost

    # Sort by first leg pickup time
    shifts.sort(key=lambda s: lanes_from_id(s['legs'][0], lanes).pickup_time or 99)

    total_drive = sum(s['driveHours'] for s in shifts)
    total_duty = sum(s['dutyHours'] for s in shifts)
    total_miles = sum(s['miles'] for s in shifts)
    total_dh = sum(s['deadheadMiles'] for s in shifts)

    print(f"  VRP result: {active_drivers} drivers, ${total_cost:,.2f}/day, {total_dh:.0f}mi DH")

    return {
        'success': True,
        'driverCount': active_drivers,
        'shifts': shifts,
        'summary': {
            'totalCost': round(total_cost, 2),
            'totalDriveHours': round(total_drive, 1),
            'totalDutyHours': round(total_duty, 1),
            'totalMiles': round(total_miles),
            'totalDeadheadMiles': round(total_dh),
            'avgLegsPerDriver': round(sum(s['legCount'] for s in shifts) / max(active_drivers, 1), 1),
        },
    }


def lanes_from_id(lid: str, lanes: list[Lane]) -> Lane:
    for l in lanes:
        if l.id == lid:
            return l
    return lanes[0]


def print_solution(result: dict, lanes: list[Lane]):
    lm = {l.id: l for l in lanes}
    print(f"\n{'='*80}")
    print(f"  OPTIMAL SOLUTION: {result['driverCount']} drivers | ${result['summary']['totalCost']:,.2f}/day | {result['summary']['totalDeadheadMiles']}mi DH")
    print(f"{'='*80}\n")

    for i, s in enumerate(result['shifts']):
        names = [lm[lid].name if lid in lm else lid for lid in s['legs']]
        times = []
        for lid in s['legs']:
            l = lm.get(lid)
            if l and l.pickup_time:
                h = int(l.pickup_time)
                m = int((l.pickup_time - h) * 60)
                times.append(f"{h:02d}:{m:02d}")
            else:
                times.append("??:??")

        legs_str = ' → '.join(f"{n} {t}" for n, t in zip(names, times))
        print(f"  Driver {i+1:2d} | {s['legCount']} legs | {s['driveHours']:.1f}h drv | {s['dutyHours']:.1f}h duty | ${s['totalCost']:,.0f} | {legs_str}")

    s = result['summary']
    print(f"\n  Total: {sum(x['legCount'] for x in result['shifts'])} legs | {s['totalDriveHours']:.1f}h drive | ${s['totalCost']:,.2f}/day | {s['totalDeadheadMiles']}mi DH")


def main():
    parser = argparse.ArgumentParser(description='Lane Solver — VRP')
    parser.add_argument('--input', required=True, help='Path to lanes CSV')
    parser.add_argument('--max-deadhead', type=float, default=DEFAULT_MAX_DEADHEAD)
    parser.add_argument('--max-legs', type=int, default=DEFAULT_MAX_LEGS)
    parser.add_argument('--max-wait', type=float, default=DEFAULT_MAX_WAIT)
    parser.add_argument('--pre-post', type=float, default=DEFAULT_PRE_POST_TRIP)
    parser.add_argument('--time-limit', type=int, default=120, help='Solver time limit in seconds')
    parser.add_argument('--max-drivers', type=int, default=0, help='Max drivers (0=auto)')
    args = parser.parse_args()

    lanes = load_lanes(args.input)
    print(f"Loaded {len(lanes)} lanes")

    result = solve_vrp(
        lanes,
        max_deadhead=args.max_deadhead,
        max_legs=args.max_legs,
        max_wait_hours=args.max_wait,
        pre_post_hours=args.pre_post,
        max_drivers=args.max_drivers,
        solver_time_seconds=args.time_limit,
    )

    if result['success']:
        print_solution(result, lanes)
    else:
        print(f"FAILED: {result.get('error', 'unknown')}")


if __name__ == '__main__':
    main()
