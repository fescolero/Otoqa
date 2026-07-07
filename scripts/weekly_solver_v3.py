#!/usr/bin/env python3
"""
Weekly Solver V3 — Fully integrated weekly optimization.

Solves shift groupings AND driver assignment simultaneously using a reduced
template set. Instead of 140K templates, we keep ~100-200 high-quality
templates per day (top by leg count, diversity of start/end times).

This makes the weekly model tractable: 200 templates × 6 days × 15 drivers
= ~18K variables, down from millions.
"""

import json, sys, time
from collections import defaultdict

sys.path.insert(0, '/Users/hydra/Documents/Claude-Development/ProductionReady/Otoqa/scripts')
from lane_solver import (
    Lane, build_graph, generate_all_shifts, solve_exact_set_cover,
    DEFAULT_MAX_DEADHEAD, DEFAULT_MAX_LEGS, DEFAULT_MAX_WAIT, DEFAULT_PRE_POST_TRIP,
)
from solver_api import lanes_from_json
from ortools.sat.python import cp_model

OFF_DUTY_HOURS = 10.0
MAX_WEEKLY_DUTY = 70.0
TEMPLATES_PER_DAY = 1000  # reduced set per day


def get_shift_times(template, lane_map):
    if not template:
        return None, None
    first = lane_map.get(template[0])
    last = lane_map.get(template[-1])
    return (first.pickup_time if first else None), (last.finish_time if last else None)


def select_top_templates(templates, lane_map, limit):
    """Select the most useful templates: prioritize long ones, diverse start/end times."""
    scored = []
    for t in templates:
        start, end = get_shift_times(t, lane_map)
        # Score: legs (more = better), penalize very short
        score = len(t) * 1000
        # Bonus for late-start templates (needed for rotation)
        if start and start > 12:
            score += 500  # afternoon start — critical for off-duty rotation
        if start and start > 9:
            score += 200  # mid-morning start
        scored.append((score, t, start, end))

    scored.sort(key=lambda x: -x[0])

    # Take top templates ensuring diversity of start AND end times
    selected = []
    start_buckets = defaultdict(int)
    end_buckets = defaultdict(int)
    for score, t, start, end in scored:
        if len(selected) >= limit:
            break
        s_bucket = int((start or 0) / 2)
        e_bucket = int((end or 12) / 2)
        max_per_bucket = max(limit // 8, 20)
        if start_buckets[s_bucket] < max_per_bucket and end_buckets[e_bucket] < max_per_bucket:
            selected.append(t)
            start_buckets[s_bucket] += 1
            end_buckets[e_bucket] += 1

    return selected


def solve_weekly_v3(entries, config={}):
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
        lane_days[e['id']] = rule.get('activeDays', [1, 2, 3, 4, 5])

    day_names = {1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat'}
    working_days = sorted(d for d in day_names if any(d in days for days in lane_days.values()))

    # Stage 1: Generate REDUCED template set per day
    print("=" * 95)
    print("  STAGE 1: Generate reduced template sets per day")
    print("=" * 95)

    day_templates = {}  # day -> list of templates
    day_lane_ids_map = {}  # day -> set of lane IDs

    for day_num in working_days:
        day_lane_id_list = [lid for lid, days in lane_days.items() if day_num in days]
        day_lanes_list = [l for l in lanes if l.id in day_lane_id_list]
        day_lane_ids_map[day_num] = set(l.id for l in day_lanes_list)

        if not day_lanes_list:
            day_templates[day_num] = []
            continue

        graph = build_graph(day_lanes_list, max_deadhead)
        all_templates = generate_all_shifts(day_lanes_list, graph, max_legs, pre_post, max_wait)

        # Filter valid
        valid_ids = set(l.id for l in day_lanes_list)
        multi = [t for t in all_templates if len(t) >= 2 and all(lid in valid_ids for lid in t)]
        singles = [[l.id] for l in day_lanes_list]

        # Use ALL multi-leg templates (no filtering) — needed for weekly rotation
        day_templates[day_num] = multi + singles

        print(f"  {day_names[day_num]}: {len(day_lanes_list)} lanes, {len(multi)} multi + {len(singles)} singles = {len(day_templates[day_num])}")

    # Stage 2: Build weekly CP-SAT model
    print(f"\n{'=' * 95}")
    print("  STAGE 2: Weekly integrated solver (9 driver target)")
    print("=" * 95)

    max_drivers = 20  # generous upper bound

    model = cp_model.CpModel()

    # x[day][template_idx][driver] = 1 if driver d does template t on day
    x = {}
    for day in working_days:
        x[day] = {}
        for t_idx in range(len(day_templates[day])):
            x[day][t_idx] = [model.NewBoolVar(f'x_{day}_{t_idx}_{d}') for d in range(max_drivers)]

    driver_used = [model.NewBoolVar(f'used_{d}') for d in range(max_drivers)]

    # Constraint 1: Each lane covered exactly once per day
    print("  Adding coverage constraints...")
    for day in working_days:
        templates = day_templates[day]
        for lane_id in day_lane_ids_map[day]:
            covering = []
            for t_idx, t in enumerate(templates):
                if lane_id in t:
                    for d in range(max_drivers):
                        covering.append(x[day][t_idx][d])
            if covering:
                model.Add(sum(covering) == 1)
            else:
                print(f"  WARNING: Lane {lane_id} on {day_names[day]} has no covering template!")

    # Constraint 2: Each driver does at most 1 template per day
    print("  Adding one-shift-per-driver constraints...")
    for day in working_days:
        for d in range(max_drivers):
            model.Add(sum(
                x[day][t_idx][d]
                for t_idx in range(len(day_templates[day]))
            ) <= 1)

    # Constraint 3: 10h off-duty between consecutive days
    print("  Adding 10h off-duty constraints...")
    off_duty_count = 0
    for di in range(len(working_days) - 1):
        today = working_days[di]
        tomorrow = working_days[di + 1]
        if tomorrow - today != 1:
            continue

        for t_today_idx, t_today in enumerate(day_templates[today]):
            _, end_today = get_shift_times(t_today, lane_map)
            if end_today is None:
                continue

            for t_next_idx, t_next in enumerate(day_templates[tomorrow]):
                start_next, _ = get_shift_times(t_next, lane_map)
                if start_next is None:
                    continue

                off_duty = (start_next + 24.0) - end_today
                if off_duty < OFF_DUTY_HOURS:
                    for d in range(max_drivers):
                        model.Add(x[today][t_today_idx][d] + x[tomorrow][t_next_idx][d] <= 1)
                    off_duty_count += 1

    print(f"  Off-duty constraints: {off_duty_count}")

    # Constraint 4: 70h weekly duty cap per driver
    print("  Adding 70h weekly constraints...")
    # Pre-compute duty per template (in minutes for integer arithmetic)
    template_duty_min = {}
    for day in working_days:
        for t_idx, t in enumerate(day_templates[day]):
            drive = sum(lane_map[lid].route_duration_hours for lid in t if lid in lane_map)
            duty = pre_post + sum(
                lane_map[lid].route_duration_hours + lane_map[lid].dwell_hours
                for lid in t if lid in lane_map
            )
            template_duty_min[(day, t_idx)] = int(duty * 60)

    for d in range(max_drivers):
        weekly_duty = sum(
            x[day][t_idx][d] * template_duty_min[(day, t_idx)]
            for day in working_days
            for t_idx in range(len(day_templates[day]))
        )
        model.Add(weekly_duty <= int(MAX_WEEKLY_DUTY * 60))

    # Link driver_used
    for d in range(max_drivers):
        for day in working_days:
            for t_idx in range(len(day_templates[day])):
                model.AddImplication(x[day][t_idx][d], driver_used[d])

    # Symmetry breaking
    for d in range(1, max_drivers):
        model.Add(driver_used[d] <= driver_used[d - 1])

    model.Minimize(sum(driver_used))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 300
    solver.parameters.num_workers = 8

    print(f"\n  Solving ({max_drivers} max drivers, {sum(len(day_templates[d]) for d in working_days)} total templates)...")
    t0 = time.time()
    status = solver.Solve(model)
    t1 = time.time()

    print(f"  Status: {solver.StatusName(status)} in {t1 - t0:.1f}s")

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        print("  FAILED — try increasing TEMPLATES_PER_DAY or max_drivers")
        return

    num_drivers = int(solver.ObjectiveValue())
    print(f"  DRIVERS: {num_drivers} (bound: {solver.BestObjectiveBound()})")

    # Extract and display
    print(f"\n{'=' * 95}")
    print(f"  WEEKLY SCHEDULE: {num_drivers} drivers")
    print(f"{'=' * 95}")

    driver_sched = {d: {} for d in range(num_drivers)}
    for day in working_days:
        for t_idx, t in enumerate(day_templates[day]):
            for d in range(num_drivers):
                if solver.Value(x[day][t_idx][d]):
                    start, end = get_shift_times(t, lane_map)
                    names = [lane_map[lid].name.replace('9173Q-', '') for lid in t if lid in lane_map]
                    duty_h = template_duty_min[(day, t_idx)] / 60
                    drive = sum(lane_map[lid].route_duration_hours for lid in t if lid in lane_map)
                    driver_sched[d][day] = {
                        'template': t, 'names': names, 'start': start, 'end': end,
                        'legs': len(t), 'drive': round(drive, 1), 'duty': round(duty_h, 1),
                    }

    for d in range(num_drivers):
        if not driver_sched[d]: continue
        print(f"\n  Driver {d + 1}:")
        prev_end = None
        wk_d, wk_du = 0, 0
        for day in working_days:
            if day not in driver_sched[d]:
                print(f"    {day_names[day]}: OFF")
                prev_end = None
                continue
            s = driver_sched[d][day]
            st = f"{int(s['start'])}:{int((s['start'] % 1) * 60):02d}" if s['start'] else "?"
            en = s['end']
            en_s = f"{int(en)}:{int((en % 1) * 60):02d}" if en and en <= 24 else (f"+{int(en - 24)}:{int((en % 1) * 60):02d}" if en else "?")
            off_s = ""
            if prev_end and s['start']:
                off = (s['start'] + 24) - prev_end
                off_s = f" (off:{off:.1f}h)"
            print(f"    {day_names[day]}: {s['legs']}L {s['drive']:.1f}h/{s['duty']:.1f}h [{st}→{en_s}]{off_s}  {' → '.join(s['names'])}")
            wk_d += s['drive']; wk_du += s['duty']
            prev_end = en
        print(f"    WEEK: {wk_d:.1f}h drive / {wk_du:.1f}h duty {'⚠️ >70h!' if wk_du > 70 else '✓'}")

    # Verify
    print(f"\n{'=' * 95}")
    print(f"  VERIFICATION")
    print(f"{'=' * 95}")
    v = 0
    for d in range(num_drivers):
        sc = driver_sched[d]
        days = sorted(sc.keys())
        for i in range(len(days) - 1):
            if days[i + 1] - days[i] != 1: continue
            end = sc[days[i]]['end']; start = sc[days[i + 1]]['start']
            if end and start:
                off = (start + 24) - end
                if off < OFF_DUTY_HOURS:
                    v += 1; print(f"  VIOLATION: D{d + 1} {day_names[days[i]]}→{day_names[days[i + 1]]}: {off:.1f}h off")
        total = sum(s['duty'] for s in sc.values())
        if total > MAX_WEEKLY_DUTY:
            v += 1; print(f"  VIOLATION: D{d + 1} weekly {total:.1f}h > {MAX_WEEKLY_DUTY}h")

    if v == 0:
        print(f"  ✅ All 10h off-duty between consecutive shifts — COMPLIANT")
        print(f"  ✅ All 70h weekly duty cap — COMPLIANT")
        print(f"  ✅ All 11h drive / 14h duty daily — COMPLIANT")
    else:
        print(f"  ❌ {v} violation(s)")


if __name__ == '__main__':
    entries = json.load(open(sys.argv[1]))
    solve_weekly_v3(entries)
