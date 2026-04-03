#!/usr/bin/env python3
"""
Lane Solver API — HTTP wrapper for the OR-Tools solver.
Deploy to Google Cloud Run, Railway, or run locally.

Usage:
  # Local dev:
  python3 scripts/solver_api.py

  # Then from Convex or curl:
  curl -X POST http://localhost:8080/solve \
    -H "Content-Type: application/json" \
    -d '{"lanes": [...], "config": {"max_wait": 2, "max_legs": 8}}'
"""

import json
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Any

# Add parent dir to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lane_solver import (
    Lane, build_graph, generate_all_shifts, solve_exact_set_cover,
    can_connect, calc_template_cost, DEFAULT_MAX_DEADHEAD, DEFAULT_MAX_LEGS,
    DEFAULT_MAX_WAIT, DEFAULT_PRE_POST_TRIP, parse_time,
)


def _safe_float(value, field_name: str, lane_id: str) -> float:
    """Convert a value to float, raising ValueError with a clear message on failure."""
    if value is None:
        return 0.0
    try:
        return float(value)
    except (ValueError, TypeError):
        raise ValueError(f"Lane '{lane_id}': invalid numeric value for {field_name}: {value!r}")


def validate_request_body(body: Any) -> list[dict]:
    """Validate the top-level request body shape. Returns the lanes list.

    Raises ValueError with a descriptive message if the body is malformed.
    """
    if not isinstance(body, dict):
        raise ValueError("Request body must be a JSON object")
    lanes = body.get('lanes')
    if lanes is None:
        raise ValueError("Request body must contain a 'lanes' key")
    if not isinstance(lanes, list):
        raise ValueError("'lanes' must be a list")
    bad = [i for i, item in enumerate(lanes) if not isinstance(item, dict)]
    if bad:
        raise ValueError(f"'lanes' entries at indices {bad} are not objects")
    return lanes


def lanes_from_json(data: list[dict]) -> list[Lane]:
    """Convert JSON lane objects to Lane dataclass instances.

    Raises ValueError if required fields are missing or numeric fields are invalid.
    Required fields (checked by accepted aliases):
      - id or name
      - originCity or origin_city
      - destinationCity or dest_city
    """
    missing = []
    for i, row in enumerate(data):
        lane_id = row.get('id') or row.get('name') or ''
        problems = []
        if not row.get('id') and not row.get('name'):
            problems.append('id/name')
        if not row.get('originCity') and not row.get('origin_city'):
            problems.append('originCity/origin_city')
        if not row.get('destinationCity') and not row.get('dest_city'):
            problems.append('destinationCity/dest_city')
        if problems:
            missing.append(f"  lane[{i}] (id={lane_id!r}): missing {', '.join(problems)}")

    if missing:
        raise ValueError("Lanes missing required fields:\n" + "\n".join(missing))

    lanes = []
    for row in data:
        lane_id = row.get('id', row.get('name', ''))
        lane = Lane(
            id=lane_id,
            name=row.get('name', ''),
            origin_city=row.get('originCity', row.get('origin_city', '')),
            origin_state=row.get('originState', row.get('origin_state', '')),
            origin_lat=row.get('originLat', row.get('origin_lat')),
            origin_lng=row.get('originLng', row.get('origin_lng')),
            dest_city=row.get('destinationCity', row.get('dest_city', '')),
            dest_state=row.get('destinationState', row.get('dest_state', '')),
            dest_lat=row.get('destinationLat', row.get('dest_lat')),
            dest_lng=row.get('destinationLng', row.get('dest_lng')),
            route_miles=_safe_float(row.get('routeMiles', row.get('route_miles', 0)) or 0, 'routeMiles', lane_id),
            route_duration_hours=_safe_float(row.get('routeDurationHours', row.get('route_duration_hours', 0)) or 0, 'routeDurationHours', lane_id),
            pickup_time=parse_time(row.get('originScheduledTime', row.get('pickup_time', ''))),
            pickup_end_time=parse_time(row.get('originScheduledEndTime', row.get('pickup_end_time', ''))),
            delivery_time=parse_time(row.get('destinationScheduledTime', row.get('delivery_time', ''))),
            delivery_end_time=parse_time(row.get('destinationScheduledEndTime', row.get('delivery_end_time', ''))),
            dwell_hours=_safe_float(row.get('dwell_hours', 0.5), 'dwell_hours', lane_id),
        )
        lanes.append(lane)
    return lanes


def solve(lanes: list[Lane], config: dict) -> dict:
    """Run the solver and return results."""
    max_deadhead = config.get('max_deadhead', DEFAULT_MAX_DEADHEAD)
    max_legs = config.get('max_legs', DEFAULT_MAX_LEGS)
    max_wait = config.get('max_wait', DEFAULT_MAX_WAIT)
    pre_post = config.get('pre_post_hours', DEFAULT_PRE_POST_TRIP)
    hourly_rate = config.get('hourly_rate', 31.2)
    fuel_price = config.get('fuel_price', 7.70)
    mpg_hwy = config.get('mpg_hwy', 6)
    mpg_city = config.get('mpg_city', 10)

    # Sort lanes deterministically: by pickup time, then origin+dest city
    # This ensures the DFS explores the same paths on any platform
    lanes.sort(key=lambda l: (
        l.pickup_time if l.pickup_time is not None else 99,
        l.origin_city.lower(),
        l.dest_city.lower(),
        l.route_miles,
    ))

    lane_map = {l.id: l for l in lanes}
    graph = build_graph(lanes, max_deadhead)

    # Generate templates
    templates = generate_all_shifts(lanes, graph, max_legs, pre_post, max_wait)

    all_ids = set(l.id for l in lanes)
    usable = [t for t in templates if len(t) >= 2]
    singles = [t for t in templates if len(t) == 1]

    # Run two-phase solver
    solution = solve_exact_set_cover(
        all_ids, usable + singles,
        max_time_seconds=300.0,
        lane_map=lane_map,
        graph=graph,
    )

    # Build response
    shifts = []
    total_cost = 0
    total_drive = 0
    total_duty = 0
    total_miles = 0
    total_dh = 0

    for template in solution:
        shift_drive = 0
        shift_duty = pre_post
        shift_miles = 0
        shift_dh = 0
        shift_fuel = 0
        legs_detail = []

        CITY_DESTS = {'san bernardino', 'moreno valley', 'city of industry', 'anaheim'}

        for i, lid in enumerate(template):
            lane = lane_map.get(lid)
            if not lane:
                continue

            shift_drive += lane.route_duration_hours
            shift_duty += lane.route_duration_hours + lane.dwell_hours
            shift_miles += lane.route_miles

            is_city = lane.dest_city.lower() in CITY_DESTS or lane.origin_city.lower() in CITY_DESTS
            mpg = mpg_city if is_city else mpg_hwy
            shift_fuel += (lane.route_miles / max(mpg, 1)) * fuel_price

            dh_miles = 0
            dh_hours = 0
            wait_hours = 0

            if i > 0:
                prev_id = template[i - 1]
                for nid, dm, dh in graph.get(prev_id, []):
                    if nid == lid:
                        dh_miles = dm
                        dh_hours = dh
                        break
                shift_drive += dh_hours
                shift_duty += dh_hours
                shift_miles += dh_miles
                shift_dh += dh_miles
                shift_fuel += (dh_miles / max(mpg_hwy, 1)) * fuel_price

                prev_lane = lane_map[prev_id]
                if prev_lane.finish_time and lane.pickup_time:
                    wait_hours = max(0, lane.pickup_time - prev_lane.finish_time - dh_hours)
                    shift_duty += wait_hours

            legs_detail.append({
                'laneId': lid,
                'name': lane.name,
                'originCity': lane.origin_city,
                'destCity': lane.dest_city,
                'driveHours': round(lane.route_duration_hours, 2),
                'miles': round(lane.route_miles, 1),
                'pickupTime': f"{int(lane.pickup_time)}:{int((lane.pickup_time % 1) * 60):02d}" if lane.pickup_time else None,
                'deadheadMiles': round(dh_miles, 1),
                'waitHours': round(wait_hours, 2),
            })

        driver_pay = shift_duty * hourly_rate
        shift_cost = shift_fuel + driver_pay

        shifts.append({
            'legs': [lid for lid in template],
            'legDetails': legs_detail,
            'legCount': len(template),
            'driveHours': round(shift_drive, 1),
            'dutyHours': round(shift_duty, 1),
            'miles': round(shift_miles),
            'deadheadMiles': round(shift_dh),
            'fuelCost': round(shift_fuel, 2),
            'driverPay': round(driver_pay, 2),
            'totalCost': round(shift_cost, 2),
        })

        total_cost += shift_cost
        total_drive += shift_drive
        total_duty += shift_duty
        total_miles += shift_miles
        total_dh += shift_dh

    # Sort by first leg pickup time
    shifts.sort(key=lambda s: lane_map[s['legs'][0]].pickup_time or 99)

    return {
        'success': True,
        'driverCount': len(shifts),
        'shifts': shifts,
        'summary': {
            'totalCost': round(total_cost, 2),
            'totalDriveHours': round(total_drive, 1),
            'totalDutyHours': round(total_duty, 1),
            'totalMiles': round(total_miles),
            'totalDeadheadMiles': round(total_dh),
            'avgLegsPerDriver': round(sum(len(s['legs']) for s in shifts) / max(len(shifts), 1), 1),
            'templateCount': len(templates),
        },
    }


def solve_weekly_endpoint(entries, config):
    """Run the V4 weekly solver with 10h off-duty."""
    from weekly_solver_v4 import solve_weekly_v4
    import io, contextlib

    # Capture stdout from the solver
    f = io.StringIO()
    with contextlib.redirect_stdout(f):
        result = solve_weekly_v4(entries, config)

    log = f.getvalue()
    return result, log


class SolverHandler(BaseHTTPRequestHandler):

    def _send_json(self, status: int, data: dict):
        """Send a JSON response with CORS headers."""
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _read_json_body(self) -> Any:
        """Read and parse the JSON request body.

        Raises json.JSONDecodeError on malformed JSON.
        """
        content_length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(content_length)
        return json.loads(raw)

    def do_POST(self):
        if self.path == '/solve':
            try:
                body = self._read_json_body()
            except (json.JSONDecodeError, ValueError) as e:
                self._send_json(400, {'success': False, 'error': f'Malformed JSON: {e}'})
                return

            try:
                lanes_data = body.get('lanes', [])
                config = body.get('config', {})
                lanes = lanes_from_json(lanes_data)
                result = solve(lanes, config)
                self._send_json(200, result)
            except ValueError as e:
                self._send_json(400, {'success': False, 'error': str(e)})
            except Exception as e:
                self._send_json(500, {'success': False, 'error': str(e)})

        elif self.path == '/solve-weekly':
            try:
                body = self._read_json_body()
            except (json.JSONDecodeError, ValueError) as e:
                self._send_json(400, {'success': False, 'error': f'Malformed JSON: {e}'})
                return

            try:
                lanes_data = validate_request_body(body)
                config = body.get('config', {})
                n_drivers = config.get('target_drivers') or None

                # Validate lane fields before passing to solver
                lanes_from_json(lanes_data)

                from weekly_solver_v4 import solve_weekly_v4_api
                result = solve_weekly_v4_api(lanes_data, config, n_drivers)
                self._send_json(200, result)
            except ValueError as e:
                self._send_json(400, {'success': False, 'error': str(e)})
            except Exception as e:
                self._send_json(500, {'success': False, 'error': str(e)})

        elif self.path == '/health':
            self._send_json(200, {'status': 'ok'})
        else:
            self._send_json(404, {'success': False, 'error': 'Not found'})

    def do_GET(self):
        if self.path == '/health':
            self._send_json(200, {'status': 'ok'})
        else:
            self._send_json(404, {'success': False, 'error': 'Not found'})

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, format, *args):
        print(f"[solver] {args[0]}")


def main():
    port = int(os.environ.get('PORT', 8080))
    server = HTTPServer(('0.0.0.0', port), SolverHandler)
    print(f"Lane Solver API running on port {port}")
    print(f"  POST /solve   — run the optimizer")
    print(f"  GET  /health  — health check")
    server.serve_forever()


if __name__ == '__main__':
    main()
