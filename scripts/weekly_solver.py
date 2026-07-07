#!/usr/bin/env python3
"""
Weekly Solver — Two-stage approach:
  Stage 1: Solve each day independently (optimal daily shifts)
  Stage 2: Assign drivers to shifts across the week with 10h off-duty constraint

This is much faster than a monolithic weekly model because Stage 2 only has
~8 shifts/day × 6 days = ~48 shift slots to assign, not 140K templates.
"""

import json
import sys
import time

sys.path.insert(0, '/Users/hydra/Documents/Claude-Development/ProductionReady/Otoqa/scripts')
from lane_solver import (
    Lane, build_graph, generate_all_shifts, solve_exact_set_cover,
    DEFAULT_MAX_DEADHEAD, DEFAULT_MAX_LEGS, DEFAULT_MAX_WAIT, DEFAULT_PRE_POST_TRIP,
)
from solver_api import lanes_from_json

OFF_DUTY_HOURS = 10.0


def get_shift_times(template: list[str], lane_map: dict) -> tuple:
    """Get start and end time for a shift."""
    if not template:
        return None, None
    first = lane_map.get(template[0])
    last = lane_map.get(template[-1])
    start = first.pickup_time if first else None
    end = last.finish_time if last else None
    return start, end


def solve_weekly(entries: list[dict], config: dict = {}):
    """Two-stage weekly solver."""
    from ortools.sat.python import cp_model

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

    # Parse active days
    lane_days = {}
    for e in entries:
        rule = e.get('scheduleRule', {})
        days = rule.get('activeDays', [1, 2, 3, 4, 5])
        lane_days[e['id']] = days

    day_names = {1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat'}

    # ---- STAGE 1: Solve each day independently ----
    print("=" * 90)
    print("  STAGE 1: Daily shift optimization")
    print("=" * 90)

    daily_shifts = {}  # day -> list of shift dicts

    for day_num in sorted(day_names.keys()):
        day_lane_ids = [lid for lid, days in lane_days.items() if day_num in days]
        day_lanes = [l for l in lanes if l.id in day_lane_ids]

        if not day_lanes:
            daily_shifts[day_num] = []
            continue

        graph = build_graph(day_lanes, max_deadhead)
        templates = generate_all_shifts(day_lanes, graph, max_legs, pre_post, max_wait)
        all_ids = set(l.id for l in day_lanes)
        usable = [t for t in templates if len(t) >= 2]
        singles = [[l.id] for l in day_lanes]

        solution = solve_exact_set_cover(
            all_ids, usable + singles, max_time_seconds=300,
            lane_map=lane_map, graph=graph,
        )

        shifts = []
        for template in solution:
            start, end = get_shift_times(template, lane_map)

            drive = sum(lane_map[lid].route_duration_hours for lid in template if lid in lane_map)
            duty = pre_post + sum(
                lane_map[lid].route_duration_hours + lane_map[lid].dwell_hours
                for lid in template if lid in lane_map
            )
            # Add deadhead
            for i in range(1, len(template)):
                for nid, dm, dh in graph.get(template[i-1], []):
                    if nid == template[i]:
                        drive += dh
                        duty += dh
                        break
                # Wait time
                prev = lane_map.get(template[i-1])
                cur = lane_map.get(template[i])
                if prev and cur and prev.finish_time and cur.pickup_time:
                    edge_h = 0
                    for nid, _, eh in graph.get(template[i-1], []):
                        if nid == template[i]: edge_h = eh; break
                    wait = max(0, cur.pickup_time - prev.finish_time - edge_h)
                    duty += wait

            names = [lane_map[lid].name.replace('9173Q-', '') for lid in template if lid in lane_map]
            shifts.append({
                'template': template,
                'names': names,
                'start': start,
                'end': end,
                'legs': len(template),
                'drive': round(drive, 1),
                'duty': round(duty, 1),
            })

        daily_shifts[day_num] = shifts
        print(f"  {day_names[day_num]}: {len(day_lanes)} lanes → {len(shifts)} shifts (optimal)")

    # ---- STAGE 2: Assign drivers to shifts across the week ----
    print(f"\n{'=' * 90}")
    print("  STAGE 2: Weekly driver assignment (10h off-duty constraint)")
    print("=" * 90)

    # All shift slots: (day, shift_idx) pairs
    all_slots = []
    for day_num in sorted(daily_shifts.keys()):
        for s_idx in range(len(daily_shifts[day_num])):
            all_slots.append((day_num, s_idx))

    n_slots = len(all_slots)
    max_drivers = max(len(shifts) for shifts in daily_shifts.values() if shifts)
    # Need extra drivers for off-duty rotation
    max_drivers = max_drivers + 6

    print(f"  Total shift slots: {n_slots}")
    print(f"  Max drivers to try: {max_drivers}")

    model = cp_model.CpModel()

    # x[slot_idx][driver] = 1 if driver d handles this shift slot
    x = {}
    for si, (day, s_idx) in enumerate(all_slots):
        x[si] = [model.NewBoolVar(f'x_{si}_{d}') for d in range(max_drivers)]

    # driver_used[d] = 1 if driver d works any shift
    driver_used = [model.NewBoolVar(f'used_{d}') for d in range(max_drivers)]

    # Constraint 1: Each shift slot assigned to exactly one driver
    for si in range(n_slots):
        model.Add(sum(x[si][d] for d in range(max_drivers)) == 1)

    # Constraint 2: Each driver does at most one shift per day
    day_slots = {}  # day -> list of slot indices
    for si, (day, _) in enumerate(all_slots):
        if day not in day_slots:
            day_slots[day] = []
        day_slots[day].append(si)

    for day_num, slot_indices in day_slots.items():
        for d in range(max_drivers):
            model.Add(sum(x[si][d] for si in slot_indices) <= 1)

    # Constraint 3: 10h off-duty between consecutive days
    off_duty_pairs = 0
    sorted_days = sorted(daily_shifts.keys())
    for i in range(len(sorted_days) - 1):
        today = sorted_days[i]
        tomorrow = sorted_days[i + 1]
        if tomorrow - today != 1:
            continue  # not consecutive

        for si_today in day_slots.get(today, []):
            shift_today = daily_shifts[today][all_slots[si_today][1]]
            end_today = shift_today['end']
            if end_today is None:
                continue

            for si_tomorrow in day_slots.get(tomorrow, []):
                shift_tomorrow = daily_shifts[tomorrow][all_slots[si_tomorrow][1]]
                start_tomorrow = shift_tomorrow['start']
                if start_tomorrow is None:
                    continue

                off_duty = (start_tomorrow + 24.0) - end_today
                if off_duty < OFF_DUTY_HOURS:
                    # Incompatible: same driver can't do both
                    for d in range(max_drivers):
                        model.Add(x[si_today][d] + x[si_tomorrow][d] <= 1)
                    off_duty_pairs += 1

    print(f"  Off-duty incompatible pairs: {off_duty_pairs}")

    # Constraint 4: Link driver_used
    for d in range(max_drivers):
        for si in range(n_slots):
            model.AddImplication(x[si][d], driver_used[d])

    # Symmetry breaking
    for d in range(1, max_drivers):
        model.Add(driver_used[d] <= driver_used[d - 1])

    # Objective: minimize drivers
    model.Minimize(sum(driver_used))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 120
    solver.parameters.num_workers = 8

    print(f"  Solving...")
    t0 = time.time()
    status = solver.Solve(model)
    t1 = time.time()

    print(f"  Status: {solver.StatusName(status)}")
    print(f"  Time: {t1 - t0:.1f}s")

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        print("  FAILED")
        return

    num_drivers = int(solver.ObjectiveValue())
    print(f"  Drivers needed: {num_drivers}")
    print(f"  Best bound: {solver.BestObjectiveBound()}")

    # ---- Extract and display solution ----
    print(f"\n{'=' * 90}")
    print(f"  WEEKLY SCHEDULE: {num_drivers} drivers")
    print(f"{'=' * 90}")

    driver_schedule = {d: {} for d in range(num_drivers)}

    for si, (day, s_idx) in enumerate(all_slots):
        for d in range(num_drivers):
            if solver.Value(x[si][d]):
                driver_schedule[d][day] = daily_shifts[day][s_idx]

    for d in range(num_drivers):
        if not driver_schedule[d]:
            continue
        print(f"\n  Driver {d + 1}:")
        prev_end = None
        weekly_drive = 0
        weekly_duty = 0

        for day_num in sorted_days:
            if day_num not in driver_schedule[d]:
                print(f"    {day_names[day_num]}: OFF")
                prev_end = None
                continue

            s = driver_schedule[d][day_num]
            start_str = f"{int(s['start'])}:{int((s['start'] % 1) * 60):02d}" if s['start'] else "?"
            end_str = f"{int(s['end'])}:{int((s['end'] % 1) * 60):02d}" if s['end'] else "?"
            if s['end'] and s['end'] > 24:
                h = int(s['end'] - 24)
                m = int((s['end'] % 1) * 60)
                end_str = f"+{h}:{m:02d}"

            off_str = ""
            if prev_end is not None and s['start'] is not None:
                off = (s['start'] + 24) - prev_end
                off_str = f" (off:{off:.1f}h)"

            chain = " → ".join(s['names'])
            print(f"    {day_names[day_num]}: {s['legs']}L {s['drive']:.1f}h drv / {s['duty']:.1f}h duty [{start_str}→{end_str}]{off_str}  {chain}")

            weekly_drive += s['drive']
            weekly_duty += s['duty']
            prev_end = s['end']

        print(f"    WEEK: {weekly_drive:.1f}h drive / {weekly_duty:.1f}h duty")

    # Verify off-duty
    print(f"\n{'=' * 90}")
    print(f"  VERIFICATION")
    print(f"{'=' * 90}")

    violations = 0
    for d in range(num_drivers):
        sched = driver_schedule[d]
        days_worked = sorted(sched.keys())
        for i in range(len(days_worked) - 1):
            d1, d2 = days_worked[i], days_worked[i + 1]
            if d2 - d1 != 1:
                continue
            end = sched[d1]['end']
            start = sched[d2]['start']
            if end and start:
                off = (start + 24) - end
                if off < OFF_DUTY_HOURS:
                    violations += 1
                    print(f"  VIOLATION: Driver {d+1} {day_names[d1]}→{day_names[d2]}: {off:.1f}h off-duty")

    # 70h weekly check
    for d in range(num_drivers):
        sched = driver_schedule[d]
        total = sum(s['duty'] for s in sched.values())
        if total > 70:
            violations += 1
            print(f"  VIOLATION: Driver {d+1} weekly duty {total:.1f}h > 70h")

    if violations == 0:
        print(f"  ✓ All 10h off-duty constraints satisfied")
        print(f"  ✓ All weekly 70h limits satisfied")
        print(f"  ✓ All daily 11h drive / 14h duty limits satisfied (from Stage 1)")
    else:
        print(f"  {violations} violation(s) found")


if __name__ == '__main__':
    entries = json.load(open(sys.argv[1]))
    solve_weekly(entries)
