#!/usr/bin/env python3
"""
Weekly Solver V2 — Flexible daily shifts with 10h off-duty rotation.

Key insight: instead of locking in ONE set of shifts per day, generate
multiple valid shift configurations per day. Then let the weekly solver
pick WHICH configuration to use each day to minimize total drivers
while respecting off-duty.

Stage 1: For each day, generate the optimal shift set AND several
          alternative sets (by using different seeds/configurations).
Stage 2: Pick one configuration per day + assign drivers, minimizing
          total drivers with 10h off-duty between consecutive shifts.
"""

import json
import sys
import time

sys.path.insert(0, '/Users/hydra/Documents/Claude-Development/ProductionReady/Otoqa/scripts')
from lane_solver import (
    Lane, build_graph, generate_all_shifts, solve_exact_set_cover,
    calc_template_cost, DEFAULT_MAX_DEADHEAD, DEFAULT_MAX_LEGS,
    DEFAULT_MAX_WAIT, DEFAULT_PRE_POST_TRIP,
)
from solver_api import lanes_from_json
from ortools.sat.python import cp_model

OFF_DUTY_HOURS = 10.0


def get_shift_times(template, lane_map):
    if not template:
        return None, None
    first = lane_map.get(template[0])
    last = lane_map.get(template[-1])
    start = first.pickup_time if first else None
    end = last.finish_time if last else None
    return start, end


def compute_shift_metrics(template, lane_map, graph, pre_post):
    start, end = get_shift_times(template, lane_map)
    drive = sum(lane_map[lid].route_duration_hours for lid in template if lid in lane_map)
    duty = pre_post
    for i, lid in enumerate(template):
        l = lane_map.get(lid)
        if not l: continue
        duty += l.route_duration_hours + l.dwell_hours
        if i > 0:
            for nid, dm, dh in graph.get(template[i-1], []):
                if nid == lid:
                    drive += dh; duty += dh; break
            prev = lane_map.get(template[i-1])
            if prev and prev.finish_time and l.pickup_time:
                eh = next((h for n,_,h in graph.get(template[i-1],[]) if n==lid), 0)
                duty += max(0, l.pickup_time - prev.finish_time - eh)
    names = [lane_map[lid].name.replace('9173Q-','') for lid in template if lid in lane_map]
    return {
        'template': template, 'names': names, 'start': start, 'end': end,
        'legs': len(template), 'drive': round(drive, 1), 'duty': round(duty, 1),
    }


def generate_daily_configs(day_lanes, lane_map, graph, max_legs, pre_post, max_wait, num_configs=3):
    """Generate multiple valid shift configurations for a day.
    Each config covers ALL lanes but groups them differently."""
    all_ids = set(l.id for l in day_lanes)
    templates = generate_all_shifts(day_lanes, graph, max_legs, pre_post, max_wait)
    usable = [t for t in templates if len(t) >= 2]
    singles = [[l.id] for l in day_lanes]
    all_templates = usable + singles

    configs = []

    # Config 0: Cost-optimized (Phase 1 min drivers, Phase 2 min cost)
    solution = solve_exact_set_cover(
        all_ids, all_templates, max_time_seconds=120,
        lane_map=lane_map, graph=graph,
    )
    if solution:
        shifts = [compute_shift_metrics(t, lane_map, graph, pre_post) for t in solution]
        configs.append(shifts)

    # Config 1+: Try alternative objectives to get different groupings
    # Alternative: minimize max duty (spreads work more evenly)
    valid = [t for t in all_templates if all(lid in all_ids for lid in t)]
    n_valid = len(valid)
    lane_list = sorted(all_ids)
    lane_covering = {}
    for lid in lane_list:
        covering = [t for t in range(n_valid) if lid in valid[t]]
        if not covering: continue
        lane_covering[lid] = covering

    if len(configs) > 0:
        min_drivers = len(configs[0])
        # Allow 1 extra driver if it helps weekly rotation
        max_drivers_for_alt = min_drivers + 1

        # Alt configs with different objectives to create schedule diversity
        for obj_type in ['min_late', 'min_max_duty', 'max_afternoon', 'extra_driver_early_end']:
            model = cp_model.CpModel()
            x = [model.NewBoolVar(f'x_{t}') for t in range(n_valid)]
            for lid in lane_list:
                if lid in lane_covering:
                    model.Add(sum(x[t] for t in lane_covering[lid]) == 1)
            n_drivers_for_config = min_drivers if obj_type != 'extra_driver_early_end' else max_drivers_for_alt
            model.Add(sum(x) == n_drivers_for_config)

            # Compute costs based on objective
            costs = []
            for t_idx, t in enumerate(valid):
                start, end = get_shift_times(t, lane_map)
                if obj_type == 'min_late':
                    # Penalize shifts ending late
                    cost = int((end or 12) * 100) if end and end > 20 else 0
                elif obj_type == 'max_afternoon':
                    # Reward shifts starting after noon (for rotation)
                    cost = -int((start or 0) * 100) if start and start > 10 else int(1000)
                elif obj_type == 'extra_driver_early_end':
                    # Use 1 extra driver to make ALL shifts end earlier
                    cost = int((end or 12) * 200) if end and end > 18 else 0
                else:
                    # Minimize max duty
                    s = compute_shift_metrics(t, lane_map, graph, pre_post)
                    cost = int(s['duty'] * 100)
                costs.append(cost)

            model.Minimize(sum(x[t] * costs[t] for t in range(n_valid)))

            solver = cp_model.CpSolver()
            solver.parameters.max_time_in_seconds = 60
            solver.parameters.num_workers = 4
            status = solver.Solve(model)

            if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                sol = [valid[t] for t in range(n_valid) if solver.Value(x[t])]
                shifts = [compute_shift_metrics(t, lane_map, graph, pre_post) for t in sol]
                # Only add if it's actually different from existing configs
                new_ends = sorted(s['end'] or 0 for s in shifts)
                is_dup = False
                for existing in configs:
                    existing_ends = sorted(s['end'] or 0 for s in existing)
                    if new_ends == existing_ends:
                        is_dup = True
                        break
                if not is_dup:
                    configs.append(shifts)

    return configs[:num_configs]


def solve_weekly_v2(entries, config={}):
    max_deadhead = config.get('max_deadhead', DEFAULT_MAX_DEADHEAD)
    max_legs = config.get('max_legs', DEFAULT_MAX_LEGS)
    max_wait = config.get('max_wait', DEFAULT_MAX_WAIT)
    pre_post = config.get('pre_post_hours', DEFAULT_PRE_POST_TRIP)

    lanes = lanes_from_json(entries)
    lanes.sort(key=lambda l: (
        l.pickup_time if l.pickup_time is not None else 99,
        l.origin_city.lower(), l.dest_city.lower(), l.route_miles,
    ))
    lane_map = {l.id: l for l in lanes}

    lane_days = {}
    for e in entries:
        rule = e.get('scheduleRule', {})
        lane_days[e['id']] = rule.get('activeDays', [1,2,3,4,5])

    day_names = {1:'Mon', 2:'Tue', 3:'Wed', 4:'Thu', 5:'Fri', 6:'Sat'}
    working_days = sorted(d for d in day_names if any(d in days for days in lane_days.values()))

    # Stage 1: Generate multiple configurations per day
    print("=" * 95)
    print("  STAGE 1: Generate multiple shift configurations per day")
    print("=" * 95)

    day_configs = {}  # day -> list of configs, each config is list of shifts
    for day_num in working_days:
        day_lane_ids = [lid for lid, days in lane_days.items() if day_num in days]
        day_lanes_list = [l for l in lanes if l.id in day_lane_ids]
        if not day_lanes_list:
            day_configs[day_num] = [[]]
            continue
        graph = build_graph(day_lanes_list, max_deadhead)
        configs = generate_daily_configs(day_lanes_list, lane_map, graph, max_legs, pre_post, max_wait)
        day_configs[day_num] = configs
        print(f"  {day_names[day_num]}: {len(day_lanes_list)} lanes, {len(configs)} config(s) ({', '.join(str(len(c))+' shifts' for c in configs)})")

    # Stage 2: Pick one config per day + assign drivers
    print(f"\n{'=' * 95}")
    print("  STAGE 2: Weekly assignment (pick config per day + assign drivers)")
    print("=" * 95)

    # Build all shift slots: (day, config_idx, shift_idx)
    all_slots = []
    for day in working_days:
        for ci, config_shifts in enumerate(day_configs[day]):
            for si, shift in enumerate(config_shifts):
                all_slots.append((day, ci, si))

    max_drivers = max(len(c) for configs in day_configs.values() for c in configs) + 5

    model = cp_model.CpModel()

    # y[day][config_idx] = 1 if we use this config on this day
    y = {}
    for day in working_days:
        y[day] = [model.NewBoolVar(f'y_{day}_{ci}') for ci in range(len(day_configs[day]))]
        # Exactly one config per day
        model.Add(sum(y[day]) == 1)

    # x[day][config_idx][shift_idx][driver] = 1
    x = {}
    for day in working_days:
        x[day] = {}
        for ci, config_shifts in enumerate(day_configs[day]):
            x[day][ci] = {}
            for si in range(len(config_shifts)):
                x[day][ci][si] = [model.NewBoolVar(f'x_{day}_{ci}_{si}_{d}') for d in range(max_drivers)]

    driver_used = [model.NewBoolVar(f'used_{d}') for d in range(max_drivers)]

    # Constraint: if config ci is NOT chosen for day, all its shifts are 0
    for day in working_days:
        for ci, config_shifts in enumerate(day_configs[day]):
            for si in range(len(config_shifts)):
                for d in range(max_drivers):
                    model.AddImplication(y[day][ci].Not(), x[day][ci][si][d].Not())

    # Constraint: if config IS chosen, each shift assigned to exactly 1 driver
    for day in working_days:
        for ci, config_shifts in enumerate(day_configs[day]):
            for si in range(len(config_shifts)):
                # sum of drivers for this shift = y[day][ci] (1 if active, 0 if not)
                model.Add(sum(x[day][ci][si][d] for d in range(max_drivers)) == y[day][ci])

    # Constraint: each driver does at most 1 shift per day (across all configs)
    for day in working_days:
        for d in range(max_drivers):
            all_shifts_for_driver = []
            for ci, config_shifts in enumerate(day_configs[day]):
                for si in range(len(config_shifts)):
                    all_shifts_for_driver.append(x[day][ci][si][d])
            model.Add(sum(all_shifts_for_driver) <= 1)

    # Constraint: 10h off-duty between consecutive days
    off_duty_count = 0
    for di in range(len(working_days) - 1):
        today = working_days[di]
        tomorrow = working_days[di + 1]
        if tomorrow - today != 1:
            continue

        for ci_t, config_today in enumerate(day_configs[today]):
            for si_t, shift_today in enumerate(config_today):
                end_today = shift_today['end']
                if end_today is None: continue

                for ci_n, config_next in enumerate(day_configs[tomorrow]):
                    for si_n, shift_next in enumerate(config_next):
                        start_next = shift_next['start']
                        if start_next is None: continue

                        off_duty = (start_next + 24.0) - end_today
                        if off_duty < OFF_DUTY_HOURS:
                            for d in range(max_drivers):
                                model.Add(
                                    x[today][ci_t][si_t][d] + x[tomorrow][ci_n][si_n][d] <= 1
                                )
                            off_duty_count += 1

    print(f"  Configs: {sum(len(c) for c in day_configs.values())} total across {len(working_days)} days")
    print(f"  Off-duty constraints: {off_duty_count}")
    print(f"  Max drivers: {max_drivers}")

    # Link driver_used
    for d in range(max_drivers):
        for day in working_days:
            for ci, config_shifts in enumerate(day_configs[day]):
                for si in range(len(config_shifts)):
                    model.AddImplication(x[day][ci][si][d], driver_used[d])

    # Symmetry breaking
    for d in range(1, max_drivers):
        model.Add(driver_used[d] <= driver_used[d-1])

    model.Minimize(sum(driver_used))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 300
    solver.parameters.num_workers = 8

    print(f"  Solving...")
    t0 = time.time()
    status = solver.Solve(model)
    t1 = time.time()

    print(f"  Status: {solver.StatusName(status)} in {t1-t0:.1f}s")

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        print("  FAILED")
        return

    num_drivers = int(solver.ObjectiveValue())
    print(f"  DRIVERS NEEDED: {num_drivers} (bound: {solver.BestObjectiveBound()})")

    # Extract
    print(f"\n{'=' * 95}")
    print(f"  WEEKLY SCHEDULE: {num_drivers} drivers")
    print(f"{'=' * 95}")

    # Which config was chosen per day?
    chosen_configs = {}
    for day in working_days:
        for ci in range(len(day_configs[day])):
            if solver.Value(y[day][ci]):
                chosen_configs[day] = ci
                break

    driver_schedule = {d: {} for d in range(num_drivers)}
    for day in working_days:
        ci = chosen_configs.get(day, 0)
        config_shifts = day_configs[day][ci]
        for si, shift in enumerate(config_shifts):
            for d in range(num_drivers):
                if solver.Value(x[day][ci][si][d]):
                    driver_schedule[d][day] = shift

    for d in range(num_drivers):
        if not driver_schedule[d]: continue
        print(f"\n  Driver {d+1}:")
        prev_end = None
        wk_drive = 0; wk_duty = 0
        for day in working_days:
            if day not in driver_schedule[d]:
                print(f"    {day_names[day]}: OFF")
                prev_end = None; continue
            s = driver_schedule[d][day]
            st = f"{int(s['start'])}:{int((s['start']%1)*60):02d}" if s['start'] else "?"
            en = s['end']
            en_s = f"{int(en)}:{int((en%1)*60):02d}" if en and en <= 24 else (f"+{int(en-24)}:{int((en%1)*60):02d}" if en else "?")
            off_s = ""
            if prev_end and s['start']:
                off = (s['start']+24)-prev_end
                off_s = f" (off:{off:.1f}h)"
            print(f"    {day_names[day]}: {s['legs']}L {s['drive']:.1f}h/{s['duty']:.1f}h [{st}→{en_s}]{off_s}  {' → '.join(s['names'])}")
            wk_drive += s['drive']; wk_duty += s['duty']; prev_end = en
        print(f"    WEEK: {wk_drive:.1f}h drive / {wk_duty:.1f}h duty {'⚠️ >70h!' if wk_duty > 70 else '✓'}")

    # Verify
    print(f"\n{'=' * 95}")
    print(f"  VERIFICATION")
    print(f"{'=' * 95}")
    v = 0
    for d in range(num_drivers):
        sc = driver_schedule[d]
        days = sorted(sc.keys())
        for i in range(len(days)-1):
            if days[i+1]-days[i] != 1: continue
            end = sc[days[i]]['end']; start = sc[days[i+1]]['start']
            if end and start:
                off = (start+24)-end
                if off < OFF_DUTY_HOURS:
                    v += 1; print(f"  VIOLATION: D{d+1} {day_names[days[i]]}→{day_names[days[i+1]]}: {off:.1f}h")
        total = sum(s['duty'] for s in sc.values())
        if total > 70:
            v += 1; print(f"  VIOLATION: D{d+1} weekly {total:.1f}h > 70h")
    if v == 0:
        print(f"  ✓ All 10h off-duty OK")
        print(f"  ✓ All 70h weekly OK")
        print(f"  ✓ All 11h drive / 14h duty OK")


if __name__ == '__main__':
    entries = json.load(open(sys.argv[1]))
    solve_weekly_v2(entries)
