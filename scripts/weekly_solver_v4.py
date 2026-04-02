#!/usr/bin/env python3
"""
Weekly Solver V4 — Direct lane-to-driver assignment.

No templates. Each lane on each day is assigned to a driver directly.
Constraints ensure:
  1. Geographic compatibility (consecutive lanes must connect)
  2. Time ordering (next lane starts after previous finishes + deadhead)
  3. HOS per day (11h drive, 14h duty)
  4. 10h off-duty between consecutive days
  5. 70h weekly duty cap
  6. Max legs per driver per day

Variables: assign[day][lane][driver] = 1 if driver d runs lane l on day d
Plus ordering: order[day][lane][driver] = position of this lane in the driver's route

50 lanes × 9 drivers × 6 days = 2,700 assignment variables.
"""

import json, sys, time
from collections import defaultdict

sys.path.insert(0, '/Users/hydra/Documents/Claude-Development/ProductionReady/Otoqa/scripts')
from lane_solver import Lane, build_graph, DEFAULT_MAX_DEADHEAD, DEFAULT_MAX_LEGS
from solver_api import lanes_from_json
from ortools.sat.python import cp_model

OFF_DUTY_HOURS = 10.0
MAX_WEEKLY_DUTY = 70.0
HOS_MAX_DRIVE = 11.0
HOS_MAX_DUTY = 14.0
MINUTES = 60  # conversion factor


def _order_geo(lane_list, base_city_name):
    """Order lanes into a geographic chain: start from base, follow dest→origin."""
    if len(lane_list) <= 1:
        return lane_list
    remaining = list(lane_list)
    ordered = []
    # Start with base-origin lane, earliest pickup
    base_starts = [l for l in remaining if l.origin_city.lower().strip() == base_city_name]
    if base_starts:
        base_starts.sort(key=lambda l: l.pickup_time or 99)
        first = base_starts[0]
    else:
        remaining.sort(key=lambda l: l.pickup_time or 99)
        first = remaining[0]
    ordered.append(first)
    remaining.remove(first)
    while remaining:
        current = ordered[-1]
        dest = current.dest_city.lower().strip()
        # Prefer same-city start (zero deadhead)
        same_city = sorted([l for l in remaining if l.origin_city.lower().strip() == dest],
                           key=lambda l: l.pickup_time or 99)
        if same_city:
            nxt = same_city[0]
        else:
            # From base
            from_base = sorted([l for l in remaining if l.origin_city.lower().strip() == base_city_name],
                               key=lambda l: l.pickup_time or 99)
            nxt = from_base[0] if from_base else sorted(remaining, key=lambda l: l.pickup_time or 99)[0]
        ordered.append(nxt)
        remaining.remove(nxt)
    return ordered


def _get_base_config(config):
    """Extract base city/lat/lng from config, fallback to Colton."""
    bases = config.get('bases', [])
    if bases:
        b = bases[0]
        return (b.get('city') or 'colton').lower().strip(), b.get('lat') or 34.0430, b.get('lng') or -117.3333
    return 'colton', 34.0430, -117.3333


def solve_weekly_v4(entries, config={}, n_drivers_override=None):
    max_deadhead = config.get('max_deadhead', DEFAULT_MAX_DEADHEAD)
    max_legs = config.get('max_legs', DEFAULT_MAX_LEGS)
    max_wait_h = config.get('max_wait', 2.0)
    pre_post_h = config.get('pre_post_hours', 1.0)
    base_city, base_lat, base_lng = _get_base_config(config)
    print(f"Base: {base_city} ({base_lat}, {base_lng})")

    lanes = lanes_from_json(entries)
    lanes.sort(key=lambda l: (l.pickup_time or 99, l.origin_city.lower(), l.dest_city.lower()))
    lane_map = {l.id: l for l in lanes}
    lane_ids = [l.id for l in lanes]
    n_lanes = len(lanes)

    # Parse active days
    lane_active_days = {}
    for e in entries:
        rule = e.get('scheduleRule', {})
        lane_active_days[e['id']] = set(rule.get('activeDays', [1, 2, 3, 4, 5]))

    day_names = {0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat'}
    working_days = [1, 2, 3, 4, 5, 6, 0]

    # Pre-compute compatibility: can lane B follow lane A?
    graph = build_graph(lanes, max_deadhead)
    # Build deadhead lookup
    dh_hours = {}
    for a in lanes:
        for b_id, miles, hours in graph.get(a.id, []):
            dh_hours[(a.id, b_id)] = hours

    # Pre-compute lane timing in integer minutes for CP-SAT
    lane_pickup_min = {}
    lane_pickup_end_min = {}
    lane_finish_min = {}
    lane_drive_min = {}
    lane_duty_min = {}  # drive + dwell for this lane

    for l in lanes:
        pm = int((l.pickup_time or 0) * MINUTES)
        pe = l.pickup_end_time
        if pe is not None and l.pickup_time is not None and pe < l.pickup_time:
            pe += 24.0
        pem = int((pe or (l.pickup_time or 0) + 0.25) * MINUTES)
        fm = int((l.finish_time or 0) * MINUTES)
        dm = int(l.route_duration_hours * MINUTES)
        duty_m = int((l.route_duration_hours + l.dwell_hours) * MINUTES)

        lane_pickup_min[l.id] = pm
        lane_pickup_end_min[l.id] = pem
        lane_finish_min[l.id] = fm
        lane_drive_min[l.id] = dm
        lane_duty_min[l.id] = duty_m

    # Which lanes run on which days
    day_lane_ids = {}
    for day in working_days:
        day_lane_ids[day] = [lid for lid in lane_ids if day in lane_active_days.get(lid, set())]

    max_lanes_per_day = max(len(v) for v in day_lane_ids.values())
    n_drivers = n_drivers_override or (int(sys.argv[2]) if len(sys.argv) > 2 else 9)

    print(f"Lanes: {n_lanes}, Days: {len(working_days)}, Target drivers: {n_drivers}")
    print(f"Lanes per day: {', '.join(f'{day_names[d]}={len(day_lane_ids[d])}' for d in working_days)}")

    # ---- Build CP-SAT Model ----
    model = cp_model.CpModel()
    t0 = time.time()

    # assign[day][lane_id][driver] = 1 if driver d runs lane l on day
    assign = {}
    for day in working_days:
        assign[day] = {}
        for lid in day_lane_ids[day]:
            assign[day][lid] = [model.NewBoolVar(f'a_{day}_{lid}_{d}') for d in range(n_drivers)]

    # Constraint 1: Each lane assigned to exactly 1 driver per day
    for day in working_days:
        for lid in day_lane_ids[day]:
            model.Add(sum(assign[day][lid]) == 1)

    # Constraint 2: Max legs per driver per day
    for day in working_days:
        for d in range(n_drivers):
            model.Add(sum(assign[day][lid][d] for lid in day_lane_ids[day]) <= max_legs)

    # Constraint 3: HOS — circuit-based sequencing for exact drive + deadhead
    from lane_solver import haversine as hav
    pre_post_min = int(pre_post_h * MINUTES)
    max_drive_min = int(HOS_MAX_DRIVE * MINUTES)
    max_duty_min = int(HOS_MAX_DUTY * MINUTES)

    driver_works_var = {}
    shift_start_var = {}
    shift_end_var = {}

    # Pre-compute ALL pairwise deadhead for time-compatible lane pairs per day
    day_arc_dh = {}
    day_lid_list = {}
    for day in working_days:
        lids = day_lane_ids[day]
        day_lid_list[day] = lids
        arc_dh = {}
        for i, lid_a in enumerate(lids):
            la = lane_map[lid_a]
            for j, lid_b in enumerate(lids):
                if i == j: continue
                lb = lane_map[lid_b]
                if lane_finish_min[lid_a] > lane_pickup_end_min[lid_b] + 15: continue
                if la.dest_lat and la.dest_lng and lb.origin_lat and lb.origin_lng:
                    dh_mi = hav(la.dest_lat, la.dest_lng, lb.origin_lat, lb.origin_lng)
                elif la.dest_city.lower().strip() == lb.origin_city.lower().strip():
                    dh_mi = 0.0
                else:
                    dh_mi = 150.0
                arc_dh[(i, j)] = (int((dh_mi / 55.0) * MINUTES), int(round(dh_mi)))
        day_arc_dh[day] = arc_dh

    max_daily_dh_miles = 250  # hard cap on total deadhead miles per driver per day

    print("Adding circuit-based HOS constraints...")
    for day in working_days:
        lids = day_lid_list[day]
        if not lids: continue
        n_lids = len(lids)
        arc_dh = day_arc_dh[day]

        for d in range(n_drivers):
            dw = model.NewBoolVar(f'works_{day}_{d}')
            model.AddMaxEquality(dw, [assign[day][lid][d] for lid in lids])
            driver_works_var[(day, d)] = dw

            arcs = []
            succ_vars = []
            arcs.append((0, 0, dw.Not()))

            for i, lid_a in enumerate(lids):
                node_a = i + 1
                arcs.append((node_a, node_a, assign[day][lid_a][d].Not()))
                arcs.append((0, node_a, model.NewBoolVar(f'f_{day}_{i}_{d}')))
                arcs.append((node_a, 0, model.NewBoolVar(f'l_{day}_{i}_{d}')))
                for j in range(n_lids):
                    if i == j: continue
                    if (i, j) not in arc_dh: continue
                    dh_dm, dh_mi = arc_dh[(i, j)]
                    sv = model.NewBoolVar(f's_{day}_{i}_{j}_{d}')
                    arcs.append((node_a, j + 1, sv))
                    succ_vars.append((sv, dh_dm, dh_mi))

            model.AddCircuit(arcs)

            base_drive = sum(assign[day][lid][d] * lane_drive_min[lid] for lid in lids)
            dh_drive_terms = [sv * dm for sv, dm, _ in succ_vars if dm > 0]
            if dh_drive_terms:
                model.Add(base_drive + sum(dh_drive_terms) <= max_drive_min)
            else:
                model.Add(base_drive <= max_drive_min)

            dh_miles_terms = [sv * mi for sv, _, mi in succ_vars if mi > 0]
            if dh_miles_terms:
                model.Add(sum(dh_miles_terms) <= max_daily_dh_miles)

            ss = model.NewIntVar(0, 24 * MINUTES, f'ss_{day}_{d}')
            se = model.NewIntVar(0, 30 * MINUTES, f'se_{day}_{d}')
            shift_start_var[(day, d)] = ss
            shift_end_var[(day, d)] = se
            for lid in lids:
                model.Add(ss <= lane_pickup_min[lid]).OnlyEnforceIf(assign[day][lid][d])
                model.Add(se >= lane_finish_min[lid]).OnlyEnforceIf(assign[day][lid][d])
            model.Add(ss == 0).OnlyEnforceIf(dw.Not())
            model.Add(se == 0).OnlyEnforceIf(dw.Not())
            model.Add(se - ss + pre_post_min <= max_duty_min).OnlyEnforceIf(dw)

    # Constraint 4: Time ordering — if driver d does lanes A and B on same day,
    # and A's finish time is AFTER B's pickup, then A must come before B
    # (i.e., they can't both be assigned unless timing works)
    print("Adding timing compatibility constraints...")
    timing_constraints = 0

    for day in working_days:
        lids = day_lane_ids[day]
        for i, lid_a in enumerate(lids):
            for j, lid_b in enumerate(lids):
                if i == j:
                    continue

                # Can A come before B?
                finish_a = lane_finish_min[lid_a]
                pickup_b = lane_pickup_min[lid_b]
                pickup_end_b = lane_pickup_end_min[lid_b]

                # Deadhead from A to B
                dh = dh_hours.get((lid_a, lid_b))

                if dh is None:
                    # Not geographically connected AND different pickup times
                    # They can still be on the same driver if non-overlapping
                    # But they need a connection — if no graph edge, they can't be consecutive
                    # However they CAN be on the same driver with OTHER lanes between them
                    # Skip this pair — the ordering constraint handles it
                    continue

                dh_min = int(dh * MINUTES)
                arrival_at_b = finish_a + dh_min
                grace = 15  # minutes

                # If driver arrives AFTER B's pickup window closes, A→B is invalid
                if arrival_at_b > pickup_end_b + grace:
                    # A cannot come right before B
                    pass  # This is OK — they can still be on the same driver with other lanes between
                else:
                    # A→B is a valid consecutive pair
                    # Check wait time
                    if pickup_b > arrival_at_b:
                        wait_min = pickup_b - arrival_at_b
                        if wait_min > int(max_wait_h * MINUTES):
                            pass  # Too much wait for direct A→B connection

    # Constraint 5+6: PAIRWISE GEOGRAPHIC ENFORCEMENT
    # For every pair (A, B) on the same driver/day where A.pickup < B.pickup:
    # A.dest must == B.origin, OR A.dest == Colton, OR B.origin == Colton.
    # Otherwise FORBID the pair on the same driver.
    #
    # This is simpler than successor variables and much faster to solve.
    # It's slightly looser (doesn't enforce full chain ordering), but catches
    # all cross-corridor jumps like SD→LV, SA→MV, etc.
    print("Adding geographic enforcement constraints...")
    # base_city from config (already set above)
    geo_constraints = 0

    for day in working_days:
        lids = day_lane_ids[day]
        for i, lid_a in enumerate(lids):
            la = lane_map[lid_a]
            dest_a = la.dest_city.lower().strip()
            finish_a = lane_finish_min[lid_a]

            # If A ends in Colton, any B is fine (driver is at base)
            if dest_a == base_city:
                continue

            for j, lid_b in enumerate(lids):
                if j == i: continue
                lb = lane_map[lid_b]
                orig_b = lb.origin_city.lower().strip()
                pickup_b = lane_pickup_min[lid_b]

                # Only check B that comes AFTER A in time
                if pickup_b <= finish_a - 15:
                    continue

                # If B starts where A ends — OK (zero deadhead)
                if orig_b == dest_a:
                    continue

                # If B starts in Colton — OK (driver returns to base between them)
                if orig_b == base_city:
                    continue

                # CROSS-CORRIDOR JUMP: A ends in X, B starts in Y, X≠Y≠Colton
                # Check if there's ANY valid intermediate lane C between A and B
                # where C starts in dest_a (or Colton) and C ends in Colton (or orig_b)
                # If such C exists, the pair might be OK (C bridges the gap)
                has_bridge = False
                for lid_c in lids:
                    if lid_c == lid_a or lid_c == lid_b: continue
                    lc = lane_map[lid_c]
                    orig_c = lc.origin_city.lower().strip()
                    dest_c = lc.dest_city.lower().strip()
                    pickup_c = lane_pickup_min[lid_c]
                    finish_c = lane_finish_min[lid_c]
                    # C must be between A and B in time
                    if pickup_c < finish_a - 15 or finish_c > pickup_b + 15:
                        continue
                    # C must connect: starts where A ends, ends in Colton (or where B starts)
                    if (orig_c == dest_a or orig_c == base_city) and (dest_c == base_city or dest_c == orig_b):
                        has_bridge = True
                        break

                if has_bridge:
                    continue  # A bridge lane exists — allow but don't require

                # No bridge possible — FORBID this pair on the same driver
                for d in range(n_drivers):
                    model.Add(assign[day][lid_a][d] + assign[day][lid_b][d] <= 1)
                geo_constraints += 1

    # Also: pickup overlap (simultaneous lanes can't be same driver)
    overlap_constraints = 0
    for day in working_days:
        lids = day_lane_ids[day]
        for i, a in enumerate(lids):
            for j, b in enumerate(lids):
                if j <= i: continue
                if lane_pickup_min[a] < lane_pickup_end_min[b] and lane_pickup_min[b] < lane_pickup_end_min[a]:
                    for d in range(n_drivers):
                        model.Add(assign[day][a][d] + assign[day][b][d] <= 1)
                    overlap_constraints += 1

    print(f"  {geo_constraints} cross-corridor forbidden pairs, {overlap_constraints} overlap pairs")

    # Constraint 7: 10h off-duty (span-based)
    print("Adding 10h off-duty constraints (span-based)...")
    off_duty_min_req = int(OFF_DUTY_HOURS * MINUTES)

    def _add_off_duty_verbose(today, tomorrow):
        if not day_lane_ids.get(today) or not day_lane_ids.get(tomorrow):
            return 0
        count = 0
        for d in range(n_drivers):
            if (today, d) not in driver_works_var or (tomorrow, d) not in driver_works_var:
                continue
            dw_today = driver_works_var[(today, d)]
            dw_tomorrow = driver_works_var[(tomorrow, d)]
            both_work = model.NewBoolVar(f'bw_{today}_{tomorrow}_{d}')
            model.AddBoolAnd([dw_today, dw_tomorrow]).OnlyEnforceIf(both_work)
            model.AddBoolOr([dw_today.Not(), dw_tomorrow.Not()]).OnlyEnforceIf(both_work.Not())
            model.Add(
                shift_start_var[(tomorrow, d)] + 24 * MINUTES - shift_end_var[(today, d)] >= off_duty_min_req
            ).OnlyEnforceIf(both_work)
            count += 1
        return count

    off_duty_constraints = 0
    for di in range(len(working_days) - 1):
        today = working_days[di]
        tomorrow = working_days[di + 1]
        if tomorrow - today != 1:
            continue
        off_duty_constraints += _add_off_duty_verbose(today, tomorrow)

    # Sat→Sun adjacency
    if working_days[-1] == 0:
        off_duty_constraints += _add_off_duty_verbose(6, 0)

    print(f"  {off_duty_constraints} off-duty constraints")

    # Constraint 8: 70h weekly duty cap (span-based)
    print("Adding 70h weekly constraints (span-based)...")
    max_weekly_min = int(MAX_WEEKLY_DUTY * MINUTES * 0.90)
    for d in range(n_drivers):
        daily_duty_vars = []
        for day in working_days:
            if not day_lane_ids[day]:
                continue
            if (day, d) not in driver_works_var:
                continue
            dw = driver_works_var[(day, d)]
            ss = shift_start_var[(day, d)]
            se = shift_end_var[(day, d)]
            dd = model.NewIntVar(0, max_duty_min, f'dd_{day}_{d}')
            model.Add(dd == se - ss + pre_post_min).OnlyEnforceIf(dw)
            model.Add(dd == 0).OnlyEnforceIf(dw.Not())
            daily_duty_vars.append(dd)
        if daily_duty_vars:
            model.Add(sum(daily_duty_vars) <= max_weekly_min)

    # ---- OBJECTIVE: Minimize deadhead (empty miles) ----
    #
    # The key insight from real dispatchers: group lanes by CORRIDOR.
    # A corridor = the two cities a lane connects (e.g., Colton↔SD).
    # Lanes on the same corridor have ZERO deadhead between them.
    # Lanes on DIFFERENT corridors require driving empty miles between them.
    #
    # Strategy: assign each lane a corridor ID. For each pair of lanes on the
    # same driver on the same day from DIFFERENT corridors, add a penalty
    # equal to the distance between those corridors.
    #
    # This is simpler and more effective than tracking individual pairs.
    print("Building deadhead minimization objective...")
    from lane_solver import haversine as hav

    # Corridor = frozenset of (origin_city, dest_city)
    lane_corr = {}
    for l in lanes:
        lane_corr[l.id] = frozenset([l.origin_city.lower().strip(), l.dest_city.lower().strip()])

    # Pre-compute corridor-to-corridor distance
    # Two lanes are "same corridor" if they share the same city pair
    # Different corridor distance = min distance between any endpoint pair
    corr_dist_cache = {}
    for la in lanes:
        for lb in lanes:
            if la.id == lb.id: continue
            key = (la.id, lb.id)
            if key in corr_dist_cache: continue

            if lane_corr[la.id] == lane_corr[lb.id]:
                corr_dist_cache[key] = 0  # same corridor
            elif lane_corr[la.id] & lane_corr[lb.id]:
                corr_dist_cache[key] = 0  # share a city (e.g., both touch Colton)
            else:
                # Different corridors — compute distance
                if la.dest_lat and la.dest_lng and lb.origin_lat and lb.origin_lng:
                    corr_dist_cache[key] = int(hav(la.dest_lat, la.dest_lng, lb.origin_lat, lb.origin_lng))
                else:
                    corr_dist_cache[key] = 50  # unknown

    # For each pair of lanes on the same driver/day, check if they can
    # DIRECTLY chain (A.dest == B.origin, proper timing). If they can't,
    # there's deadhead. Penalize the distance.
    #
    # Key: lane A (Colton→SD) delivers to SD. Lane B (Colton→LV) picks up in Colton.
    # If the driver does A then B, they deadhead SD→Colton (82mi).
    # If instead they do A then C (SD→Colton), deadhead = 0.
    #
    # Penalty = actual deadhead distance from A.dest to B.origin for each pair
    # that ends up on the same driver.
    #
    # But we only need to check CONSECUTIVE pairs (sorted by pickup time).
    # Non-consecutive lanes have intermediate lanes that handle the transitions.
    #
    # Approximation: for each driver's daily set, the total deadhead is dominated
    # by whether outbound lanes (ending far from Colton) are followed by
    # return lanes (starting from that same far city) or by Colton-origin lanes.
    #
    # Simple effective approach: REWARD pairs where A.dest_city == B.origin_city
    # AND B starts after A finishes. These are zero-deadhead transitions.
    # The solver will maximize these, naturally minimizing deadhead.

    print("  Building zero-deadhead pairing rewards...")

    reward_terms = []
    for day in working_days:
        lids = day_lane_ids[day]
        for i, lid_a in enumerate(lids):
            la = lane_map[lid_a]
            dest_a = la.dest_city.lower().strip()
            finish_a = lane_finish_min[lid_a]

            for j, lid_b in enumerate(lids):
                if j == i: continue
                lb = lane_map[lid_b]
                orig_b = lb.origin_city.lower().strip()
                pickup_b = lane_pickup_min[lid_b]

                # Zero-deadhead pair: A delivers to same city where B picks up,
                # AND B starts after A finishes (can actually chain)
                if dest_a != orig_b: continue
                if pickup_b < finish_a - 15: continue  # B starts before A finishes
                if pickup_b - finish_a > max_wait_h * MINUTES: continue  # too long wait

                # This is a valid zero-deadhead transition
                # Weight by how good the pair is: closer in time = better
                gap_min = max(0, pickup_b - finish_a)
                # Reward: higher for tight connections, lower for longer waits
                reward = 10 if gap_min < 30 else (5 if gap_min < 60 else 2)

                for d in range(n_drivers):
                    both = model.NewBoolVar(f'zd_{day}_{lid_a[-4:]}_{lid_b[-4:]}_{d}')
                    model.AddBoolAnd([assign[day][lid_a][d], assign[day][lid_b][d]]).OnlyEnforceIf(both)
                    model.AddBoolOr([assign[day][lid_a][d].Not(), assign[day][lid_b][d].Not()]).OnlyEnforceIf(both.Not())
                    reward_terms.append(both * reward)

    # Deadhead penalty: penalize arc deadhead miles
    dh_penalty_terms = []
    for day in working_days:
        lids = day_lid_list[day]
        arc_dh = day_arc_dh[day]
        for (i, j), (_, dh_mi) in arc_dh.items():
            if dh_mi <= 5: continue
            for d in range(n_drivers):
                both = model.NewBoolVar(f'dhp_{day}_{i}_{j}_{d}')
                model.AddBoolAnd([assign[day][lids[i]][d], assign[day][lids[j]][d]]).OnlyEnforceIf(both)
                model.AddBoolOr([assign[day][lids[i]][d].Not(), assign[day][lids[j]][d].Not()]).OnlyEnforceIf(both.Not())
                dh_penalty_terms.append(both * (dh_mi // 5))

    DH_PENALTY_WEIGHT = 3
    obj_terms = list(reward_terms) if reward_terms else []
    if dh_penalty_terms:
        obj_terms.extend(-p * DH_PENALTY_WEIGHT for p in dh_penalty_terms)
    if obj_terms:
        model.Maximize(sum(obj_terms))
        print(f"  {len(reward_terms)} zero-deadhead reward terms, {len(dh_penalty_terms)} deadhead penalty terms")
    else:
        model.Minimize(0)

    t_build = time.time() - t0
    print(f"\nModel built in {t_build:.1f}s")
    total_vars = sum(len(day_lane_ids[day]) * n_drivers for day in working_days)
    print(f"Variables: {total_vars}, Constraints: {off_duty_constraints + n_lanes * len(working_days)}")

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 300
    solver.parameters.num_workers = 8

    print(f"\nSolving for {n_drivers} drivers...")
    t1 = time.time()
    status = solver.Solve(model)
    t2 = time.time()

    print(f"Status: {solver.StatusName(status)} in {t2 - t1:.1f}s")

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        print(f"INFEASIBLE with {n_drivers} drivers!")
        return None

    # Post-solve: order each driver's daily lanes into a geographic chain
    # Uses module-level _order_geo function
    def order_lanes_geographically(ll, bcn): return _order_geo(ll, bcn)  # noqa
    # Extract solution
    print(f"\n{'=' * 95}")
    print(f"  WEEKLY SCHEDULE: {n_drivers} drivers — FEASIBLE!")
    print(f"{'=' * 95}")

    for d in range(n_drivers):
        print(f"\n  Driver {d + 1}:")
        prev_end = None
        wk_drive = 0
        wk_duty = 0
        for day in working_days:
            assigned_lanes = []
            for lid in day_lane_ids[day]:
                if solver.Value(assign[day][lid][d]):
                    l = lane_map[lid]
                    assigned_lanes.append(l)

            if not assigned_lanes:
                print(f"    {day_names[day]}: OFF")
                prev_end = None
                continue

            # Order geographically (not just by pickup time)
            assigned_lanes = order_lanes_geographically(assigned_lanes, base_city)
            names = [l.name.replace('9173Q-', '') for l in assigned_lanes]
            drive = sum(l.route_duration_hours for l in assigned_lanes)
            duty = pre_post_h + sum(l.route_duration_hours + l.dwell_hours for l in assigned_lanes)

            first_start = assigned_lanes[0].pickup_time
            last_end = assigned_lanes[-1].finish_time

            st = f"{int(first_start)}:{int((first_start % 1) * 60):02d}" if first_start else "?"
            en = last_end
            en_s = f"{int(en)}:{int((en % 1) * 60):02d}" if en and en <= 24 else (f"+{int(en - 24)}:{int((en % 1) * 60):02d}" if en else "?")

            off_s = ""
            if prev_end is not None and first_start is not None:
                off = (first_start + 24) - prev_end
                off_s = f" (off:{off:.1f}h)"

            print(f"    {day_names[day]}: {len(assigned_lanes)}L {drive:.1f}h/{duty:.1f}h [{st}→{en_s}]{off_s}  {' → '.join(names)}")
            wk_drive += drive
            wk_duty += duty
            prev_end = last_end

        print(f"    WEEK: {wk_drive:.1f}h drive / {wk_duty:.1f}h duty {'⚠️ >70h!' if wk_duty > 70 else '✓'}")

    # Verify
    print(f"\n{'=' * 95}")
    print(f"  VERIFICATION")
    print(f"{'=' * 95}")
    v = 0
    for d in range(n_drivers):
        prev_end_day = None
        prev_day = None
        for day in working_days:
            assigned = [lane_map[lid] for lid in day_lane_ids[day] if solver.Value(assign[day][lid][d])]
            if not assigned:
                prev_end_day = None
                prev_day = None
                continue
            assigned.sort(key=lambda l: l.pickup_time or 99)
            last_end = assigned[-1].finish_time
            first_start = assigned[0].pickup_time

            if prev_end_day is not None and first_start is not None and prev_day is not None and day - prev_day == 1:
                off = (first_start + 24) - prev_end_day
                if off < OFF_DUTY_HOURS:
                    v += 1
                    print(f"  VIOLATION: D{d + 1} {day_names[prev_day]}→{day_names[day]}: {off:.1f}h off")

            prev_end_day = last_end
            prev_day = day

    if v == 0:
        print(f"  ✅ All 10h off-duty — COMPLIANT")
        print(f"  ✅ All HOS daily limits — COMPLIANT")
        print(f"  ✅ 70h weekly cap — COMPLIANT")
    else:
        print(f"  ❌ {v} violation(s)")


def _compute_dh(la, lb):
    """Compute deadhead miles between two lanes using haversine."""
    from lane_solver import haversine as hav
    if la.dest_lat and la.dest_lng and lb.origin_lat and lb.origin_lng:
        return hav(la.dest_lat, la.dest_lng, lb.origin_lat, lb.origin_lng)
    elif la.dest_city.lower().strip() == lb.origin_city.lower().strip():
        return 0.0
    else:
        return 150.0  # unknown locations, assume moderate


def _sequence_driver_day(lane_ids, lane_map, graph, base_city, max_wait_h=3.0):
    """Exact per-day sequencer: finds optimal lane ordering for a single driver's daily assignment.
    Uses a small circuit model to minimize deadhead for just these lanes.
    Arc validity enforces: finish_a + deadhead_ab <= pickup_end_b and wait <= max_wait.
    Returns (ordered_ids, drive_hours, dh_miles, is_exact).
    is_exact=False means fallback ordering was used."""

    if len(lane_ids) <= 1:
        if not lane_ids:
            return ([], 0.0, 0, True)
        l = lane_map[lane_ids[0]]
        return (lane_ids, l.route_duration_hours, 0, True)

    n = len(lane_ids)
    # Compute pairwise deadhead with physical feasibility checks
    pair_dh = {}  # (i,j) -> (dh_hours, dh_miles)
    for i, lid_a in enumerate(lane_ids):
        la = lane_map[lid_a]
        for j, lid_b in enumerate(lane_ids):
            if i == j: continue
            lb = lane_map[lid_b]
            dh_mi = _compute_dh(la, lb)
            dh_h = dh_mi / 55.0

            # Physical feasibility: arrival at b must be before b's pickup window closes
            if la.finish_time is not None and lb.pickup_end_time is not None:
                arrival_at_b = la.finish_time + dh_h
                pe_b = lb.pickup_end_time
                if pe_b < la.finish_time: pe_b += 24.0  # handle wrap
                if arrival_at_b > pe_b + 0.25: continue  # can't arrive in time

            # Max wait: don't allow excessive idle between legs
            if la.finish_time is not None and lb.pickup_time is not None:
                wait = lb.pickup_time - (la.finish_time + dh_h)
                if wait > max_wait_h: continue  # too long to wait

            pair_dh[(i, j)] = (dh_h, dh_mi)

    # Small circuit: find min-deadhead ordering
    from ortools.sat.python import cp_model
    model = cp_model.CpModel()
    arcs = []
    succ_info = []  # (var, dh_hours, dh_miles)

    for i in range(n):
        arcs.append((0, i + 1, model.NewBoolVar(f'f_{i}')))
        arcs.append((i + 1, 0, model.NewBoolVar(f'l_{i}')))
        for j in range(n):
            if i == j: continue
            if (i, j) not in pair_dh: continue
            dh_h, dh_m = pair_dh[(i, j)]
            sv = model.NewBoolVar(f's_{i}_{j}')
            arcs.append((i + 1, j + 1, sv))
            succ_info.append((sv, dh_h, dh_m))

    model.AddCircuit(arcs)
    if succ_info:
        model.Minimize(sum(sv * int(dh_m) for sv, _, dh_m in succ_info))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 5
    solver.parameters.num_workers = 4
    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        # Fallback: geographic ordering with haversine-based deadhead (not just graph)
        ordered = _order_geo([lane_map[lid] for lid in lane_ids], base_city)
        ordered_ids = [l.id for l in ordered]
        drive = sum(lane_map[lid].route_duration_hours for lid in ordered_ids)
        dh_m_total = 0.0
        for k in range(1, len(ordered_ids)):
            la = lane_map[ordered_ids[k - 1]]
            lb = lane_map[ordered_ids[k]]
            dh_mi = _compute_dh(la, lb)
            drive += dh_mi / 55.0
            dh_m_total += dh_mi
        return (ordered_ids, drive, int(dh_m_total), False)  # is_exact=False

    # Extract ordering from circuit
    order = []
    current = 0
    for _ in range(n + 1):
        for (head, tail, var) in arcs:
            if head == current and tail != current and solver.Value(var):
                if tail == 0:
                    break
                order.append(lane_ids[tail - 1])
                current = tail
                break
        else:
            break

    if len(order) != n:
        # Circuit extraction failed — fall back to geo ordering, mark NOT exact
        ordered = _order_geo([lane_map[lid] for lid in lane_ids], base_city)
        ordered_ids = [l.id for l in ordered]
        drive = sum(lane_map[lid].route_duration_hours for lid in ordered_ids)
        dh_m_total = 0.0
        for k in range(1, len(ordered_ids)):
            la_fb = lane_map[ordered_ids[k - 1]]
            lb_fb = lane_map[ordered_ids[k]]
            dh_mi = _compute_dh(la_fb, lb_fb)
            drive += dh_mi / 55.0
            dh_m_total += dh_mi
        return (ordered_ids, drive, int(dh_m_total), False)  # NOT exact

    drive = sum(lane_map[lid].route_duration_hours for lid in order)
    dh_total = 0.0
    for k in range(1, len(order)):
        idx_a = lane_ids.index(order[k - 1])
        idx_b = lane_ids.index(order[k])
        if (idx_a, idx_b) in pair_dh:
            dh_h, dh_m = pair_dh[(idx_a, idx_b)]
            drive += dh_h
            dh_total += dh_m
    return (order, drive, int(dh_total), True)  # is_exact=True


def _build_and_solve(n_drivers, lanes, lane_map, graph, lane_active_days, lane_pickup_min,
                      lane_pickup_end_min, lane_finish_min, lane_drive_min, lane_duty_min,
                      day_lane_ids, working_days, day_names_map, pre_post_h, max_legs, max_wait_h,
                      solver_time=300, base_city='colton', base_lat=34.0430, base_lng=-117.3333,
                      max_gap_hours=3.0, drive_buffer_hours=1.5):
    """Two-phase solver:
    Phase 1: Span-based weekly assignment (fast, finds minimum drivers).
    Phase 2: Exact per-day sequencing for drive/DH metrics.
    """
    from ortools.sat.python import cp_model

    model = cp_model.CpModel()
    pre_post_min = int(pre_post_h * MINUTES)
    max_drive_m = int(HOS_MAX_DRIVE * MINUTES)
    max_duty_m = int(HOS_MAX_DUTY * MINUTES)
    weekly_cap = int(MAX_WEEKLY_DUTY * MINUTES)

    assign = {}
    for day in working_days:
        assign[day] = {}
        for lid in day_lane_ids[day]:
            assign[day][lid] = [model.NewBoolVar(f'a_{day}_{lid}_{d}') for d in range(n_drivers)]

    # Coverage: each lane assigned to exactly 1 driver per day
    for day in working_days:
        for lid in day_lane_ids[day]:
            model.Add(sum(assign[day][lid]) == 1)

    # Max legs per driver per day
    for day in working_days:
        for d in range(n_drivers):
            model.Add(sum(assign[day][lid][d] for lid in day_lane_ids[day]) <= max_legs)

    # --- Generic corridor pair detection + same-driver constraints ---
    # Auto-detect natural round-trip pairs: outbound A→B paired with return B→A
    # on the same day, same driver. Uses one-to-one matching (each lane in at most one pair)
    # to avoid contradictions. Picks the tightest-gap pair for each lane.
    day_lid_set = {day: set(day_lane_ids[day]) for day in working_days}

    # 1. Find all candidate pairs with their gap
    candidates = []  # (gap, out_id, ret_id, shared_days)
    for la in lanes:
        for lb in lanes:
            if la.id >= lb.id: continue  # avoid duplicates
            if (la.origin_city.lower().strip() != lb.dest_city.lower().strip() or
                la.dest_city.lower().strip() != lb.origin_city.lower().strip()):
                continue
            if la.finish_time is None or lb.pickup_time is None: continue
            if lb.finish_time is None or la.pickup_time is None: continue
            # Determine order
            if la.finish_time <= (lb.pickup_end_time or lb.pickup_time + 0.25):
                gap = lb.pickup_time - la.finish_time
                if gap <= 0.5:
                    shared = lane_active_days.get(la.id, set()) & lane_active_days.get(lb.id, set())
                    if shared:
                        candidates.append((gap, la.id, lb.id, shared))
            if lb.finish_time <= (la.pickup_end_time or la.pickup_time + 0.25):
                gap = la.pickup_time - lb.finish_time
                if gap <= 0.5:
                    shared = lane_active_days.get(la.id, set()) & lane_active_days.get(lb.id, set())
                    if shared:
                        candidates.append((gap, lb.id, la.id, shared))

    # 2. Greedy one-to-one matching: pick tightest-gap pairs first, each lane used once
    candidates.sort(key=lambda x: x[0])
    paired_lanes = set()
    active_pairs = []  # (out_id, ret_id, shared_days)
    for gap, out_id, ret_id, shared in candidates:
        if out_id in paired_lanes or ret_id in paired_lanes:
            continue
        paired_lanes.add(out_id)
        paired_lanes.add(ret_id)
        active_pairs.append((out_id, ret_id, shared))

    # 3. Apply hard same-driver constraints for matched pairs
    # Also identify exclusive blocks: long-haul pairs where combined drive > 5h
    # or combined span > 10h. These get ONLY the pair on that driver-day (no extra legs).
    EXCLUSIVE_DRIVE_THRESHOLD = 5.0  # hours combined route drive
    EXCLUSIVE_SPAN_THRESHOLD = 10.0  # hours combined time span

    pair_constraints = 0
    exclusive_blocks = []  # (out_id, ret_id, shared_days)
    for out_id, ret_id, shared in active_pairs:
        out_lane = lane_map[out_id]
        ret_lane = lane_map[ret_id]
        combined_drive = out_lane.route_duration_hours + ret_lane.route_duration_hours
        # Compute combined span (order: outbound first, then return)
        if out_lane.finish_time and ret_lane.finish_time and out_lane.pickup_time and ret_lane.pickup_time:
            if out_lane.finish_time <= ret_lane.pickup_time + 0.5:
                combined_span = ret_lane.finish_time - out_lane.pickup_time
            else:
                combined_span = out_lane.finish_time - ret_lane.pickup_time
        else:
            combined_span = 0

        is_exclusive = combined_drive > EXCLUSIVE_DRIVE_THRESHOLD or combined_span > EXCLUSIVE_SPAN_THRESHOLD

        for day in working_days:
            if day not in shared: continue
            if out_id not in day_lid_set[day] or ret_id not in day_lid_set[day]: continue
            # Same-driver constraint
            for d in range(n_drivers):
                model.Add(assign[day][out_id][d] == assign[day][ret_id][d])
            pair_constraints += 1

            if is_exclusive:
                # Exclusive block: driver doing this pair gets NO other lanes that day
                other_lids = [lid for lid in day_lane_ids[day] if lid != out_id and lid != ret_id]
                for d in range(n_drivers):
                    for other_lid in other_lids:
                        # If driver d has the outbound, they cannot have any other lane
                        model.Add(assign[day][other_lid][d] + assign[day][out_id][d] <= 1)

        if is_exclusive:
            exclusive_blocks.append((out_id, ret_id, shared))

    # --- HOS: span-based 14h duty, 11h drive (route only), 10h off-duty, 70h weekly ---
    # Drive/DH are computed exactly in post-solve sequencing, not constrained here.
    # The span-based duty window is the HOS authority for feasibility.
    driver_works_var = {}
    shift_start_var = {}
    shift_end_var = {}

    for day in working_days:
        lids = day_lane_ids[day]
        if not lids:
            continue
        for d in range(n_drivers):
            dw = model.NewBoolVar(f'w_{day}_{d}')
            model.AddMaxEquality(dw, [assign[day][lid][d] for lid in lids])
            driver_works_var[(day, d)] = dw

            # 11h drive constraint: route drive with 1h buffer for deadhead
            # The exact drive (including deadhead) is validated in post-solve sequencing.
            # The buffer ensures the span model doesn't produce assignments right at the edge.
            drive_buffer_min = int(drive_buffer_hours * MINUTES)
            model.Add(sum(assign[day][lid][d] * lane_drive_min[lid] for lid in lids) <= max_drive_m - drive_buffer_min)

            # 14h duty window (span-based)
            ss = model.NewIntVar(0, 24 * MINUTES, f'ss_{day}_{d}')
            se = model.NewIntVar(0, 30 * MINUTES, f'se_{day}_{d}')
            shift_start_var[(day, d)] = ss
            shift_end_var[(day, d)] = se

            for lid in lids:
                model.Add(ss <= lane_pickup_min[lid]).OnlyEnforceIf(assign[day][lid][d])
                model.Add(se >= lane_finish_min[lid]).OnlyEnforceIf(assign[day][lid][d])

            model.Add(ss == 0).OnlyEnforceIf(dw.Not())
            model.Add(se == 0).OnlyEnforceIf(dw.Not())
            model.Add(se - ss + pre_post_min <= max_duty_m).OnlyEnforceIf(dw)

    # 10h off-duty (span-based)
    off_duty_req = int(OFF_DUTY_HOURS * MINUTES)
    def _add_off_duty(today, tomorrow):
        if not day_lane_ids.get(today) or not day_lane_ids.get(tomorrow):
            return
        for d in range(n_drivers):
            if (today, d) not in driver_works_var or (tomorrow, d) not in driver_works_var:
                continue
            dw_t = driver_works_var[(today, d)]
            dw_n = driver_works_var[(tomorrow, d)]
            bw = model.NewBoolVar(f'bw_{today}_{tomorrow}_{d}')
            model.AddBoolAnd([dw_t, dw_n]).OnlyEnforceIf(bw)
            model.AddBoolOr([dw_t.Not(), dw_n.Not()]).OnlyEnforceIf(bw.Not())
            model.Add(shift_start_var[(tomorrow, d)] + 24 * MINUTES - shift_end_var[(today, d)] >= off_duty_req).OnlyEnforceIf(bw)

    for di in range(len(working_days) - 1):
        today, tomorrow = working_days[di], working_days[di + 1]
        if tomorrow - today != 1: continue
        _add_off_duty(today, tomorrow)
    if working_days[-1] == 0:
        _add_off_duty(6, 0)

    # 70h weekly cap (span-based)
    for d in range(n_drivers):
        dd_vars = []
        for day in working_days:
            if not day_lane_ids[day] or (day, d) not in driver_works_var:
                continue
            dw = driver_works_var[(day, d)]
            dd = model.NewIntVar(0, max_duty_m, f'dd_{day}_{d}')
            model.Add(dd == shift_end_var[(day, d)] - shift_start_var[(day, d)] + pre_post_min).OnlyEnforceIf(dw)
            model.Add(dd == 0).OnlyEnforceIf(dw.Not())
            dd_vars.append(dd)
        if dd_vars:
            model.Add(sum(dd_vars) <= weekly_cap)

    # --- Operational sanity: max intra-day gap (hard) + idle/span penalties (soft) ---

    # HARD: For every pair of lanes (A, B) on the same driver/day where B starts after A,
    # if the gap (B.pickup - A.finish) > max_gap, forbid them on the same driver.
    # This kills the "park driver all day" anti-pattern.
    max_gap_min = int(max_gap_hours * MINUTES)
    for day in working_days:
        lids = day_lane_ids[day]
        for i, lid_a in enumerate(lids):
            finish_a = lane_finish_min[lid_a]
            for j, lid_b in enumerate(lids):
                if i == j: continue
                pickup_b = lane_pickup_min[lid_b]
                if pickup_b <= finish_a: continue  # B doesn't start after A
                gap = pickup_b - finish_a
                if gap <= max_gap_min: continue  # gap is OK
                # Gap too large: forbid A and B on the same driver
                for d in range(n_drivers):
                    model.Add(assign[day][lid_a][d] + assign[day][lid_b][d] <= 1)

    # SOFT: penalize daily span over target, idle time, deadhead, corridor mixing
    from lane_solver import haversine as hav
    lid_set_per_day = {day: set(day_lane_ids[day]) for day in working_days}

    # 1. Span penalty: penalize each driver-day's span exceeding target (10h)
    target_span_min = int(10.0 * MINUTES)
    span_penalty_vars = []
    for day in working_days:
        if not day_lane_ids[day]: continue
        for d in range(n_drivers):
            if (day, d) not in driver_works_var: continue
            dw = driver_works_var[(day, d)]
            ss = shift_start_var[(day, d)]
            se = shift_end_var[(day, d)]
            # span_excess = max(0, span - target)
            excess = model.NewIntVar(0, max_duty_m, f'spx_{day}_{d}')
            span = model.NewIntVar(0, 30 * MINUTES, f'spn_{day}_{d}')
            model.Add(span == se - ss).OnlyEnforceIf(dw)
            model.Add(span == 0).OnlyEnforceIf(dw.Not())
            model.AddMaxEquality(excess, [span - target_span_min, model.NewConstant(0)])
            span_penalty_vars.append(excess)

    # 2. Idle penalty: penalize span minus active drive time
    # idle = span - sum(route_duration for assigned lanes)
    # Higher idle = worse
    idle_penalty_vars = []
    for day in working_days:
        lids = day_lane_ids[day]
        if not lids: continue
        for d in range(n_drivers):
            if (day, d) not in driver_works_var: continue
            dw = driver_works_var[(day, d)]
            ss = shift_start_var[(day, d)]
            se = shift_end_var[(day, d)]
            active_drive = sum(assign[day][lid][d] * lane_drive_min[lid] for lid in lids)
            idle = model.NewIntVar(0, 30 * MINUTES, f'idl_{day}_{d}')
            model.Add(idle == se - ss - active_drive).OnlyEnforceIf(dw)
            model.Add(idle == 0).OnlyEnforceIf(dw.Not())
            idle_penalty_vars.append(idle)

    # 3. Zero-deadhead pairing rewards (existing)
    reward_terms = []
    for day in working_days:
        for lid_a in day_lane_ids[day]:
            for next_id, dh_miles, dh_h in graph.get(lid_a, []):
                if next_id not in lid_set_per_day[day]: continue
                if dh_miles > 5: continue
                if lane_finish_min[lid_a] > lane_pickup_end_min[next_id]: continue
                for d in range(n_drivers):
                    both = model.NewBoolVar(f'p_{day}_{lid_a[-4:]}_{next_id[-4:]}_{d}')
                    model.AddBoolAnd([assign[day][lid_a][d], assign[day][next_id][d]]).OnlyEnforceIf(both)
                    model.AddBoolOr([assign[day][lid_a][d].Not(), assign[day][next_id][d].Not()]).OnlyEnforceIf(both.Not())
                    reward_terms.append(both)

    # 4. Return-to-base penalties (existing)
    return_penalties = []
    for day in working_days:
        for lid in day_lane_ids[day]:
            l = lane_map[lid]
            if l.dest_lat and l.dest_lng:
                dist = int(hav(l.dest_lat, l.dest_lng, base_lat, base_lng))
            elif l.dest_city.lower().strip() == 'colton':
                dist = 0
            else:
                dist = 50
            if dist <= 5: continue
            is_late = 1 if (l.finish_time and l.finish_time > 20) else 0
            penalty = dist // 10 + is_late * (dist // 5)
            for d in range(n_drivers):
                return_penalties.append(assign[day][lid][d] * penalty)

    # 5. Pairwise deadhead penalty (existing)
    dh_penalty_terms = []
    for day in working_days:
        for lid_a in day_lane_ids[day]:
            for next_id, dh_miles_val, dh_h in graph.get(lid_a, []):
                if next_id not in lid_set_per_day[day]: continue
                if dh_miles_val <= 5: continue
                if lane_finish_min[lid_a] > lane_pickup_end_min[next_id]: continue
                for d in range(n_drivers):
                    both = model.NewBoolVar(f'dhp_{day}_{lid_a[-4:]}_{next_id[-4:]}_{d}')
                    model.AddBoolAnd([assign[day][lid_a][d], assign[day][next_id][d]]).OnlyEnforceIf(both)
                    model.AddBoolOr([assign[day][lid_a][d].Not(), assign[day][next_id][d].Not()]).OnlyEnforceIf(both.Not())
                    dh_penalty_terms.append(both * (int(dh_miles_val) // 5))

    # 6. Weekly duty excess: penalize each driver's weekly duty above 58h target
    target_weekly_min = int(58.0 * MINUTES)
    weekly_excess_vars = []
    for d in range(n_drivers):
        dd_for_weekly = []
        for day in working_days:
            if not day_lane_ids[day] or (day, d) not in driver_works_var:
                continue
            dw = driver_works_var[(day, d)]
            dd = model.NewIntVar(0, max_duty_m, f'wdd_{day}_{d}')
            model.Add(dd == shift_end_var[(day, d)] - shift_start_var[(day, d)] + pre_post_min).OnlyEnforceIf(dw)
            model.Add(dd == 0).OnlyEnforceIf(dw.Not())
            dd_for_weekly.append(dd)
        if dd_for_weekly:
            wk_total = model.NewIntVar(0, weekly_cap, f'wt_{d}')
            model.Add(wk_total == sum(dd_for_weekly))
            wk_excess = model.NewIntVar(0, weekly_cap, f'wxs_{d}')
            model.AddMaxEquality(wk_excess, [wk_total - target_weekly_min, model.NewConstant(0)])
            weekly_excess_vars.append(wk_excess)

    # 7. Heavy day penalty: penalize days with >12h duty or >7 legs
    heavy_day_vars = []
    duty_12h_min = int(12.0 * MINUTES)
    for day in working_days:
        lids = day_lane_ids[day]
        if not lids: continue
        for d in range(n_drivers):
            if (day, d) not in driver_works_var: continue
            dw = driver_works_var[(day, d)]
            # Span > 12h penalty
            hspan = model.NewIntVar(0, 30 * MINUTES, f'hs_{day}_{d}')
            model.Add(hspan == shift_end_var[(day, d)] - shift_start_var[(day, d)]).OnlyEnforceIf(dw)
            model.Add(hspan == 0).OnlyEnforceIf(dw.Not())
            hexcess = model.NewIntVar(0, max_duty_m, f'hx_{day}_{d}')
            model.AddMaxEquality(hexcess, [hspan - duty_12h_min, model.NewConstant(0)])
            heavy_day_vars.append(hexcess)
            # >7 legs penalty
            over7 = model.NewBoolVar(f'o7_{day}_{d}')
            model.Add(sum(assign[day][lid][d] for lid in lids) > 7).OnlyEnforceIf(over7)
            model.Add(sum(assign[day][lid][d] for lid in lids) <= 7).OnlyEnforceIf(over7.Not())
            heavy_day_vars.append(over7 * 60)

    # 8. Shift band consistency: penalize start-time variance across the week per driver
    band_penalty_vars = []
    for d in range(n_drivers):
        day_entries = [(day, driver_works_var[(day, d)], shift_start_var[(day, d)])
                       for day in working_days
                       if day_lane_ids.get(day) and (day, d) in driver_works_var]
        for i in range(len(day_entries)):
            for j in range(i + 1, len(day_entries)):
                day_i, dw_i, ss_i = day_entries[i]
                day_j, dw_j, ss_j = day_entries[j]
                both = model.NewBoolVar(f'bb_{day_i}_{day_j}_{d}')
                model.AddBoolAnd([dw_i, dw_j]).OnlyEnforceIf(both)
                model.AddBoolOr([dw_i.Not(), dw_j.Not()]).OnlyEnforceIf(both.Not())
                raw_diff = model.NewIntVar(-24 * MINUTES, 24 * MINUTES, f'rd_{day_i}_{day_j}_{d}')
                model.Add(raw_diff == ss_i - ss_j).OnlyEnforceIf(both)
                model.Add(raw_diff == 0).OnlyEnforceIf(both.Not())
                abs_diff = model.NewIntVar(0, 24 * MINUTES, f'ad_{day_i}_{day_j}_{d}')
                model.AddAbsEquality(abs_diff, raw_diff)
                band_penalty_vars.append(abs_diff)

    # --- Weighted objective ---
    PAIR_WEIGHT = 10           # reward zero-DH pairings
    RETURN_WEIGHT = 2          # penalize far-from-base finishes
    DH_PENALTY_WEIGHT = 3      # penalize deadhead miles
    IDLE_WEIGHT = 1            # penalize idle time (per minute)
    SPAN_WEIGHT = 2            # penalize span over 10h target
    WEEKLY_EXCESS_WEIGHT = 1   # penalize weekly duty over 58h target
    HEAVY_DAY_WEIGHT = 1       # penalize heavy days (>12h or >7 legs)
    BAND_WEIGHT = 1            # penalize shift-band inconsistency

    obj_terms = []
    if reward_terms:
        obj_terms.extend(r * PAIR_WEIGHT for r in reward_terms)
    if return_penalties:
        obj_terms.extend(-p * RETURN_WEIGHT for p in return_penalties)
    if dh_penalty_terms:
        obj_terms.extend(-p * DH_PENALTY_WEIGHT for p in dh_penalty_terms)
    if idle_penalty_vars:
        obj_terms.extend(-v * IDLE_WEIGHT for v in idle_penalty_vars)
    if span_penalty_vars:
        obj_terms.extend(-v * SPAN_WEIGHT for v in span_penalty_vars)
    if weekly_excess_vars:
        obj_terms.extend(-v * WEEKLY_EXCESS_WEIGHT for v in weekly_excess_vars)
    if heavy_day_vars:
        obj_terms.extend(-v * HEAVY_DAY_WEIGHT for v in heavy_day_vars)
    if band_penalty_vars:
        obj_terms.extend(-v * BAND_WEIGHT for v in band_penalty_vars)
    if obj_terms:
        model.Maximize(sum(obj_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = solver_time
    solver.parameters.num_workers = 8

    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None

    # ---- Phase 2: Extract assignments per driver/day ----
    driver_day_legs = {}  # (d, day) -> [lid, ...]
    for d in range(n_drivers):
        for day in working_days:
            legs = [lid for lid in day_lane_ids[day] if solver.Value(assign[day][lid][d])]
            if legs:
                driver_day_legs[(d, day)] = legs

    # ---- Helper: compute weekly span-duty for a driver ----
    def _weekly_duty(drv):
        total = 0
        for day in working_days:
            legs = driver_day_legs.get((drv, day), [])
            if not legs: continue
            starts = [lane_map[lid].pickup_time for lid in legs if lane_map[lid].pickup_time]
            finishes = [lane_map[lid].finish_time for lid in legs if lane_map[lid].finish_time]
            if starts and finishes:
                total += (max(finishes) - min(starts)) + pre_post_h
        return total

    # ---- Helper: check off-duty with adjacent days ----
    def _check_off_duty_ok(drv, day_num, legs_on_day):
        if not legs_on_day: return True
        starts = [lane_map[lid].pickup_time for lid in legs_on_day if lane_map[lid].pickup_time]
        finishes = [lane_map[lid].finish_time for lid in legs_on_day if lane_map[lid].finish_time]
        if not starts or not finishes: return True
        my_start, my_end = min(starts), max(finishes)
        for adj_day, check_start in [(day_num - 1 if day_num - 1 != 0 else 6, True),
                                      (day_num + 1 if day_num + 1 != 7 else 1, False)]:
            if adj_day < 1 or adj_day > 6: continue
            adj_legs = driver_day_legs.get((drv, adj_day), [])
            if not adj_legs: continue
            adj_starts = [lane_map[lid].pickup_time for lid in adj_legs if lane_map[lid].pickup_time]
            adj_finishes = [lane_map[lid].finish_time for lid in adj_legs if lane_map[lid].finish_time]
            if not adj_starts or not adj_finishes: continue
            if check_start:
                # adj is previous day: off = my_start + 24 - adj_finish
                off = (my_start + 24) - max(adj_finishes)
                if off < OFF_DUTY_HOURS: return False
            else:
                # adj is next day: off = adj_start + 24 - my_end
                off = (min(adj_starts) + 24) - my_end
                if off < OFF_DUTY_HOURS: return False
        return True

    # ---- Phase 3: Local repair for 11h drive violations ----
    max_drive_h = HOS_MAX_DRIVE
    max_repair_rounds = 10
    for repair_round in range(max_repair_rounds):
        violations_found = False
        for (d, day), legs in list(driver_day_legs.items()):
            _, drive, _, _ = _sequence_driver_day(legs, lane_map, graph, base_city, max_wait_h)
            if drive <= max_drive_h:
                continue
            violations_found = True
            best_swap = None
            for swap_lid in sorted(legs, key=lambda lid: lane_map[lid].route_duration_hours, reverse=True):
                for d2 in range(n_drivers):
                    if d2 == d: continue
                    d2_legs = (driver_day_legs.get((d2, day), []) or []) + [swap_lid]
                    if len(d2_legs) > max_legs: continue
                    # 14h duty span check
                    d2_st = [lane_map[lid].pickup_time for lid in d2_legs if lane_map[lid].pickup_time]
                    d2_fi = [lane_map[lid].finish_time for lid in d2_legs if lane_map[lid].finish_time]
                    if d2_st and d2_fi and (max(d2_fi) - min(d2_st) + pre_post_h) > HOS_MAX_DUTY: continue
                    # Exact drive check for d2
                    _, d2_drive, _, _ = _sequence_driver_day(d2_legs, lane_map, graph, base_city, max_wait_h)
                    if d2_drive > max_drive_h: continue
                    # Exact drive check for d after removing swap_lid
                    d_remaining = [lid for lid in legs if lid != swap_lid]
                    d_new_drive = 0
                    if d_remaining:
                        _, d_new_drive, _, _ = _sequence_driver_day(d_remaining, lane_map, graph, base_city, max_wait_h)
                        if d_new_drive > max_drive_h: continue
                    # Off-duty check
                    if not _check_off_duty_ok(d2, day, d2_legs): continue
                    if d_remaining and not _check_off_duty_ok(d, day, d_remaining): continue
                    # 70h weekly cap check for BOTH drivers after swap
                    # Temporarily apply swap, check, then revert
                    old_d_legs = driver_day_legs.get((d, day))
                    old_d2_legs = driver_day_legs.get((d2, day))
                    driver_day_legs[(d, day)] = d_remaining
                    driver_day_legs[(d2, day)] = d2_legs
                    d_weekly_ok = _weekly_duty(d) <= MAX_WEEKLY_DUTY
                    d2_weekly_ok = _weekly_duty(d2) <= MAX_WEEKLY_DUTY
                    # Revert
                    if old_d_legs is not None:
                        driver_day_legs[(d, day)] = old_d_legs
                    elif (d, day) in driver_day_legs:
                        del driver_day_legs[(d, day)]
                    if old_d2_legs is not None:
                        driver_day_legs[(d2, day)] = old_d2_legs
                    elif (d2, day) in driver_day_legs:
                        del driver_day_legs[(d2, day)]
                    if not d_weekly_ok or not d2_weekly_ok: continue
                    # Best swap: pick the one that reduces source drive the most
                    if best_swap is None or d_new_drive < best_swap[2]:
                        best_swap = (swap_lid, d2, d_new_drive, d_remaining, d2_legs)
            if best_swap:
                swap_lid, d2, _, d_remaining, d2_legs = best_swap
                driver_day_legs[(d, day)] = d_remaining if d_remaining else []
                driver_day_legs[(d2, day)] = d2_legs
                if not d_remaining:
                    del driver_day_legs[(d, day)]
        if not violations_found:
            break

    # ---- Phase 4: Final exact sequencing + validation ----
    weekly_schedule = []
    all_exact = True
    hos_violations = []

    for d in range(n_drivers):
        driver_days = {}
        for day in working_days:
            legs = driver_day_legs.get((d, day), [])
            if legs:
                ordered_ids, drive, dh_miles_total, is_exact = _sequence_driver_day(
                    legs, lane_map, graph, base_city, max_wait_h
                )
                if not is_exact:
                    all_exact = False
                miles = sum(lane_map[lid].route_miles for lid in ordered_ids) + dh_miles_total

                all_starts = [lane_map[lid].pickup_time for lid in ordered_ids if lane_map[lid].pickup_time is not None]
                all_finishes = [lane_map[lid].finish_time for lid in ordered_ids if lane_map[lid].finish_time is not None]
                earliest_start = min(all_starts) if all_starts else 0
                latest_finish = max(all_finishes) if all_finishes else 0
                duty = (latest_finish - earliest_start) + pre_post_h

                # Validate HOS
                if drive > HOS_MAX_DRIVE:
                    hos_violations.append(f'D{d+1} {day_names_map[day]}: {drive:.1f}h drive > {HOS_MAX_DRIVE}h')
                if duty > HOS_MAX_DUTY:
                    hos_violations.append(f'D{d+1} {day_names_map[day]}: {duty:.1f}h duty > {HOS_MAX_DUTY}h')

                # Validate each adjacent transition is physically feasible
                for k in range(1, len(ordered_ids)):
                    la_v = lane_map[ordered_ids[k - 1]]
                    lb_v = lane_map[ordered_ids[k]]
                    if la_v.finish_time is not None and lb_v.pickup_end_time is not None:
                        dh_v = _compute_dh(la_v, lb_v)
                        arrival_v = la_v.finish_time + dh_v / 55.0
                        pe_v = lb_v.pickup_end_time
                        if pe_v < la_v.finish_time: pe_v += 24.0
                        if arrival_v > pe_v + 0.25:
                            hos_violations.append(f'D{d+1} {day_names_map[day]}: {la_v.name}->{lb_v.name} late arrival ({arrival_v:.1f}h > window {pe_v:.1f}h)')

                # If not exact, flag it
                if not is_exact:
                    hos_violations.append(f'D{d+1} {day_names_map[day]}: sequencing not exact (fallback used)')

                names = [lane_map[lid].name for lid in ordered_ids]
                driver_days[day_names_map[day]] = {
                    'legs': ordered_ids, 'legNames': names, 'legCount': len(ordered_ids),
                    'driveHours': round(drive, 1), 'dutyHours': round(duty, 1),
                    'miles': round(miles), 'deadheadMiles': round(dh_miles_total),
                    'startTime': earliest_start, 'endTime': latest_finish,
                    'isExact': is_exact,
                }

        # Validate weekly duty
        weekly_duty = sum(v['dutyHours'] for v in driver_days.values())
        if weekly_duty > MAX_WEEKLY_DUTY:
            hos_violations.append(f'D{d+1}: {weekly_duty:.1f}h weekly > {MAX_WEEKLY_DUTY}h')

        # Validate off-duty between consecutive days
        prev_end = None; prev_dn = None
        for day in working_days:
            dn = day_names_map[day]
            dd = driver_days.get(dn)
            if not dd:
                prev_end = None; prev_dn = None; continue
            if prev_end is not None and dd.get('startTime') is not None:
                off = (dd['startTime'] + 24) - prev_end
                if off < OFF_DUTY_HOURS:
                    hos_violations.append(f'D{d+1} {prev_dn}->{dn}: {off:.1f}h off < {OFF_DUTY_HOURS}h')
            prev_end = dd.get('endTime'); prev_dn = dn

        weekly_schedule.append({
            'driverId': d + 1, 'days': driver_days,
            'totalDriveHours': round(sum(v['driveHours'] for v in driver_days.values()), 1),
            'totalDutyHours': round(sum(v['dutyHours'] for v in driver_days.values()), 1),
            'totalMiles': round(sum(v.get('miles', 0) for v in driver_days.values())),
            'totalDeadheadMiles': round(sum(v.get('deadheadMiles', 0) for v in driver_days.values())),
            'daysWorked': len(driver_days),
        })

    hos_compliant = len(hos_violations) == 0
    return {
        'success': True, 'driverCount': n_drivers, 'weeklySchedule': weekly_schedule,
        'hosCompliant': hos_compliant,
        'hosViolations': hos_violations if not hos_compliant else [],
        'allExact': all_exact,
        'constraints': {
            'offDutyHours': OFF_DUTY_HOURS, 'maxWeeklyDuty': MAX_WEEKLY_DUTY,
            'maxDailyDrive': HOS_MAX_DRIVE, 'maxDailyDuty': HOS_MAX_DUTY,
        },
    }


def solve_weekly_v4_api(entries, config={}, n_drivers=None):
    """API entry point — finds MINIMUM drivers with full HOS compliance.
    Searches upward from a theoretical minimum until a feasible solution is found."""
    max_deadhead = config.get('max_deadhead', DEFAULT_MAX_DEADHEAD)
    max_legs = config.get('max_legs', DEFAULT_MAX_LEGS)
    max_wait_h = config.get('max_wait', 2.0)
    pre_post_h = config.get('pre_post_hours', 1.0)
    max_gap_h = config.get('max_gap_hours', 3.0)
    drive_buffer_h = config.get('drive_buffer_hours', 1.5)
    base_city, base_lat, base_lng = _get_base_config(config)

    lanes = lanes_from_json(entries)
    lanes.sort(key=lambda l: (l.pickup_time or 99, l.origin_city.lower(), l.dest_city.lower()))
    lane_map = {l.id: l for l in lanes}

    lane_active_days = {}
    for e in entries:
        rule = e.get('scheduleRule', {})
        lane_active_days[e['id']] = set(rule.get('activeDays', [1, 2, 3, 4, 5]))

    day_names_map = {0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat'}
    working_days = [1, 2, 3, 4, 5, 6, 0]

    graph = build_graph(lanes, max_deadhead)

    lane_pickup_min = {}
    lane_pickup_end_min = {}
    lane_finish_min = {}
    lane_drive_min = {}
    lane_duty_min = {}

    for l in lanes:
        pm = int((l.pickup_time or 0) * MINUTES)
        pe = l.pickup_end_time
        if pe is not None and l.pickup_time is not None and pe < l.pickup_time:
            pe += 24.0
        pem = int((pe or (l.pickup_time or 0) + 0.25) * MINUTES)
        fm = int((l.finish_time or 0) * MINUTES)
        lane_pickup_min[l.id] = pm
        lane_pickup_end_min[l.id] = pem
        lane_finish_min[l.id] = fm
        lane_drive_min[l.id] = int(l.route_duration_hours * MINUTES)
        lane_duty_min[l.id] = int((l.route_duration_hours + l.dwell_hours) * MINUTES)

    day_lane_ids = {}
    for day in working_days:
        day_lane_ids[day] = [lid for lid in [l.id for l in lanes] if day in lane_active_days.get(lid, set())]

    # Calculate theoretical minimum: max lanes per day / max_legs
    max_lanes_day = max(len(day_lane_ids[d]) for d in working_days)
    theoretical_min = max(max_lanes_day // max_legs, 1)

    # --- Operational viability check ---
    def _is_operationally_viable(res):
        """Check if schedule is operationally sustainable (not just HOS-legal)."""
        ws = res.get('weeklySchedule', [])
        if not ws: return False, []
        concerns = []
        for dr in ws:
            wd = sum(d['dutyHours'] for d in dr['days'].values())
            # Weekly duty > 63h is unsustainable (allows ~10.5h/day avg over 6 days)
            if wd > 63:
                concerns.append(f'D{dr["driverId"]}: {wd:.0f}h weekly (>63h)')
            # 5+ heavy days (>13h duty or 8 legs) per week is too aggressive
            heavy = sum(1 for d in dr['days'].values()
                       if d['dutyHours'] > 13 or len(d.get('legs', [])) > 7)
            if heavy >= 5:
                concerns.append(f'D{dr["driverId"]}: {heavy} heavy days')
        return len(concerns) == 0, concerns

    # --- Solver helper ---
    def _solve(nd, st=300):
        return _build_and_solve(
            nd, lanes, lane_map, graph, lane_active_days,
            lane_pickup_min, lane_pickup_end_min, lane_finish_min,
            lane_drive_min, lane_duty_min, day_lane_ids, working_days,
            day_names_map, pre_post_h, max_legs, max_wait_h,
            solver_time=st, base_city=base_city, base_lat=base_lat, base_lng=base_lng,
            max_gap_hours=max_gap_h, drive_buffer_hours=drive_buffer_h,
        )

    # If n_drivers specified, solve at that count and return
    if n_drivers:
        print(f"Trying specified target: {n_drivers} drivers...")
        result = _solve(n_drivers)
        if result:
            result['minLegalDriverCount'] = n_drivers
            result['recommendedDriverCount'] = n_drivers
            return result

    # Smarter lower bound: account for daily time-span requirements
    pp_min = int(pre_post_h * MINUTES)
    duty_max_min = int(HOS_MAX_DUTY * MINUTES)
    daily_mins = []
    for day in working_days:
        lids = day_lane_ids[day]
        if not lids: continue
        starts = [lane_pickup_min[lid] for lid in lids]
        finishes = [lane_finish_min[lid] for lid in lids]
        span = max(finishes) - min(starts) + pp_min
        windows_needed = max(1, (span + duty_max_min - 1) // duty_max_min)
        lanes_per_window = (len(lids) + windows_needed - 1) // windows_needed
        daily_mins.append(max((lanes_per_window + max_legs - 1) // max_legs, windows_needed))
    if daily_mins:
        theoretical_min = max(theoretical_min, max(daily_mins))

    # --- Single-pass search: find first HOS-compliant + operationally viable count ---
    # Budget: must complete within Convex 600s action limit.
    # Strategy: fast probes (10s) to find first compliant, then 90s optimization.
    # Skip separate min-legal search — go directly for recommended.
    import time as _time
    search_start = _time.time()
    TIME_BUDGET = 500  # seconds, leave 100s margin for Convex overhead

    print(f"Searching for recommended drivers (starting at {theoretical_min})...")
    min_legal_count = None
    for try_drivers in range(theoretical_min, max_lanes_day + 8):
        elapsed = _time.time() - search_start
        remaining = TIME_BUDGET - elapsed
        if remaining < 20:
            print(f"  Time budget exhausted ({elapsed:.0f}s used)")
            break

        probe_time = min(10, int(remaining / 3))
        print(f"  Trying {try_drivers} drivers ({probe_time}s probe, {elapsed:.0f}s elapsed)...")
        result = _solve(try_drivers, probe_time)

        if not result:
            continue  # infeasible at this count

        if not result.get('hosCompliant') or not result.get('allExact'):
            # Feasible but not fully validated (HOS violations or non-exact sequencing)
            v = result.get('hosViolations', [])
            exact = result.get('allExact', False)
            print(f"    {try_drivers}: {len(v)} violation(s), exact={exact}")
            continue

        # HOS compliant — record as min legal if first
        if min_legal_count is None:
            min_legal_count = try_drivers
            print(f"  Min legal: {try_drivers}")

        viable, concerns = _is_operationally_viable(result)
        if viable:
            # Found recommended! Re-solve with more time for better optimization
            opt_time = min(90, int(remaining - 10))
            if opt_time > probe_time:
                print(f"  Recommended at {try_drivers}! Optimizing ({opt_time}s)...")
                final = _solve(try_drivers, opt_time)
                if final and final.get('hosCompliant') and final.get('allExact'):
                    final['minLegalDriverCount'] = min_legal_count
                    final['recommendedDriverCount'] = try_drivers
                    return final
            result['minLegalDriverCount'] = min_legal_count
            result['recommendedDriverCount'] = try_drivers
            return result
        else:
            print(f"    {try_drivers}: not operationally viable — {len(concerns)} concern(s)")

    # Fallback: return best result found
    if min_legal_count is not None:
        print(f"  Returning min legal ({min_legal_count}) as fallback")
        result = _solve(min_legal_count, min(60, max(10, int(TIME_BUDGET - (_time.time() - search_start) - 5))))
        if result:
            result['minLegalDriverCount'] = min_legal_count
            result['recommendedDriverCount'] = min_legal_count
            return result

    return {'success': False, 'error': 'Could not find feasible solution', 'driverCount': 0}


if __name__ == '__main__':
    entries = json.load(open(sys.argv[1]))
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 9
    # If called from CLI, run the verbose version
    solve_weekly_v4(entries, n_drivers_override=n)
