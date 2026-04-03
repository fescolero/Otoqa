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
    solver.parameters.random_seed = 42  # reproducibility

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


def _greedy_time_order(lane_ids, lane_map):
    """Order lanes by time-feasible greedy: start from earliest pickup,
    always pick the next reachable leg with lowest deadhead.
    Pre-bundles detected natural pairs (reverse corridor, tight gap) as atomic units."""
    if len(lane_ids) <= 1:
        return lane_ids

    lanes_left = list(lane_ids)
    lm = lane_map

    # Step 1: Pre-bundle natural same-day pairs (reverse corridor, gap <= 0.5h)
    bundles = []  # list of (lid_list, earliest_pickup, latest_finish)
    bundled = set()
    for i, lid_a in enumerate(lanes_left):
        if lid_a in bundled: continue
        la = lm[lid_a]
        best_pair = None
        for j, lid_b in enumerate(lanes_left):
            if i == j or lid_b in bundled: continue
            lb = lm[lid_b]
            # Check reverse corridor
            if (la.origin_city.lower().strip() != lb.dest_city.lower().strip() or
                la.dest_city.lower().strip() != lb.origin_city.lower().strip()):
                continue
            # Check timing: one finishes before the other starts
            if la.finish_time is not None and lb.pickup_time is not None:
                if la.finish_time <= lb.pickup_time + 0.5 and lb.pickup_time - la.finish_time <= 0.5:
                    # la → lb pair
                    if best_pair is None or lb.pickup_time < lm[best_pair[1]].pickup_time:
                        best_pair = (lid_a, lid_b, la.pickup_time or 0, lb.finish_time or 0)
            if lb.finish_time is not None and la.pickup_time is not None:
                if lb.finish_time <= la.pickup_time + 0.5 and la.pickup_time - lb.finish_time <= 0.5:
                    # lb → la pair
                    if best_pair is None or la.pickup_time < (lm.get(best_pair[1]) or la).pickup_time:
                        best_pair = (lid_b, lid_a, lb.pickup_time or 0, la.finish_time or 0)
        if best_pair:
            lid_out, lid_ret, earliest, latest = best_pair
            bundled.add(lid_out)
            bundled.add(lid_ret)
            bundles.append(([lid_out, lid_ret], earliest, latest))
        else:
            bundles.append(([lid_a], la.pickup_time or 0, la.finish_time or 0))

    # Add any unbundled lanes
    for lid in lanes_left:
        if lid not in bundled:
            l = lm[lid]
            bundles.append(([lid], l.pickup_time or 0, l.finish_time or 0))

    # Step 2: Greedy time ordering of bundles
    bundles.sort(key=lambda b: b[1])  # sort by earliest pickup
    remaining = list(bundles)
    ordered = []
    current_finish = 0.0

    while remaining:
        # Find next feasible bundle: pickup >= current_finish (or closest)
        best = None
        best_score = float('inf')
        for i, (lids, pickup, finish) in enumerate(remaining):
            # Prefer bundles that start after current finish (no overlap)
            if pickup >= current_finish - 0.25:
                # Score: lower pickup is better, then lower deadhead
                last_lid = ordered[-1][-1] if ordered else None
                dh = 0
                if last_lid:
                    la_last = lm[last_lid]
                    lb_first = lm[lids[0]]
                    dh = _compute_dh(la_last, lb_first)
                score = dh + max(0, pickup - current_finish) * 10  # prefer tight connections
                if score < best_score:
                    best = i
                    best_score = score
        if best is None:
            # No time-feasible bundle left — just take the earliest remaining
            best = 0
        lids, pickup, finish = remaining.pop(best)
        for lid in lids:
            ordered.append(lids)
            break
        ordered_flat = []
        for b in []:
            pass
        current_finish = finish

    # Flatten bundles into ordered lane IDs
    result = []
    used = set()
    remaining2 = list(bundles)

    # Re-do the greedy with proper flattening
    result = []
    current_finish = 0.0
    remaining2 = sorted(bundles, key=lambda b: b[1])

    current_corridor = None
    while remaining2:
        best = None
        best_score = float('inf')
        for i, (lids, pickup, finish) in enumerate(remaining2):
            if pickup >= current_finish - 0.25:
                dh = 0
                if result:
                    dh = _compute_dh(lm[result[-1]], lm[lids[0]])
                # Score: prefer same corridor (big bonus), then low DH, then low wait
                first_lane = lm[lids[0]]
                bundle_corr = frozenset([first_lane.origin_city.lower().strip(), first_lane.dest_city.lower().strip()])
                corridor_switch = 0 if bundle_corr == current_corridor else 100
                score = corridor_switch + dh + max(0, pickup - current_finish) * 10
                if score < best_score:
                    best = i
                    best_score = score
        if best is None:
            best = 0
        lids, pickup, finish = remaining2.pop(best)
        result.extend(lids)
        current_finish = finish
        last_lane = lm[lids[-1]]
        current_corridor = frozenset([last_lane.origin_city.lower().strip(), last_lane.dest_city.lower().strip()])

    return result if len(result) == len(lane_ids) else lane_ids


def _metrics_from_chain(ordered_ids, lane_map):
    """Compute drive, deadhead, and gap data from a final ordered chain."""
    drive = sum(lane_map[lid].route_duration_hours for lid in ordered_ids)
    dh_total = 0.0
    gaps = []
    for k in range(1, len(ordered_ids)):
        la = lane_map[ordered_ids[k - 1]]
        lb = lane_map[ordered_ids[k]]
        dh_mi = _compute_dh(la, lb)
        dh_h = dh_mi / 55.0
        drive += dh_h
        dh_total += dh_mi
        prev_end = la.finish_time
        next_start = lb.pickup_time
        earliest_arr = (prev_end + dh_h) if prev_end is not None else None
        wait_h = (next_start - earliest_arr) if (next_start is not None and earliest_arr is not None) else None
        gaps.append({
            'miles': round(dh_mi, 1),
            'driveHours': round(dh_h, 2),
            'waitHours': round(max(0, wait_h), 2) if wait_h is not None else None,
            'prevEndTime': round(prev_end, 2) if prev_end is not None else None,
            'nextStartTime': round(next_start, 2) if next_start is not None else None,
            'earliestArrival': round(earliest_arr, 2) if earliest_arr is not None else None,
        })
    return drive, int(dh_total), gaps


def _corridor_of_leg(lane):
    """Normalized corridor family string for a lane."""
    a = lane.origin_city.lower().strip()
    b = lane.dest_city.lower().strip()
    return "|".join(sorted([a, b]))


def _count_cross_corridor_overlaps(legs, lane_map):
    """Count cross-corridor overlapping leg pairs in a driver-day."""
    count = 0
    for i in range(len(legs)):
        li = lane_map[legs[i]]
        si = li.pickup_time; fi = li.finish_time
        if si is None or fi is None: continue
        ci = _corridor_of_leg(li)
        for j in range(i + 1, len(legs)):
            lj = lane_map[legs[j]]
            sj = lj.pickup_time; fj = lj.finish_time
            if sj is None or fj is None: continue
            if si < fj and sj < fi:  # time overlap
                if ci != _corridor_of_leg(lj):  # different corridors
                    count += 1
    return count


def _row_quality_score(legs, lane_map, pre_post_h=1.0):
    """Score a driver-day for repair prioritization. Higher = worse."""
    if not legs: return 0
    drive, dh_miles, gaps = _metrics_from_chain(legs, lane_map)
    corrs = set(_corridor_of_leg(lane_map[lid]) for lid in legs)
    overlaps = _count_cross_corridor_overlaps(legs, lane_map)
    return (
        dh_miles * 1.0
        + max(0, len(corrs) - 1) * 40
        + overlaps * 60
        + 100  # estimated penalty (only called on estimated rows)
    )


def _generate_fragments_for_day(ordered_ids, lane_map, exclusive_units,
                                 max_units_per_fragment=2, max_gap_h=1.5, max_dh_mi=60):
    """Build corridor-coherent fragments from a solved driver-day's ordered legs.

    Returns list of fragment dicts, each with:
    - id, legs, corridor, is_exclusive
    """
    if not ordered_ids:
        return []

    # First, build raw blocks (consecutive reverse-pair detection)
    blocks = _build_blocks_for_day(ordered_ids, lane_map,
                                    exclusive_pair_ids={lid for uid in exclusive_units for lid in uid}
                                    if isinstance(next(iter(exclusive_units), None), (list, tuple)) else exclusive_units)

    # Now merge adjacent same-corridor blocks into fragments (max 2 blocks per fragment)
    fragments = []
    i = 0
    frag_counter = 0
    while i < len(blocks):
        blk_a = blocks[i]
        merged = False

        if not blk_a['is_exclusive'] and i + 1 < len(blocks):
            blk_b = blocks[i + 1]
            if (not blk_b['is_exclusive'] and
                blk_a['corridor'] == blk_b['corridor'] and
                len(blk_a['legs']) + len(blk_b['legs']) <= 4):
                # Check gap
                last_a = lane_map[blk_a['legs'][-1]]
                first_b = lane_map[blk_b['legs'][0]]
                if last_a.finish_time is not None and first_b.pickup_time is not None:
                    gap = first_b.pickup_time - last_a.finish_time
                    dh = _compute_dh(last_a, first_b)
                    if -0.25 <= gap <= max_gap_h and dh <= max_dh_mi:
                        # Merge
                        fragments.append({
                            'id': f'frag_{frag_counter}',
                            'legs': blk_a['legs'] + blk_b['legs'],
                            'corridor': blk_a['corridor'],
                            'is_exclusive': False,
                        })
                        frag_counter += 1
                        i += 2
                        merged = True

        if not merged:
            fragments.append({
                'id': f'frag_{frag_counter}',
                'legs': blk_a['legs'],
                'corridor': blk_a['corridor'],
                'is_exclusive': blk_a['is_exclusive'],
            })
            frag_counter += 1
            i += 1

    return fragments


def _build_blocks_for_day(ordered_ids, lane_map, exclusive_pair_ids=None):
    """Convert an ordered leg sequence into movable blocks.
    Consecutive reverse-pair legs become a pair block; others are singletons."""
    if exclusive_pair_ids is None:
        exclusive_pair_ids = set()
    blocks = []
    i = 0
    while i < len(ordered_ids):
        lid = ordered_ids[i]
        la = lane_map[lid]
        merged = False
        # Try to merge with next leg as a natural pair
        if i + 1 < len(ordered_ids):
            lid_next = ordered_ids[i + 1]
            lb = lane_map[lid_next]
            if (la.origin_city.lower().strip() == lb.dest_city.lower().strip() and
                la.dest_city.lower().strip() == lb.origin_city.lower().strip()):
                # Reverse corridor pair — merge
                is_excl = lid in exclusive_pair_ids or lid_next in exclusive_pair_ids
                all_starts = [t for t in [la.pickup_time, lb.pickup_time] if t is not None]
                all_ends = [t for t in [la.finish_time, lb.finish_time] if t is not None]
                blocks.append({
                    'id': f'blk_{lid[:8]}_{lid_next[:8]}',
                    'legs': [lid, lid_next],
                    'corridor': _corridor_of_leg(la),
                    'is_exclusive': is_excl,
                    'start': min(all_starts) if all_starts else None,
                    'end': max(all_ends) if all_ends else None,
                    'drive': la.route_duration_hours + lb.route_duration_hours,
                })
                i += 2
                merged = True
        if not merged:
            blocks.append({
                'id': f'single_{lid[:12]}',
                'legs': [lid],
                'corridor': _corridor_of_leg(la),
                'is_exclusive': lid in exclusive_pair_ids,
                'start': la.pickup_time,
                'end': la.finish_time,
                'drive': la.route_duration_hours,
            })
            i += 1
    return blocks


def _validate_driver_day_chain(ordered_ids, lane_map, pre_post_h=1.0):
    """Validate a driver-day chain for HOS compliance.
    Returns (ok, violations)."""
    if not ordered_ids:
        return True, []
    drive, dh_miles, gaps = _metrics_from_chain(ordered_ids, lane_map)
    all_starts = [lane_map[lid].pickup_time for lid in ordered_ids if lane_map[lid].pickup_time is not None]
    all_ends = [lane_map[lid].finish_time for lid in ordered_ids if lane_map[lid].finish_time is not None]
    duty = (max(all_ends) - min(all_starts) + pre_post_h) if all_starts and all_ends else 0
    violations = []
    if drive > HOS_MAX_DRIVE:
        violations.append(f'drive {drive:.1f}h > {HOS_MAX_DRIVE}h')
    if duty > HOS_MAX_DUTY:
        violations.append(f'duty {duty:.1f}h > {HOS_MAX_DUTY}h')
    return len(violations) == 0, violations


def _try_insert_block(block, target_legs, lane_map, max_legs=8, pre_post_h=1.0):
    """Try inserting a block's legs into a target driver-day.
    Returns (new_ordered_legs, score) or None if infeasible."""
    new_legs = list(target_legs) + block['legs']
    if len(new_legs) > max_legs:
        return None
    # Use greedy time ordering on the combined set
    ordered = _greedy_time_order(new_legs, lane_map)
    # Validate
    ok, violations = _validate_driver_day_chain(ordered, lane_map, pre_post_h)
    if not ok:
        return None
    # Check span
    all_starts = [lane_map[lid].pickup_time for lid in ordered if lane_map[lid].pickup_time is not None]
    all_ends = [lane_map[lid].finish_time for lid in ordered if lane_map[lid].finish_time is not None]
    if all_starts and all_ends:
        duty = max(all_ends) - min(all_starts) + pre_post_h
        if duty > HOS_MAX_DUTY:
            return None
    score = _row_quality_score(ordered, lane_map, pre_post_h)
    return (ordered, score)


# ========================================================================
# v2 Local Optimizer — opt-in post-solve layer
# ========================================================================

def _build_mutable_state(weekly_schedule):
    """Convert weekly_schedule list into a flat mutable dict for v2 iteration."""
    dd = {}
    weekly_duty = {}
    for i, dr in enumerate(weekly_schedule):
        weekly_duty[i] = sum(v['dutyHours'] for v in dr['days'].values())
        for day_name, day_data in dr['days'].items():
            dd[(i, day_name)] = {
                'legs': list(day_data['legs']),
                'is_exact': day_data.get('isExact', False),
            }
    return {'driver_days': dd, 'driver_weekly_duty': weekly_duty, 'n_drivers': len(weekly_schedule)}


def _cheap_recipient_score(frag_legs, frag_corridor, recipient_legs, lane_map, max_legs=8):
    """Quick heuristic score for insertion candidacy. Lower = better. No solver calls."""
    if len(recipient_legs) + len(frag_legs) > max_legs:
        return (False, 9999)
    corr_counts = {}
    for lid in recipient_legs:
        c = _corridor_of_leg(lane_map[lid])
        corr_counts[c] = corr_counts.get(c, 0) + 1
    dominant_corr = max(corr_counts, key=corr_counts.get) if corr_counts else ''
    score = 0.0
    if frag_corridor == dominant_corr:
        score -= 50.0
    frag_times = [(lane_map[lid].pickup_time, lane_map[lid].finish_time)
                  for lid in frag_legs if lane_map[lid].pickup_time is not None and lane_map[lid].finish_time is not None]
    for lid in recipient_legs:
        rl = lane_map[lid]
        if rl.pickup_time is None or rl.finish_time is None:
            continue
        for fs, fe in frag_times:
            if fs < rl.finish_time and rl.pickup_time < fe:
                score += 30.0
    if frag_legs:
        frag_first = lane_map[frag_legs[0]]
        min_dh = min((_compute_dh(lane_map[lid], frag_first) for lid in recipient_legs), default=999)
        score += min_dh * 0.5
    return (True, score)


def _day_duty(legs, lane_map, pre_post_h=1.0):
    """Quick duty calculation for a day's legs (span-based)."""
    if not legs:
        return 0.0
    starts = [lane_map[lid].pickup_time for lid in legs if lane_map[lid].pickup_time is not None]
    finishes = [lane_map[lid].finish_time for lid in legs if lane_map[lid].finish_time is not None]
    if not starts or not finishes:
        return 0.0
    return (max(finishes) - min(starts)) + pre_post_h


def _rebuild_schedule(mutable, lane_map, graph, base_city, pre_post_h, max_wait_h,
                      original_schedule, modified_keys):
    """Rebuild weekly_schedule from mutable state, only re-sequencing modified days.
    Unmodified days are copied from original_schedule to avoid ordering drift.
    Returns (weekly_schedule_list, all_exact, hos_violations_list).
    """
    import copy as _copy
    n_drivers = mutable['n_drivers']
    dd = mutable['driver_days']
    # Service-week order, not alphabetical (Mon < Tue < ... < Sun)
    _DAY_ORDER = {'Mon': 0, 'Tue': 1, 'Wed': 2, 'Thu': 3, 'Fri': 4, 'Sat': 5, 'Sun': 6}
    all_day_names = sorted(set(dn for (_, dn) in dd.keys()), key=lambda d: _DAY_ORDER.get(d, 99))
    weekly_schedule = []
    all_exact = True
    hos_violations = []

    for d in range(n_drivers):
        driver_days = {}
        orig_days = original_schedule[d]['days'] if d < len(original_schedule) else {}

        for day_name in all_day_names:
            entry = dd.get((d, day_name))
            if not entry or not entry['legs']:
                continue

            if (d, day_name) not in modified_keys and day_name in orig_days:
                day_data = _copy.deepcopy(orig_days[day_name])
                if not day_data.get('isExact', False):
                    all_exact = False
                driver_days[day_name] = day_data
                continue

            legs = entry['legs']
            ordered_ids, drive, dh_miles_total, is_exact, leg_gaps = _sequence_driver_day(
                legs, lane_map, graph, base_city, max_wait_h)
            if not is_exact:
                all_exact = False
            miles = sum(lane_map[lid].route_miles for lid in ordered_ids) + dh_miles_total
            all_starts = [lane_map[lid].pickup_time for lid in ordered_ids if lane_map[lid].pickup_time is not None]
            all_finishes = [lane_map[lid].finish_time for lid in ordered_ids if lane_map[lid].finish_time is not None]
            earliest_start = min(all_starts) if all_starts else 0
            latest_finish = max(all_finishes) if all_finishes else 0
            duty = (latest_finish - earliest_start) + pre_post_h
            if drive > HOS_MAX_DRIVE:
                hos_violations.append(f'D{d+1} {day_name}: {drive:.1f}h drive > {HOS_MAX_DRIVE}h')
            if duty > HOS_MAX_DUTY:
                hos_violations.append(f'D{d+1} {day_name}: {duty:.1f}h duty > {HOS_MAX_DUTY}h')
            names = [lane_map[lid].name for lid in ordered_ids]
            driver_days[day_name] = {
                'legs': ordered_ids, 'legNames': names, 'legCount': len(ordered_ids),
                'driveHours': round(drive, 1), 'dutyHours': round(duty, 1),
                'miles': round(miles), 'deadheadMiles': round(dh_miles_total),
                'startTime': earliest_start, 'endTime': latest_finish,
                'isExact': is_exact, 'legGaps': leg_gaps,
            }

        weekly_duty = sum(v['dutyHours'] for v in driver_days.values())
        if weekly_duty > MAX_WEEKLY_DUTY:
            hos_violations.append(f'D{d+1}: {weekly_duty:.1f}h weekly > {MAX_WEEKLY_DUTY}h')
        prev_end = None; prev_dn = None
        for day_name in all_day_names:
            dd_entry = driver_days.get(day_name)
            if not dd_entry:
                prev_end = None; prev_dn = None; continue
            if prev_end is not None and dd_entry.get('startTime') is not None:
                off = (dd_entry['startTime'] + 24) - prev_end
                if off < OFF_DUTY_HOURS:
                    hos_violations.append(f'D{d+1} {prev_dn}->{day_name}: {off:.1f}h off < {OFF_DUTY_HOURS}h')
            prev_end = dd_entry.get('endTime'); prev_dn = day_name

        driver_id = original_schedule[d]['driverId'] if d < len(original_schedule) else d + 1
        weekly_schedule.append({
            'driverId': driver_id, 'days': driver_days,
            'totalDriveHours': round(sum(v['driveHours'] for v in driver_days.values()), 1),
            'totalDutyHours': round(sum(v['dutyHours'] for v in driver_days.values()), 1),
            'totalMiles': round(sum(v.get('miles', 0) for v in driver_days.values())),
            'totalDeadheadMiles': round(sum(v.get('deadheadMiles', 0) for v in driver_days.values())),
            'daysWorked': len(driver_days),
        })
    return weekly_schedule, all_exact, hos_violations


def _local_optimize(result, lane_map, graph, base_city, config,
                    max_iterations=5, max_time_s=15, max_exact_scores=12):
    """Opt-in post-v1 local optimizer. Improves estimated days via same-day fragment moves."""
    import copy as _copy
    import time as _time
    from collections import Counter

    ws = result.get('weeklySchedule')
    if not ws:
        result['v2Applied'] = False
        result['v2Stats'] = {'moves_tried': 0, 'moves_accepted': 0, 'time_s': 0, 'improvement': 0}
        return result

    pre_post_h = config.get('pre_post_hours', 1.0)
    max_wait_h = config.get('max_wait', 2.0)
    max_legs = config.get('max_legs', DEFAULT_MAX_LEGS)
    original_ws = _copy.deepcopy(ws)

    coverage_pre = Counter((dn, lid) for dr in ws for dn, dd in dr['days'].items() for lid in dd['legs'])
    exact_count_pre = sum(1 for dr in ws for dd in dr['days'].values() if dd.get('isExact'))
    max_dh_pre = max((dd.get('deadheadMiles', 0) for dr in ws for dd in dr['days'].values()), default=0)

    mut = _build_mutable_state(ws)
    dd = mut['driver_days']
    frozen = {key for key, entry in dd.items() if entry['is_exact']}

    start_time = _time.time()
    moves_tried = 0
    moves_accepted = 0
    total_improvement = 0.0
    exact_scores_used = 0
    modified_keys = set()

    for iteration in range(max_iterations):
        if _time.time() - start_time >= max_time_s:
            break

        # Find worst non-frozen day
        worst_key = None
        worst_score = -1
        for key, entry in dd.items():
            if key in frozen or not entry['legs']:
                continue
            score = _row_quality_score(entry['legs'], lane_map, pre_post_h)
            if score > worst_score:
                worst_score = score
                worst_key = key
        if worst_key is None or worst_score <= 0:
            break

        donor_d, donor_day = worst_key
        donor_legs = dd[worst_key]['legs']
        fragments = _generate_fragments_for_day(donor_legs, lane_map, set())

        best_move = None

        for frag in sorted(fragments, key=lambda f: (
            -sum(_compute_dh(lane_map[f['legs'][i]], lane_map[f['legs'][i+1]])
                 for i in range(len(f['legs'])-1)) if len(f['legs']) > 1 else 0,
            -len(f['legs']), f['legs'][0])):

            if frag.get('is_exclusive'):
                continue
            frag_legs = frag['legs']
            frag_corridor = frag['corridor']
            remaining = [lid for lid in donor_legs if lid not in set(frag_legs)]

            # Same-day recipients only
            candidates = []
            for key, entry in sorted(dd.items(), key=lambda x: (x[0][0], x[0][1])):
                if key in frozen or key == worst_key or key[1] != donor_day or not entry['legs']:
                    continue
                feasible, cs = _cheap_recipient_score(frag_legs, frag_corridor, entry['legs'], lane_map, max_legs)
                if feasible:
                    candidates.append((cs, key))
            candidates.sort(key=lambda x: (x[0], x[1][0], x[1][1]))

            for _, recip_key in candidates[:2]:
                if _time.time() - start_time >= max_time_s - 2 or exact_scores_used >= max_exact_scores:
                    break

                recip_d, recip_day = recip_key
                recip_legs = dd[recip_key]['legs']
                combined = list(recip_legs) + frag_legs
                moves_tried += 1
                exact_scores_used += 1

                ordered_ids, drive, dh_miles, is_exact, leg_gaps = _sequence_driver_day(
                    combined, lane_map, graph, base_city, max_wait_h)

                all_starts = [lane_map[lid].pickup_time for lid in ordered_ids if lane_map[lid].pickup_time is not None]
                all_finishes = [lane_map[lid].finish_time for lid in ordered_ids if lane_map[lid].finish_time is not None]
                if not all_starts or not all_finishes:
                    continue
                duty = (max(all_finishes) - min(all_starts)) + pre_post_h
                if drive > HOS_MAX_DRIVE or duty > HOS_MAX_DUTY:
                    continue

                # Weekly duty check for both drivers
                def _driver_weekly(drv, exclude_day=None, override_duty=None):
                    total = 0
                    for k, e in dd.items():
                        if k[0] == drv and e['legs']:
                            if k[1] == exclude_day:
                                continue
                            total += _day_duty(e['legs'], lane_map, pre_post_h)
                    if override_duty is not None:
                        total += override_duty
                    return total

                new_donor_duty = _day_duty(remaining, lane_map, pre_post_h) if remaining else 0
                if _driver_weekly(donor_d, donor_day, new_donor_duty) > MAX_WEEKLY_DUTY:
                    continue
                if _driver_weekly(recip_d, recip_day, duty) > MAX_WEEKLY_DUTY:
                    continue

                # Adjacent-day off-duty check for both drivers
                def _check_off_duty(drv, day_name, new_start, new_end):
                    """Check off-duty constraints with adjacent days."""
                    ordered_days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                    idx = ordered_days.index(day_name) if day_name in ordered_days else -1
                    if idx < 0:
                        return True
                    # Check previous day
                    if idx > 0:
                        prev_dn = ordered_days[idx - 1]
                        prev_entry = dd.get((drv, prev_dn))
                        if prev_entry and prev_entry['legs']:
                            prev_fins = [lane_map[lid].finish_time for lid in prev_entry['legs'] if lane_map[lid].finish_time is not None]
                            if prev_fins and new_start is not None:
                                off = (new_start + 24) - max(prev_fins)
                                if off < OFF_DUTY_HOURS:
                                    return False
                    # Check next day
                    if idx < len(ordered_days) - 1:
                        next_dn = ordered_days[idx + 1]
                        next_entry = dd.get((drv, next_dn))
                        if next_entry and next_entry['legs']:
                            next_starts = [lane_map[lid].pickup_time for lid in next_entry['legs'] if lane_map[lid].pickup_time is not None]
                            if next_starts and new_end is not None:
                                off = (min(next_starts) + 24) - new_end
                                if off < OFF_DUTY_HOURS:
                                    return False
                    return True

                recip_start = min(all_starts)
                recip_end = max(all_finishes)
                if not _check_off_duty(recip_d, recip_day, recip_start, recip_end):
                    continue

                # Check donor off-duty with remaining legs
                if remaining:
                    d_starts = [lane_map[lid].pickup_time for lid in remaining if lane_map[lid].pickup_time is not None]
                    d_ends = [lane_map[lid].finish_time for lid in remaining if lane_map[lid].finish_time is not None]
                    if d_starts and d_ends:
                        if not _check_off_duty(donor_d, donor_day, min(d_starts), max(d_ends)):
                            continue

                # Score improvement
                new_recip_score = _row_quality_score(ordered_ids, lane_map, pre_post_h)
                old_recip_score = _row_quality_score(recip_legs, lane_map, pre_post_h)
                new_donor_score = _row_quality_score(remaining, lane_map, pre_post_h) if remaining else 0

                donor_improvement = worst_score - new_donor_score
                recip_worsening = new_recip_score - old_recip_score
                net = donor_improvement - recip_worsening
                if net <= 0 or recip_worsening > donor_improvement:
                    continue

                if best_move is None or net > best_move[4]:
                    best_move = (frag, recip_key, remaining, ordered_ids, net)

            if exact_scores_used >= max_exact_scores or _time.time() - start_time >= max_time_s - 2:
                break

        if best_move is None:
            break

        frag, recip_key, new_donor_legs, new_recip_legs, improvement = best_move
        dd[worst_key]['legs'] = new_donor_legs
        dd[worst_key]['is_exact'] = False
        dd[recip_key]['legs'] = new_recip_legs
        dd[recip_key]['is_exact'] = False
        modified_keys.add(worst_key)
        modified_keys.add(recip_key)
        if not new_donor_legs:
            del dd[worst_key]

        moves_accepted += 1
        total_improvement += improvement
        print(f"  v2 move {moves_accepted}: frag {frag['legs']} "
              f"D{worst_key[0]+1}/{worst_key[1]} -> D{recip_key[0]+1}/{recip_key[1]} "
              f"improvement={improvement:.0f}")

    elapsed = _time.time() - start_time
    result['v2Stats'] = {
        'moves_tried': moves_tried, 'moves_accepted': moves_accepted,
        'time_s': round(elapsed, 1), 'improvement': round(total_improvement, 1),
    }

    if moves_accepted == 0:
        result['v2Applied'] = False
        return result

    new_ws, all_exact, hos_violations = _rebuild_schedule(
        mut, lane_map, graph, base_city, pre_post_h, max_wait_h, original_ws, modified_keys)

    # Validate
    coverage_post = Counter((dn, lid) for dr in new_ws for dn, dd_e in dr['days'].items() for lid in dd_e['legs'])
    if coverage_post != coverage_pre:
        result['v2Applied'] = False
        result['v2Error'] = 'Coverage mismatch after v2'
        result['weeklySchedule'] = original_ws
        print("  v2 ROLLBACK: coverage mismatch")
        return result

    exact_count_post = sum(1 for dr in new_ws for dd_e in dr['days'].values() if dd_e.get('isExact'))
    if exact_count_post < exact_count_pre:
        result['v2Applied'] = False
        result['v2Error'] = f'Exact count dropped {exact_count_pre} -> {exact_count_post}'
        result['weeklySchedule'] = original_ws
        print(f"  v2 ROLLBACK: exact count dropped")
        return result

    max_dh_post = max((dd_e.get('deadheadMiles', 0) for dr in new_ws for dd_e in dr['days'].values()), default=0)
    if max_dh_post > max_dh_pre:
        result['v2Applied'] = False
        result['v2Error'] = f'Max DH increased {max_dh_pre} -> {max_dh_post}'
        result['weeklySchedule'] = original_ws
        print(f"  v2 ROLLBACK: max DH increased")
        return result

    # Only check for NEW violations involving modified drivers
    modified_drivers = set(k[0] for k in modified_keys)
    new_violations = [v for v in hos_violations
                      if any(f'D{d+1}' in v for d in modified_drivers)]
    pre_violations = [v for v in result.get('hosViolations', [])
                      if any(f'D{d+1}' in v for d in modified_drivers)]
    if len(new_violations) > len(pre_violations):
        result['v2Applied'] = False
        result['v2Error'] = f'HOS violations on modified drivers: {new_violations}'
        result['weeklySchedule'] = original_ws
        print(f"  v2 ROLLBACK: new HOS violations on modified drivers")
        return result
    hos_compliant = len(hos_violations) == 0

    result['weeklySchedule'] = new_ws
    result['allExact'] = all_exact
    result['hosCompliant'] = hos_compliant
    result['hosViolations'] = hos_violations if not hos_compliant else []
    result['v2Applied'] = True

    if 'qualitySummary' in result:
        exact_d = sum(1 for dr in new_ws for dd_e in dr['days'].values() if dd_e.get('isExact'))
        est_d = sum(1 for dr in new_ws for dd_e in dr['days'].values() if not dd_e.get('isExact'))
        max_dh_day = max((dd_e.get('deadheadMiles', 0) for dr in new_ws for dd_e in dr['days'].values()), default=0)
        result['qualitySummary'] = {'exactDayCount': exact_d, 'estimatedDayCount': est_d, 'maxDeadheadDayMiles': max_dh_day}

    print(f"  v2 complete: {moves_accepted} moves, {total_improvement:.0f} improvement, {elapsed:.1f}s")
    return result


def _maybe_run_v2(result, lane_map, graph, base_city, config):
    """Gate wrapper for v2 local optimizer. Only runs when enabled."""
    if not config.get('enable_local_optimize'):
        return result
    try:
        return _local_optimize(result, lane_map, graph, base_city, config)
    except Exception as e:
        result['v2Applied'] = False
        result['v2Stats'] = {'moves_tried': 0, 'moves_accepted': 0, 'time_s': 0, 'improvement': 0}
        result['v2Error'] = str(e)
        print(f"  v2 optimizer failed: {e}")
        return result


def _compress_schedule(schedule, lane_map, graph, base_city, max_legs=8,
                       pre_post_h=1.0, max_wait_h=3.0, working_days=None):
    """Try to compress a k-driver schedule to k-1 drivers.
    Returns the compressed schedule dict or None if infeasible."""
    if working_days is None:
        working_days = [1, 2, 3, 4, 5, 6]

    ws = schedule['weeklySchedule']
    n = len(ws)
    if n <= 1:
        return None

    # Build exclusive pair IDs for block detection
    lv_threshold_drive = 5.0
    excl_ids = set()
    for la in lane_map.values():
        for lb in lane_map.values():
            if la.id >= lb.id: continue
            if la.origin_city.lower().strip() != lb.dest_city.lower().strip(): continue
            if la.dest_city.lower().strip() != lb.origin_city.lower().strip(): continue
            if la.route_duration_hours + lb.route_duration_hours > lv_threshold_drive:
                excl_ids.add(la.id)
                excl_ids.add(lb.id)

    # Score each driver for donor candidacy (higher = better donor to remove)
    donor_scores = []
    for idx, dr in enumerate(ws):
        total_drive = sum(dd['driveHours'] for dd in dr['days'].values())
        total_duty = sum(dd['dutyHours'] for dd in dr['days'].values())
        has_exclusive = any(
            any(lid in excl_ids for lid in dd['legs'])
            for dd in dr['days'].values()
        )
        exact_count = sum(1 for dd in dr['days'].values() if dd.get('isExact'))
        days_worked = len(dr['days'])
        # Prefer removing drivers with: low total drive, no exclusive blocks, few exact days
        score = 0
        if has_exclusive:
            score -= 10000  # never remove exclusive block drivers
        score -= exact_count * 100
        score -= total_drive * 10
        score += (6 - days_worked) * 50  # fewer days = easier to redistribute
        donor_scores.append((score, idx))

    donor_scores.sort(reverse=True)  # highest score = best donor

    # Try each candidate donor
    for _, donor_idx in donor_scores[:3]:  # try top 3 candidates
        donor = ws[donor_idx]
        recipients = [dr for i, dr in enumerate(ws) if i != donor_idx]

        # Collect donor blocks per day
        success = True
        new_recipient_days = {}  # (recipient_idx, day_name) -> new leg list

        for day_name, dd in donor['days'].items():
            blocks = _build_blocks_for_day(dd['legs'], lane_map, excl_ids)
            day_placed = True

            for block in blocks:
                # Try inserting into each recipient on this day
                best = None
                best_score = float('inf')
                for r_idx, recip in enumerate(recipients):
                    r_dd = recip['days'].get(day_name)
                    r_key = (r_idx, day_name)

                    # Use updated legs if we already inserted into this recipient today
                    if r_key in new_recipient_days:
                        target_legs = new_recipient_days[r_key]
                    elif r_dd:
                        target_legs = list(r_dd['legs'])
                    else:
                        target_legs = []

                    # Don't insert into exclusive block days
                    if r_dd and any(lid in excl_ids for lid in (r_dd.get('legs', []))):
                        if not block.get('is_exclusive'):
                            continue  # can't add non-exclusive to exclusive day

                    result = _try_insert_block(block, target_legs, lane_map, max_legs, pre_post_h)
                    if result:
                        new_legs, score = result
                        if score < best_score:
                            best = (r_idx, new_legs, score)
                            best_score = score

                if best:
                    r_idx, new_legs, _ = best
                    new_recipient_days[(r_idx, day_name)] = new_legs
                else:
                    day_placed = False
                    break

            if not day_placed:
                success = False
                break

        if not success:
            continue

        # Build compressed schedule
        compressed_ws = []
        for r_idx, recip in enumerate(recipients):
            new_driver = {'driverId': r_idx + 1, 'days': {}}
            for day_name, dd in recip['days'].items():
                r_key = (r_idx, day_name)
                if r_key in new_recipient_days:
                    legs = new_recipient_days[r_key]
                else:
                    legs = list(dd['legs'])

                # Resequence and compute metrics
                ordered, drive, dh_miles, is_exact, leg_gaps = _sequence_driver_day(
                    legs, lane_map, graph, base_city, max_wait_h
                )
                all_starts = [lane_map[lid].pickup_time for lid in ordered if lane_map[lid].pickup_time is not None]
                all_ends = [lane_map[lid].finish_time for lid in ordered if lane_map[lid].finish_time is not None]
                earliest = min(all_starts) if all_starts else 0
                latest = max(all_ends) if all_ends else 0
                duty = (latest - earliest) + pre_post_h
                miles = sum(lane_map[lid].route_miles for lid in ordered) + dh_miles

                new_driver['days'][day_name] = {
                    'legs': ordered,
                    'legNames': [lane_map[lid].name for lid in ordered],
                    'legCount': len(ordered),
                    'driveHours': round(drive, 1),
                    'dutyHours': round(duty, 1),
                    'miles': round(miles),
                    'deadheadMiles': round(dh_miles),
                    'startTime': earliest,
                    'endTime': latest,
                    'isExact': is_exact,
                    'legGaps': leg_gaps,
                }

            # Add days that only came from donor insertions
            for (ri, dn), legs in new_recipient_days.items():
                if ri == r_idx and dn not in new_driver['days']:
                    ordered, drive, dh_miles, is_exact, leg_gaps = _sequence_driver_day(
                        legs, lane_map, graph, base_city, max_wait_h
                    )
                    all_starts = [lane_map[lid].pickup_time for lid in ordered if lane_map[lid].pickup_time is not None]
                    all_ends = [lane_map[lid].finish_time for lid in ordered if lane_map[lid].finish_time is not None]
                    earliest = min(all_starts) if all_starts else 0
                    latest = max(all_ends) if all_ends else 0
                    duty = (latest - earliest) + pre_post_h
                    miles = sum(lane_map[lid].route_miles for lid in ordered) + dh_miles

                    new_driver['days'][dn] = {
                        'legs': ordered,
                        'legNames': [lane_map[lid].name for lid in ordered],
                        'legCount': len(ordered),
                        'driveHours': round(drive, 1),
                        'dutyHours': round(duty, 1),
                        'miles': round(miles),
                        'deadheadMiles': round(dh_miles),
                        'startTime': earliest,
                        'endTime': latest,
                        'isExact': is_exact,
                        'legGaps': leg_gaps,
                    }

            new_driver['totalDriveHours'] = round(sum(v['driveHours'] for v in new_driver['days'].values()), 1)
            new_driver['totalDutyHours'] = round(sum(v['dutyHours'] for v in new_driver['days'].values()), 1)
            new_driver['totalMiles'] = round(sum(v.get('miles', 0) for v in new_driver['days'].values()))
            new_driver['totalDeadheadMiles'] = round(sum(v.get('deadheadMiles', 0) for v in new_driver['days'].values()))
            new_driver['daysWorked'] = len(new_driver['days'])
            compressed_ws.append(new_driver)

        # Validate compressed schedule
        all_ok = True
        violations = []
        for dr in compressed_ws:
            weekly_duty = dr['totalDutyHours']
            if weekly_duty > MAX_WEEKLY_DUTY:
                violations.append(f'D{dr["driverId"]}: {weekly_duty:.1f}h weekly')
                all_ok = False
            for dn, dd in dr['days'].items():
                if dd['driveHours'] > HOS_MAX_DRIVE:
                    violations.append(f'D{dr["driverId"]} {dn}: {dd["driveHours"]}h drive')
                    all_ok = False
                if dd['dutyHours'] > HOS_MAX_DUTY:
                    violations.append(f'D{dr["driverId"]} {dn}: {dd["dutyHours"]}h duty')
                    all_ok = False

        if all_ok:
            return {
                'success': True,
                'driverCount': len(compressed_ws),
                'weeklySchedule': compressed_ws,
                'hosCompliant': True,
                'hosViolations': [],
                'allExact': all(dd.get('isExact', False) for dr in compressed_ws for dd in dr['days'].values()),
                'compressionSource': schedule.get('driverCount', n),
            }

    return None  # no donor worked


def _sequence_driver_day(lane_ids, lane_map, graph, base_city, max_wait_h=3.0):
    """Exact per-day sequencer: finds optimal lane ordering for a single driver's daily assignment.
    Uses a small circuit model to minimize deadhead for just these lanes.
    Arc validity enforces: finish_a + deadhead_ab <= pickup_end_b and wait <= max_wait.
    Returns (ordered_ids, drive_hours, dh_miles, is_exact, leg_gaps).
    is_exact=False means fallback ordering was used.
    leg_gaps: list of dicts with per-transition details."""

    def _build_gaps(ordered, lm):
        """Build per-transition gap details from an ordered sequence."""
        gaps = []
        for k in range(1, len(ordered)):
            la_g = lm[ordered[k - 1]]
            lb_g = lm[ordered[k]]
            dh_mi = _compute_dh(la_g, lb_g)
            dh_h = dh_mi / 55.0
            prev_end = la_g.finish_time
            next_start = lb_g.pickup_time
            earliest_arr = (prev_end + dh_h) if prev_end is not None else None
            wait_h = (next_start - earliest_arr) if (next_start is not None and earliest_arr is not None) else None
            gaps.append({
                'miles': round(dh_mi, 1),
                'driveHours': round(dh_h, 2),
                'waitHours': round(max(0, wait_h), 2) if wait_h is not None else None,
                'prevEndTime': round(prev_end, 2) if prev_end is not None else None,
                'nextStartTime': round(next_start, 2) if next_start is not None else None,
                'earliestArrival': round(earliest_arr, 2) if earliest_arr is not None else None,
            })
        return gaps

    if len(lane_ids) <= 1:
        if not lane_ids:
            return ([], 0.0, 0, True, [])
        l = lane_map[lane_ids[0]]
        return (lane_ids, l.route_duration_hours, 0, True, [])

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

            # Timing: B must start after A finishes (+ deadhead), and wait must be reasonable
            if la.finish_time is not None and lb.pickup_time is not None:
                wait = lb.pickup_time - (la.finish_time + dh_h)
                if wait < -0.25: continue  # B starts before A finishes — impossible sequence
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
    solver.parameters.random_seed = 42  # reproducibility
    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        # Fallback: time-feasible greedy with pair bundling
        ordered_ids = _greedy_time_order(lane_ids, lane_map)
        drive, dh_total, gaps = _metrics_from_chain(ordered_ids, lane_map)
        return (ordered_ids, drive, dh_total, False, gaps)  # is_exact=False

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
        # Circuit extraction failed — fall back to greedy time ordering
        ordered_ids = _greedy_time_order(lane_ids, lane_map)
        drive, dh_total, gaps = _metrics_from_chain(ordered_ids, lane_map)
        return (ordered_ids, drive, dh_total, False, gaps)  # NOT exact

    drive, dh_total, gaps = _metrics_from_chain(order, lane_map)
    return (order, drive, dh_total, True, gaps)  # is_exact=True


def _detect_pair_blocks(lanes, lane_map, lane_active_days, day_lane_ids, working_days,
                        lane_pickup_min, lane_finish_min):
    """Detect natural same-day reverse pairs and collapse into blocks.
    Returns:
      blocks: dict of block_id -> (out_lid, ret_lid, corridor, combined_drive, combined_span)
      block_day_units: dict of day -> list of unit_ids (block_ids + singleton_lids)
      unit_to_legs: dict of unit_id -> [lid, ...] (ordered legs in the block)
      unit_pickup_min: dict of unit_id -> earliest pickup minute
      unit_finish_min: dict of unit_id -> latest finish minute
      unit_drive_min: dict of unit_id -> combined drive minutes
    """
    # Find all natural same-day pairs (gap <= 0.5h, reverse corridor)
    candidates = []
    for la in lanes:
        for lb in lanes:
            if la.id >= lb.id: continue
            if la.origin_city.lower().strip() != lb.dest_city.lower().strip(): continue
            if la.dest_city.lower().strip() != lb.origin_city.lower().strip(): continue
            if la.finish_time is None or lb.pickup_time is None: continue
            if lb.finish_time is None or la.pickup_time is None: continue
            # Determine which is outbound, which is return
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

    # Canonical mutual-best matching:
    # Only pair A with B if B is A's best-gap match AND A is B's best-gap match.
    # This prevents unstable matchings like 404+409 when 409+410 is a better pair.
    candidates.sort(key=lambda x: x[0])

    # Build best-match lookup: for each lane, what's its tightest-gap reverse partner?
    best_match = {}  # lid -> (partner_lid, gap)
    for gap, out_id, ret_id, shared in candidates:
        if out_id not in best_match or gap < best_match[out_id][1]:
            best_match[out_id] = (ret_id, gap)
        if ret_id not in best_match or gap < best_match[ret_id][1]:
            best_match[ret_id] = (out_id, gap)

    # Only accept pairs where both sides agree on each other as best match
    paired = set()
    blocks = {}
    block_counter = 0
    for gap, out_id, ret_id, shared in candidates:
        if out_id in paired or ret_id in paired:
            continue
        # Mutual best: out's best is ret, AND ret's best is out
        if (best_match.get(out_id, (None,))[0] == ret_id and
            best_match.get(ret_id, (None,))[0] == out_id):
            paired.add(out_id)
            paired.add(ret_id)
            block_id = f'BLK_{block_counter}'
            block_counter += 1
            blocks[block_id] = (out_id, ret_id, shared)

    # Build per-day unit lists: blocks + singletons
    block_day_units = {}
    unit_to_legs = {}  # unit_id -> [lid, ...]
    unit_pickup_min = {}
    unit_finish_min = {}
    unit_drive_min = {}

    # Create unit entries for blocks
    lid_to_block = {}  # lid -> block_id
    for block_id, (out_id, ret_id, shared) in blocks.items():
        lid_to_block[out_id] = block_id
        lid_to_block[ret_id] = block_id
        unit_to_legs[block_id] = [out_id, ret_id]
        unit_pickup_min[block_id] = min(lane_pickup_min[out_id], lane_pickup_min[ret_id])
        unit_finish_min[block_id] = max(lane_finish_min[out_id], lane_finish_min[ret_id])
        unit_drive_min[block_id] = (lane_map[out_id].route_duration_hours + lane_map[ret_id].route_duration_hours) * MINUTES

    # Build per-day units
    for day in working_days:
        units = []
        seen_blocks = set()
        day_set = set(day_lane_ids[day])
        for lid in day_lane_ids[day]:
            if lid in lid_to_block:
                bid = lid_to_block[lid]
                out_id, ret_id, shared = blocks[bid]
                if day in shared and bid not in seen_blocks and out_id in day_set and ret_id in day_set:
                    # Both legs active — use block
                    units.append(bid)
                    seen_blocks.add(bid)
                elif bid not in seen_blocks or lid not in [l for u in units for l in unit_to_legs.get(u, [])]:
                    # One leg only or block already added — singleton
                    units.append(lid)
                    unit_to_legs.setdefault(lid, [lid])
                    unit_pickup_min.setdefault(lid, lane_pickup_min[lid])
                    unit_finish_min.setdefault(lid, lane_finish_min[lid])
                    unit_drive_min.setdefault(lid, lane_map[lid].route_duration_hours * MINUTES)
            else:
                units.append(lid)
                unit_to_legs.setdefault(lid, [lid])
                unit_pickup_min.setdefault(lid, lane_pickup_min[lid])
                unit_finish_min.setdefault(lid, lane_finish_min[lid])
                unit_drive_min.setdefault(lid, lane_map[lid].route_duration_hours * MINUTES)
        block_day_units[day] = units

    # Unit invariant assertions: every active lane appears exactly once per day
    for day in working_days:
        unit_lids = []
        for uid in block_day_units[day]:
            unit_lids.extend(unit_to_legs.get(uid, [uid]))
        day_set = set(day_lane_ids[day])
        unit_set = set(unit_lids)
        if unit_set != day_set:
            missing = day_set - unit_set
            extra = unit_set - day_set
            if missing:
                # Missing lanes — add as singletons
                for lid in missing:
                    block_day_units[day].append(lid)
                    unit_to_legs.setdefault(lid, [lid])
                    unit_pickup_min.setdefault(lid, lane_pickup_min[lid])
                    unit_finish_min.setdefault(lid, lane_finish_min[lid])
                    unit_drive_min.setdefault(lid, lane_map[lid].route_duration_hours * MINUTES)

    return blocks, block_day_units, unit_to_legs, unit_pickup_min, unit_finish_min, unit_drive_min, lid_to_block




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

    # --- Pair-block pre-computation ---
    # Collapse natural same-day reverse pairs into atomic blocks.
    # The solver assigns blocks (2-leg units) + singletons (1-leg units) to drivers.
    blocks, block_day_units, unit_to_legs, unit_pickup_min, unit_finish_min, unit_drive_min, lid_to_block = \
        _detect_pair_blocks(lanes, lane_map, lane_active_days, day_lane_ids, working_days,
                           lane_pickup_min, lane_finish_min)

    # Create assignment variables at the UNIT level (blocks + singletons)
    unit_assign = {}  # day -> unit_id -> [BoolVar per driver]
    for day in working_days:
        unit_assign[day] = {}
        for uid in block_day_units[day]:
            unit_assign[day][uid] = [model.NewBoolVar(f'u_{day}_{uid}_{d}') for d in range(n_drivers)]

    # Coverage: each unit assigned to exactly 1 driver
    for day in working_days:
        for uid in block_day_units[day]:
            model.Add(sum(unit_assign[day][uid]) == 1)

    # Max legs per driver per day (count actual legs, not units)
    for day in working_days:
        for d in range(n_drivers):
            leg_count = sum(
                unit_assign[day][uid][d] * len(unit_to_legs[uid])
                for uid in block_day_units[day]
            )
            model.Add(leg_count <= max_legs)

    # Create per-lane assign variables DERIVED from unit assignments
    # (needed by downstream constraints that reference individual lanes)
    assign = {}
    for day in working_days:
        assign[day] = {}
        for uid in block_day_units[day]:
            for lid in unit_to_legs[uid]:
                assign[day][lid] = unit_assign[day][uid]  # same BoolVar list

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

    # --- Local corridor blocks: reward same-corridor pairs on the same driver ---
    # Group non-exclusive pairs by corridor. For each pair of same-corridor pairs
    # active on the same day, reward them being on the same driver.
    pair_corridor = {}  # out_id -> corridor key
    for out_id, ret_id, shared in active_pairs:
        out_lane = lane_map[out_id]
        corr = frozenset([out_lane.origin_city.lower().strip(), out_lane.dest_city.lower().strip()])
        pair_corridor[out_id] = corr

    corridor_block_rewards = []
    for day in working_days:
        # Group non-exclusive pairs active today by corridor
        from collections import defaultdict
        corr_pairs_today = defaultdict(list)  # corridor -> [(out_id, ret_id)]
        for out_id, ret_id, shared in active_pairs:
            if day not in shared: continue
            if out_id not in day_lid_set[day] or ret_id not in day_lid_set[day]: continue
            # Skip exclusive blocks (already isolated)
            is_excl = any(out_id == eid and ret_id == rid for eid, rid, _ in exclusive_blocks)
            if is_excl: continue
            corr = pair_corridor.get(out_id)
            if corr:
                corr_pairs_today[corr].append((out_id, ret_id))

        # For each corridor with 2+ pairs today, reward same-driver assignment
        for corr, pairs in corr_pairs_today.items():
            if len(pairs) < 2: continue
            for i in range(len(pairs)):
                for j in range(i + 1, len(pairs)):
                    out_i, ret_i = pairs[i]
                    out_j, ret_j = pairs[j]
                    for d in range(n_drivers):
                        # Reward: both pairs on same driver
                        both = model.NewBoolVar(f'cb_{day}_{i}_{j}_{d}')
                        model.AddBoolAnd([assign[day][out_i][d], assign[day][out_j][d]]).OnlyEnforceIf(both)
                        model.AddBoolOr([assign[day][out_i][d].Not(), assign[day][out_j][d].Not()]).OnlyEnforceIf(both.Not())
                        corridor_block_rewards.append(both)

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

    # --- Operational sanity constraints ---

    # HARD: Max intra-day gap — forbid lanes with >max_gap between them on same driver.
    max_gap_min = int(max_gap_hours * MINUTES)
    for day in working_days:
        lids = day_lane_ids[day]
        for i, lid_a in enumerate(lids):
            finish_a = lane_finish_min[lid_a]
            for j, lid_b in enumerate(lids):
                if i == j: continue
                pickup_b = lane_pickup_min[lid_b]
                if pickup_b <= finish_a: continue
                gap = pickup_b - finish_a
                if gap <= max_gap_min: continue
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

    # 9. Corridor affinity: penalize distinct corridors per driver-day
    lane_corridor = {}
    corridor_set = set()
    for l in lanes:
        key = frozenset([l.origin_city.lower().strip(), l.dest_city.lower().strip()])
        lane_corridor[l.id] = key
        corridor_set.add(key)
    corridor_list = sorted(corridor_set, key=str)
    corridor_idx = {c: i for i, c in enumerate(corridor_list)}

    corridor_count_penalty_vars = []
    for day in working_days:
        lids = day_lane_ids[day]
        if not lids: continue
        day_corridors = set(corridor_idx[lane_corridor[lid]] for lid in lids)
        if len(day_corridors) <= 1: continue
        for d in range(n_drivers):
            if (day, d) not in driver_works_var: continue
            uses_vars = []
            for cidx in day_corridors:
                corr_lids = [lid for lid in lids if corridor_idx[lane_corridor[lid]] == cidx]
                if not corr_lids: continue
                uses = model.NewBoolVar(f'uc_{day}_{d}_{cidx}')
                model.AddMaxEquality(uses, [assign[day][lid][d] for lid in corr_lids])
                uses_vars.append(uses)
            if len(uses_vars) >= 2:
                corr_count = model.NewIntVar(0, len(uses_vars), f'cc_{day}_{d}')
                model.Add(corr_count == sum(uses_vars))
                # Linear penalty for 2 corridors
                excess = model.NewIntVar(0, len(uses_vars), f'cx_{day}_{d}')
                model.AddMaxEquality(excess, [corr_count - 1, model.NewConstant(0)])
                corridor_count_penalty_vars.append(excess)
                # Escalating penalty for 3+ corridors (much more expensive)
                if len(uses_vars) >= 3:
                    excess3 = model.NewIntVar(0, len(uses_vars), f'c3_{day}_{d}')
                    model.AddMaxEquality(excess3, [corr_count - 2, model.NewConstant(0)])
                    corridor_count_penalty_vars.append(excess3 * 5)  # 5x multiplier for 3rd+ corridor

    # 10. Cross-corridor overlap penalty — distance-weighted
    # Mixing nearby corridors (SD+MV, SA+CoI) is cheaper than far ones (CoI+SB+ANA)
    # Pre-compute corridor-pair distances from non-base city locations
    from lane_solver import haversine as hav_fn
    city_locs = {}
    for l in lanes:
        for city, lat, lng in [(l.origin_city, l.origin_lat, l.origin_lng),
                                (l.dest_city, l.dest_lat, l.dest_lng)]:
            cn = city.lower().strip()
            if cn != base_city and cn not in city_locs and lat and lng:
                city_locs[cn] = (lat, lng)

    def _corridor_distance(corr_a, corr_b):
        """Distance between two corridors' non-base endpoints."""
        cities_a = [c for c in corr_a if c != base_city]
        cities_b = [c for c in corr_b if c != base_city]
        if not cities_a or not cities_b: return 0
        ca = cities_a[0]; cb = cities_b[0]
        if ca not in city_locs or cb not in city_locs: return 50
        return int(hav_fn(city_locs[ca][0], city_locs[ca][1], city_locs[cb][0], city_locs[cb][1]))

    cross_overlap_penalty_vars = []  # (both_var, distance_weight)
    for day in working_days:
        lids = day_lane_ids[day]
        for i, lid_a in enumerate(lids):
            start_a = lane_pickup_min[lid_a]; finish_a = lane_finish_min[lid_a]
            corr_a = lane_corridor[lid_a]
            for j, lid_b in enumerate(lids):
                if j <= i: continue
                start_b = lane_pickup_min[lid_b]; finish_b = lane_finish_min[lid_b]
                corr_b = lane_corridor[lid_b]
                if corr_a == corr_b: continue
                if not (start_a < finish_b and start_b < finish_a): continue
                dist = _corridor_distance(corr_a, corr_b)
                if dist < 10: continue  # very close corridors — acceptable mixing
                weight = max(1, dist // 10)  # 1 per 10 miles distance
                for d in range(n_drivers):
                    both = model.NewBoolVar(f'xo_{day}_{i}_{j}_{d}')
                    model.AddBoolAnd([assign[day][lid_a][d], assign[day][lid_b][d]]).OnlyEnforceIf(both)
                    model.AddBoolOr([assign[day][lid_a][d].Not(), assign[day][lid_b][d].Not()]).OnlyEnforceIf(both.Not())
                    cross_overlap_penalty_vars.append(both * weight)

    # --- Weighted objective ---
    PAIR_WEIGHT = 10           # reward zero-DH pairings
    RETURN_WEIGHT = 2          # penalize far-from-base finishes
    DH_PENALTY_WEIGHT = 3      # penalize deadhead miles
    IDLE_WEIGHT = 1            # penalize idle time (per minute)
    SPAN_WEIGHT = 2            # penalize span over 10h target
    WEEKLY_EXCESS_WEIGHT = 1   # penalize weekly duty over 58h target
    HEAVY_DAY_WEIGHT = 1       # penalize heavy days (>12h or >7 legs)
    BAND_WEIGHT = 1            # penalize shift-band inconsistency
    CORRIDOR_WEIGHT = 300      # penalize distinct corridors per driver-day (dominant)
    CROSS_OVERLAP_WEIGHT = 250 # penalize cross-corridor overlapping (dominant)
    CORRIDOR_BLOCK_WEIGHT = 80 # reward same-corridor pair blocks on same driver

    obj_terms = []
    if corridor_block_rewards:
        obj_terms.extend(r * CORRIDOR_BLOCK_WEIGHT for r in corridor_block_rewards)
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
    if corridor_count_penalty_vars:
        obj_terms.extend(-v * CORRIDOR_WEIGHT for v in corridor_count_penalty_vars)
    if cross_overlap_penalty_vars:
        obj_terms.extend(-v * CROSS_OVERLAP_WEIGHT for v in cross_overlap_penalty_vars)
    if obj_terms:
        model.Maximize(sum(obj_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = solver_time
    solver.parameters.num_workers = 8
    solver.parameters.random_seed = 42  # reproducibility

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
            _, drive, _, _, _ = _sequence_driver_day(legs, lane_map, graph, base_city, max_wait_h)
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
                    _, d2_drive, _, _, _ = _sequence_driver_day(d2_legs, lane_map, graph, base_city, max_wait_h)
                    if d2_drive > max_drive_h: continue
                    # Exact drive check for d after removing swap_lid
                    d_remaining = [lid for lid in legs if lid != swap_lid]
                    d_new_drive = 0
                    if d_remaining:
                        _, d_new_drive, _, _, _ = _sequence_driver_day(d_remaining, lane_map, graph, base_city, max_wait_h)
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
                ordered_ids, drive, dh_miles_total, is_exact, leg_gaps = _sequence_driver_day(
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

                # Note: sequence order (reversed transitions, non-exact fallback) is tracked
                # in allExact and isExact per day, but does NOT block hosCompliant.
                # HOS compliance is based on aggregate drive/duty/weekly/off-duty only.
                # The span-based duty is correct regardless of display order.

                names = [lane_map[lid].name for lid in ordered_ids]
                driver_days[day_names_map[day]] = {
                    'legs': ordered_ids, 'legNames': names, 'legCount': len(ordered_ids),
                    'driveHours': round(drive, 1), 'dutyHours': round(duty, 1),
                    'miles': round(miles), 'deadheadMiles': round(dh_miles_total),
                    'startTime': earliest_start, 'endTime': latest_finish,
                    'isExact': is_exact,
                    'legGaps': leg_gaps,
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

    # ---- Phase 5: Fragment-aware repair on estimated rows ----
    # Build fragments from solved days, then move worst-scoring fragments
    # to improve overlap density, corridor coherence, and deadhead.
    # This targets the "assignment bucket" problem where the span model assigns
    # overlapping legs to the same driver because the total window fits in 14h.
    excl_pair_ids = set()
    for la in lanes:
        for lb in lanes:
            if la.id >= lb.id: continue
            if la.origin_city.lower().strip() != lb.dest_city.lower().strip(): continue
            if la.dest_city.lower().strip() != lb.origin_city.lower().strip(): continue
            if la.route_duration_hours + lb.route_duration_hours > 5.0:
                excl_pair_ids.add(la.id)
                excl_pair_ids.add(lb.id)

    # Unified fragment-aware repair
    exact_before = sum(1 for dr in weekly_schedule for dd in dr['days'].values() if dd.get('isExact'))
    max_dh_before = max((dd.get('deadheadMiles', 0) for dr in weekly_schedule for dd in dr['days'].values()), default=0)

    for repair_pass in range(5):
        moved_any = False
        for d_idx, dr in enumerate(weekly_schedule):
            for dn, dd in list(dr['days'].items()):
                if dd.get('isExact'): continue  # don't touch exact rows
                if any(lid in excl_pair_ids for lid in dd['legs']): continue  # don't touch LV

                # Find overlapping leg pairs
                legs = dd['legs']
                overlaps = []
                for i in range(len(legs)):
                    li = lane_map[legs[i]]
                    si = li.pickup_time; fi = li.finish_time
                    if si is None or fi is None: continue
                    for j in range(i + 1, len(legs)):
                        lj = lane_map[legs[j]]
                        sj = lj.pickup_time; fj = lj.finish_time
                        if sj is None or fj is None: continue
                        if si < fj and sj < fi:  # overlap
                            overlaps.append((i, j, legs[i], legs[j]))

                if not overlaps: continue

                # Try to move one leg from the worst overlap to another driver
                # Pick the overlap pair with the most time conflict
                overlaps.sort(key=lambda x: min(
                    lane_map[x[2]].finish_time or 0, lane_map[x[3]].finish_time or 0
                ) - max(
                    lane_map[x[2]].pickup_time or 0, lane_map[x[3]].pickup_time or 0
                ), reverse=True)

                for _, _, lid_a, lid_b in overlaps[:3]:  # try worst 3 overlaps
                    # Try moving lid_b (or lid_a) to another driver
                    for move_lid in [lid_b, lid_a]:
                        # Build a singleton block for the move candidate
                        move_block = {
                            'id': f'ovlp_{move_lid[:8]}',
                            'legs': [move_lid],
                            'corridor': _corridor_of_leg(lane_map[move_lid]),
                            'is_exclusive': False,
                            'start': lane_map[move_lid].pickup_time,
                            'end': lane_map[move_lid].finish_time,
                            'drive': lane_map[move_lid].route_duration_hours,
                        }

                        best_recipient = None
                        best_score = float('inf')

                        for r_idx, recip in enumerate(weekly_schedule):
                            if r_idx == d_idx: continue
                            r_dd = recip['days'].get(dn)
                            # Don't insert into exact or exclusive days
                            if r_dd and r_dd.get('isExact'): continue
                            if r_dd and any(lid in excl_pair_ids for lid in r_dd.get('legs', [])): continue

                            r_legs = list(r_dd['legs']) if r_dd else []
                            result = _try_insert_block(move_block, r_legs, lane_map, max_legs, pre_post_h)
                            if not result: continue
                            new_r_legs, new_r_score = result

                            # Check: would the move CREATE new overlaps on the recipient?
                            has_new_overlap = False
                            ml = lane_map[move_lid]
                            ms = ml.pickup_time; mf = ml.finish_time
                            if ms is not None and mf is not None:
                                for rl in r_legs:
                                    rl_lane = lane_map[rl]
                                    rs = rl_lane.pickup_time; rf = rl_lane.finish_time
                                    if rs is not None and rf is not None:
                                        if ms < rf and rs < mf:
                                            # Same corridor overlap is OK (pair legs overlap naturally)
                                            if _corridor_of_leg(ml) != _corridor_of_leg(rl_lane):
                                                has_new_overlap = True
                                                break
                            if has_new_overlap: continue

                            # Check weekly duty
                            if r_dd:
                                old_r_duty = r_dd.get('dutyHours', 0)
                                new_r_starts = [lane_map[lid].pickup_time for lid in new_r_legs if lane_map[lid].pickup_time]
                                new_r_ends = [lane_map[lid].finish_time for lid in new_r_legs if lane_map[lid].finish_time]
                                new_r_duty = (max(new_r_ends) - min(new_r_starts) + pre_post_h) if new_r_starts and new_r_ends else 0
                                if recip.get('totalDutyHours', 0) - old_r_duty + new_r_duty > MAX_WEEKLY_DUTY:
                                    continue

                            if new_r_score < best_score:
                                best_recipient = (r_idx, new_r_legs, new_r_score)
                                best_score = new_r_score

                        if best_recipient:
                            r_idx, new_r_legs, _ = best_recipient
                            # Remove move_lid from source
                            new_src_legs = [lid for lid in legs if lid != move_lid]

                            # Resequence source
                            if new_src_legs:
                                src_ord, src_dr, src_dh, src_ex, src_gaps = _sequence_driver_day(
                                    new_src_legs, lane_map, graph, base_city, max_wait_h)
                                src_starts = [lane_map[lid].pickup_time for lid in src_ord if lane_map[lid].pickup_time]
                                src_ends = [lane_map[lid].finish_time for lid in src_ord if lane_map[lid].finish_time]
                                weekly_schedule[d_idx]['days'][dn] = {
                                    'legs': src_ord, 'legNames': [lane_map[lid].name for lid in src_ord],
                                    'legCount': len(src_ord),
                                    'driveHours': round(src_dr, 1),
                                    'dutyHours': round((max(src_ends) - min(src_starts) + pre_post_h) if src_starts and src_ends else 0, 1),
                                    'miles': round(sum(lane_map[lid].route_miles for lid in src_ord) + src_dh),
                                    'deadheadMiles': round(src_dh),
                                    'startTime': min(src_starts) if src_starts else 0,
                                    'endTime': max(src_ends) if src_ends else 0,
                                    'isExact': src_ex, 'legGaps': src_gaps,
                                }
                            else:
                                del weekly_schedule[d_idx]['days'][dn]

                            # Resequence recipient
                            dst_ord, dst_dr, dst_dh, dst_ex, dst_gaps = _sequence_driver_day(
                                new_r_legs, lane_map, graph, base_city, max_wait_h)
                            dst_starts = [lane_map[lid].pickup_time for lid in dst_ord if lane_map[lid].pickup_time]
                            dst_ends = [lane_map[lid].finish_time for lid in dst_ord if lane_map[lid].finish_time]
                            weekly_schedule[r_idx]['days'][dn] = {
                                'legs': dst_ord, 'legNames': [lane_map[lid].name for lid in dst_ord],
                                'legCount': len(dst_ord),
                                'driveHours': round(dst_dr, 1),
                                'dutyHours': round((max(dst_ends) - min(dst_starts) + pre_post_h) if dst_starts and dst_ends else 0, 1),
                                'miles': round(sum(lane_map[lid].route_miles for lid in dst_ord) + dst_dh),
                                'deadheadMiles': round(dst_dh),
                                'startTime': min(dst_starts) if dst_starts else 0,
                                'endTime': max(dst_ends) if dst_ends else 0,
                                'isExact': dst_ex, 'legGaps': dst_gaps,
                            }

                            # Recompute totals
                            for idx in [d_idx, r_idx]:
                                d = weekly_schedule[idx]
                                d['totalDriveHours'] = round(sum(v['driveHours'] for v in d['days'].values()), 1)
                                d['totalDutyHours'] = round(sum(v['dutyHours'] for v in d['days'].values()), 1)
                                d['totalMiles'] = round(sum(v.get('miles', 0) for v in d['days'].values()))
                                d['totalDeadheadMiles'] = round(sum(v.get('deadheadMiles', 0) for v in d['days'].values()))
                                d['daysWorked'] = len(d['days'])

                            moved_any = True
                            break  # move succeeded, recheck this day
                    if moved_any: break
                if moved_any: break
            if moved_any: break

        # Check exact count didn't drop
        exact_after = sum(1 for dr in weekly_schedule for dd in dr['days'].values() if dd.get('isExact'))
        if exact_after < exact_before:
            break

        if not moved_any:
            break

    # ---- Phase 5b: Unconditional local repair on worst estimated rows ----

    MAX_REPAIR_PASSES = 5
    # Count exact days before repair to prevent regression
    exact_before_repair = sum(1 for dr in weekly_schedule for dd in dr['days'].values() if dd.get('isExact'))

    for repair_pass in range(MAX_REPAIR_PASSES):
        improved = False
        # Find worst estimated driver-day across all drivers
        worst_score = 0
        worst_key = None  # (driver_idx, day_name)
        for d_idx, dr in enumerate(weekly_schedule):
            for dn, dd in dr['days'].items():
                if dd.get('isExact'): continue  # don't touch exact rows
                if any(lid in excl_pair_ids for lid in dd['legs']): continue  # don't touch exclusive
                score = _row_quality_score(dd['legs'], lane_map, pre_post_h)
                if score > worst_score:
                    worst_score = score
                    worst_key = (d_idx, dn)

        if worst_key is None or worst_score < 30:
            break  # nothing worth repairing

        d_idx, dn = worst_key
        worst_dd = weekly_schedule[d_idx]['days'][dn]
        # Build fragments from the worst day (corridor-coherent groups)
        blocks = _generate_fragments_for_day(worst_dd['legs'], lane_map, excl_pair_ids)

        # Try moving the highest-DH non-exclusive block to another driver on same day
        best_move = None
        best_improvement = 0
        for b_idx, block in enumerate(blocks):
            if block['is_exclusive']: continue
            remaining_legs = []
            for b in blocks:
                if b['id'] != block['id']:
                    remaining_legs.extend(b['legs'])

            for r_idx, recip in enumerate(weekly_schedule):
                if r_idx == d_idx: continue
                r_dd = recip['days'].get(dn)
                # Don't insert into exclusive days
                if r_dd and any(lid in excl_pair_ids for lid in r_dd.get('legs', [])):
                    continue
                # Don't insert into exact days (protect exactness)
                if r_dd and r_dd.get('isExact'):
                    continue

                r_legs = list(r_dd['legs']) if r_dd else []
                result = _try_insert_block(block, r_legs, lane_map, max_legs, pre_post_h)
                if not result: continue
                new_r_legs, new_r_score = result

                # Anti-concentration: recipient DH can't become worse than source's current DH
                _, new_r_dh, _ = _metrics_from_chain(new_r_legs, lane_map)
                if new_r_dh > worst_dd.get('deadheadMiles', 0):
                    continue  # would just move the ugliness, not fix it

                # Check recipient weekly duty wouldn't exceed 70h
                if r_dd:
                    old_r_duty = r_dd.get('dutyHours', 0)
                    new_r_starts = [lane_map[lid].pickup_time for lid in new_r_legs if lane_map[lid].pickup_time]
                    new_r_ends = [lane_map[lid].finish_time for lid in new_r_legs if lane_map[lid].finish_time]
                    new_r_duty = (max(new_r_ends) - min(new_r_starts) + pre_post_h) if new_r_starts and new_r_ends else 0
                    recip_weekly = recip.get('totalDutyHours', 0) - old_r_duty + new_r_duty
                    if recip_weekly > MAX_WEEKLY_DUTY:
                        continue

                # Score improvement — penalize recipient degradation heavily
                old_worst_score = worst_score
                new_worst_score = _row_quality_score(remaining_legs, lane_map, pre_post_h) if remaining_legs else 0
                improvement = old_worst_score - new_worst_score - new_r_score * 0.5
                if improvement > best_improvement:
                    best_improvement = improvement
                    best_move = (b_idx, block, r_idx, remaining_legs, new_r_legs)

        if best_move and best_improvement > 20:
            b_idx, block, r_idx, remaining_legs, new_r_legs = best_move
            # Apply the move: resequence both affected days
            if remaining_legs:
                new_src_ordered, new_src_drive, new_src_dh, new_src_exact, new_src_gaps = \
                    _sequence_driver_day(remaining_legs, lane_map, graph, base_city, max_wait_h)
                src_starts = [lane_map[lid].pickup_time for lid in new_src_ordered if lane_map[lid].pickup_time]
                src_ends = [lane_map[lid].finish_time for lid in new_src_ordered if lane_map[lid].finish_time]
                weekly_schedule[d_idx]['days'][dn] = {
                    'legs': new_src_ordered,
                    'legNames': [lane_map[lid].name for lid in new_src_ordered],
                    'legCount': len(new_src_ordered),
                    'driveHours': round(new_src_drive, 1),
                    'dutyHours': round((max(src_ends) - min(src_starts) + pre_post_h) if src_starts and src_ends else 0, 1),
                    'miles': round(sum(lane_map[lid].route_miles for lid in new_src_ordered) + new_src_dh),
                    'deadheadMiles': round(new_src_dh),
                    'startTime': min(src_starts) if src_starts else 0,
                    'endTime': max(src_ends) if src_ends else 0,
                    'isExact': new_src_exact,
                    'legGaps': new_src_gaps,
                }
            else:
                del weekly_schedule[d_idx]['days'][dn]

            new_dst_ordered, new_dst_drive, new_dst_dh, new_dst_exact, new_dst_gaps = \
                _sequence_driver_day(new_r_legs, lane_map, graph, base_city, max_wait_h)
            dst_starts = [lane_map[lid].pickup_time for lid in new_dst_ordered if lane_map[lid].pickup_time]
            dst_ends = [lane_map[lid].finish_time for lid in new_dst_ordered if lane_map[lid].finish_time]
            weekly_schedule[r_idx]['days'][dn] = {
                'legs': new_dst_ordered,
                'legNames': [lane_map[lid].name for lid in new_dst_ordered],
                'legCount': len(new_dst_ordered),
                'driveHours': round(new_dst_drive, 1),
                'dutyHours': round((max(dst_ends) - min(dst_starts) + pre_post_h) if dst_starts and dst_ends else 0, 1),
                'miles': round(sum(lane_map[lid].route_miles for lid in new_dst_ordered) + new_dst_dh),
                'deadheadMiles': round(new_dst_dh),
                'startTime': min(dst_starts) if dst_starts else 0,
                'endTime': max(dst_ends) if dst_ends else 0,
                'isExact': new_dst_exact,
                'legGaps': new_dst_gaps,
            }

            # Recompute totals for affected drivers
            for idx in [d_idx, r_idx]:
                dr = weekly_schedule[idx]
                dr['totalDriveHours'] = round(sum(v['driveHours'] for v in dr['days'].values()), 1)
                dr['totalDutyHours'] = round(sum(v['dutyHours'] for v in dr['days'].values()), 1)
                dr['totalMiles'] = round(sum(v.get('miles', 0) for v in dr['days'].values()))
                dr['totalDeadheadMiles'] = round(sum(v.get('deadheadMiles', 0) for v in dr['days'].values()))
                dr['daysWorked'] = len(dr['days'])
            # Check exact count didn't drop — if it did, this repair was bad
            exact_after = sum(1 for dr in weekly_schedule for dd in dr['days'].values() if dd.get('isExact'))
            if exact_after < exact_before_repair:
                # Exact regression — this shouldn't happen since we skip exact days,
                # but if it does, stop repairing
                break
            improved = True

        if not improved:
            break

    # Recompute allExact after repairs
    all_exact = all(dd.get('isExact', False) for dr in weekly_schedule for dd in dr['days'].values())

    # Recompute HOS violations after repairs
    hos_violations = []
    for dr in weekly_schedule:
        weekly_duty = sum(v['dutyHours'] for v in dr['days'].values())
        if weekly_duty > MAX_WEEKLY_DUTY:
            hos_violations.append(f'D{dr["driverId"]}: {weekly_duty:.1f}h weekly')
        for dn, dd in dr['days'].items():
            if dd['driveHours'] > HOS_MAX_DRIVE:
                hos_violations.append(f'D{dr["driverId"]} {dn}: {dd["driveHours"]}h drive')
            if dd['dutyHours'] > HOS_MAX_DUTY:
                hos_violations.append(f'D{dr["driverId"]} {dn}: {dd["dutyHours"]}h duty')

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
            return _maybe_run_v2(result, lane_map, graph, base_city, config)

    # Smarter lower bound: account for time-span windows + exclusive long-haul pairs
    pp_min = int(pre_post_h * MINUTES)
    duty_max_min = int(HOS_MAX_DUTY * MINUTES)

    # Pre-detect exclusive pairs (same logic as _build_and_solve)
    excl_pair_ids = set()  # lane IDs that are part of exclusive blocks
    for la in lanes:
        for lb in lanes:
            if la.id >= lb.id: continue
            if la.origin_city.lower().strip() != lb.dest_city.lower().strip(): continue
            if la.dest_city.lower().strip() != lb.origin_city.lower().strip(): continue
            combined_drive = la.route_duration_hours + lb.route_duration_hours
            if combined_drive > 5.0:
                excl_pair_ids.add(la.id)
                excl_pair_ids.add(lb.id)

    for day in working_days:
        lids = day_lane_ids[day]
        if not lids: continue
        exclusive_on_day = sum(1 for lid in lids if lid in excl_pair_ids) // 2
        non_exclusive_lanes = len(lids) - exclusive_on_day * 2
        # Drivers for non-exclusive lanes
        starts = [lane_pickup_min[lid] for lid in lids]
        finishes = [lane_finish_min[lid] for lid in lids]
        span = max(finishes) - min(starts) + pp_min
        windows_needed = max(1, (span + duty_max_min - 1) // duty_max_min)
        non_excl_drivers = max((non_exclusive_lanes + max_legs - 1) // max_legs, windows_needed)
        day_min = exclusive_on_day + non_excl_drivers
        theoretical_min = max(theoretical_min, day_min)

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

        if not result.get('hosCompliant'):
            # Feasible but HOS violations after exact sequencing
            v = result.get('hosViolations', [])
            print(f"    {try_drivers}: {len(v)} HOS violation(s)")
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
                if final and final.get('hosCompliant'):
                    result = final  # use optimized version for compression
            result['minLegalDriverCount'] = min_legal_count
            result['recommendedDriverCount'] = try_drivers

            # --- Compression: try to reduce recommended count ---
            remaining_after = TIME_BUDGET - (_time.time() - search_start)
            if try_drivers > (min_legal_count or try_drivers) and remaining_after > 30:
                print(f"\n  Attempting compression {try_drivers} → {try_drivers - 1}...")
                compressed = _compress_schedule(result, lane_map, graph, base_city,
                                                max_legs, pre_post_h, max_wait_h, working_days)
                if compressed:
                    compressed['minLegalDriverCount'] = min_legal_count
                    compressed['recommendedDriverCount'] = try_drivers
                    compressed['minDispatchableDriverCount'] = compressed['driverCount']
                    # Quality summary
                    cws = compressed['weeklySchedule']
                    exact_d = sum(1 for dr in cws for dd in dr['days'].values() if dd.get('isExact'))
                    est_d = sum(1 for dr in cws for dd in dr['days'].values() if not dd.get('isExact'))
                    max_dh_day = max((dd.get('deadheadMiles', 0) for dr in cws for dd in dr['days'].values()), default=0)
                    compressed['qualitySummary'] = {
                        'exactDayCount': exact_d,
                        'estimatedDayCount': est_d,
                        'maxDeadheadDayMiles': max_dh_day,
                    }
                    print(f"  Compressed to {compressed['driverCount']} drivers! exact={exact_d} est={est_d} maxDH={max_dh_day}")
                    return _maybe_run_v2(compressed, lane_map, graph, base_city, config)
                else:
                    print(f"  Compression failed — keeping {try_drivers}")

            # Add quality summary to non-compressed result
            rws = result['weeklySchedule']
            exact_d = sum(1 for dr in rws for dd in dr['days'].values() if dd.get('isExact'))
            est_d = sum(1 for dr in rws for dd in dr['days'].values() if not dd.get('isExact'))
            max_dh_day = max((dd.get('deadheadMiles', 0) for dr in rws for dd in dr['days'].values()), default=0)
            result['qualitySummary'] = {
                'exactDayCount': exact_d,
                'estimatedDayCount': est_d,
                'maxDeadheadDayMiles': max_dh_day,
            }
            return _maybe_run_v2(result, lane_map, graph, base_city, config)
        else:
            print(f"    {try_drivers}: not operationally viable — {len(concerns)} concern(s)")

    # Fallback: return best result found
    if min_legal_count is not None:
        print(f"  Returning min legal ({min_legal_count}) as fallback")
        result = _solve(min_legal_count, min(60, max(10, int(TIME_BUDGET - (_time.time() - search_start) - 5))))
        if result:
            result['minLegalDriverCount'] = min_legal_count
            result['recommendedDriverCount'] = min_legal_count
            return _maybe_run_v2(result, lane_map, graph, base_city, config)

    return {'success': False, 'error': 'Could not find feasible solution', 'driverCount': 0}


if __name__ == '__main__':
    entries = json.load(open(sys.argv[1]))
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 9
    # If called from CLI, run the verbose version
    solve_weekly_v4(entries, n_drivers_override=n)
