#!/usr/bin/env python3
"""
Regression test for weekly_solver_v4.py

Runs the solver against the 917DK contract fixture (entries.json) and verifies:
- Driver count = 9
- Zero HOS violations (14h duty, 11h drive, 10h off-duty, 70h weekly)
- All per-day sequences are exact (no fallbacks)
- Max intra-day gap ≤ 3h
- All corridor round-trips paired (LV, SD, etc.)
- All lanes covered
- Deadhead % within bounds

Usage:
  python3 scripts/test_solver_regression.py
  python3 scripts/test_solver_regression.py --runs 5  # multiple runs for consistency
"""
import json
import os
import sys
import time
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from weekly_solver_v4 import solve_weekly_v4_api, lanes_from_json


def run_fixture(entries, config, n_drivers=9):
    """Run solver and return result + computed quality metrics."""
    result = solve_weekly_v4_api(entries, config, n_drivers=n_drivers)
    if not result.get('success') or not result.get('weeklySchedule'):
        return result, None

    lanes = lanes_from_json(entries)
    lane_map = {l.id: l for l in lanes}
    lv_ids = set(l.id for l in lanes if 'las vegas' in l.origin_city.lower() or 'las vegas' in l.dest_city.lower())

    ws = result['weeklySchedule']

    # Max gap
    max_gap = 0
    for dr in ws:
        for dd in dr['days'].values():
            for k in range(1, len(dd['legs'])):
                la = lane_map.get(dd['legs'][k - 1])
                lb = lane_map.get(dd['legs'][k])
                if la and lb and la.finish_time and lb.pickup_time:
                    g = lb.pickup_time - la.finish_time
                    if g > max_gap:
                        max_gap = g

    # LV pairing
    lv_unpaired = 0
    for dr in ws:
        for dd in dr['days'].values():
            lv_in = [lid for lid in dd['legs'] if lid in lv_ids]
            if not lv_in:
                continue
            outs = [lid for lid in lv_in if 'las vegas' in lane_map[lid].dest_city.lower()]
            rets = [lid for lid in lv_in if 'las vegas' in lane_map[lid].origin_city.lower()]
            if (outs and not rets) or (rets and not outs):
                lv_unpaired += 1

    # All lanes covered
    all_lane_ids = set()
    for dr in ws:
        for dd in dr['days'].values():
            all_lane_ids.update(dd['legs'])

    # Off-duty check
    off_duty_violations = 0
    for dr in ws:
        prev_end = None
        prev_dn = None
        for dn in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']:
            dd = dr['days'].get(dn)
            if not dd:
                prev_end = None
                prev_dn = None
                continue
            if prev_end is not None and dd.get('startTime') is not None:
                off = (dd['startTime'] + 24) - prev_end
                if off < 10:
                    off_duty_violations += 1
            prev_end = dd.get('endTime')
            prev_dn = dn

    # Weekly duty
    weekly_violations = 0
    for dr in ws:
        wd = sum(d['dutyHours'] for d in dr['days'].values())
        if wd > 70:
            weekly_violations += 1

    total_dh = sum(dd.get('deadheadMiles', 0) for dr in ws for dd in dr['days'].values())
    total_mi = sum(dd.get('miles', 0) for dr in ws for dd in dr['days'].values())

    metrics = {
        'driverCount': result['driverCount'],
        'hosCompliant': result['hosCompliant'],
        'allExact': result.get('allExact', False),
        'hosViolationCount': len(result.get('hosViolations', [])),
        'maxDailyDrive': max(dd['driveHours'] for dr in ws for dd in dr['days'].values()),
        'maxDailyDuty': max(dd['dutyHours'] for dr in ws for dd in dr['days'].values()),
        'maxGapHours': round(max_gap, 1),
        'lvUnpairedDays': lv_unpaired,
        'offDutyViolations': off_duty_violations,
        'weeklyViolations': weekly_violations,
        'allLanesCovered': len(all_lane_ids) >= len(entries),
        'deadheadPercent': round(total_dh / max(total_mi, 1) * 100, 1),
    }
    return result, metrics


def check_assertions(metrics, run_num=1):
    """Check assertions and return (pass_count, fail_count, failures)."""
    assertions = [
        ('driverCount == 9', metrics['driverCount'] == 9, f"got {metrics['driverCount']}"),
        ('hosCompliant == True', metrics['hosCompliant'], 'solver reported non-compliant'),
        ('allExact == True', metrics['allExact'], 'some days used fallback sequencing'),
        ('hosViolations == 0', metrics['hosViolationCount'] == 0, f"got {metrics['hosViolationCount']}"),
        ('maxDailyDrive <= 11.0', metrics['maxDailyDrive'] <= 11.0, f"got {metrics['maxDailyDrive']}h"),
        ('maxDailyDuty <= 14.0', metrics['maxDailyDuty'] <= 14.0, f"got {metrics['maxDailyDuty']}h"),
        ('maxGapHours <= 3.0', metrics['maxGapHours'] <= 3.0, f"got {metrics['maxGapHours']}h"),
        ('lvUnpairedDays == 0', metrics['lvUnpairedDays'] == 0, f"got {metrics['lvUnpairedDays']}"),
        ('offDutyViolations == 0', metrics['offDutyViolations'] == 0, f"got {metrics['offDutyViolations']}"),
        ('weeklyViolations == 0', metrics['weeklyViolations'] == 0, f"got {metrics['weeklyViolations']}"),
        ('allLanesCovered', metrics['allLanesCovered'], 'not all lanes assigned'),
        ('deadheadPercent <= 20', metrics['deadheadPercent'] <= 20.0, f"got {metrics['deadheadPercent']}%"),
    ]

    passed = 0
    failed = 0
    failures = []
    for name, ok, detail in assertions:
        if ok:
            passed += 1
        else:
            failed += 1
            failures.append(f'FAIL: {name} — {detail}')

    return passed, failed, failures


def main():
    parser = argparse.ArgumentParser(description='Solver regression test')
    parser.add_argument('--runs', type=int, default=1, help='Number of runs (default: 1)')
    parser.add_argument('--entries', type=str, default=None, help='Path to entries.json')
    args = parser.parse_args()

    entries_path = args.entries or os.path.join(os.path.dirname(__file__), 'entries.json')
    if not os.path.exists(entries_path):
        print(f'ERROR: {entries_path} not found')
        sys.exit(1)

    entries = json.load(open(entries_path))
    config = {
        'max_deadhead': 75,
        'max_legs': 8,
        'max_wait': 2.0,
        'pre_post_hours': 1.0,
        'target_drivers': 9,
        'bases': [{'city': 'colton', 'lat': 34.0430, 'lng': -117.3333}],
    }

    print(f'917DK Regression Test — {len(entries)} lanes, {args.runs} run(s)')
    print('=' * 60)

    all_pass = True
    for run in range(1, args.runs + 1):
        t0 = time.time()
        result, metrics = run_fixture(entries, config, n_drivers=9)
        elapsed = time.time() - t0

        if metrics is None:
            print(f'Run {run}: SOLVER FAILED ({elapsed:.0f}s)')
            all_pass = False
            continue

        passed, failed, failures = check_assertions(metrics, run)

        status = 'PASS' if failed == 0 else 'FAIL'
        print(f'Run {run}: {status} — {passed}/{passed + failed} assertions ({elapsed:.0f}s)')
        print(f'  drivers={metrics["driverCount"]} drive={metrics["maxDailyDrive"]}h '
              f'duty={metrics["maxDailyDuty"]}h gap={metrics["maxGapHours"]}h '
              f'DH={metrics["deadheadPercent"]}%')

        if failures:
            all_pass = False
            for f in failures:
                print(f'  {f}')

    print('=' * 60)
    if all_pass:
        print(f'ALL {args.runs} RUN(S) PASSED')
    else:
        print('SOME RUNS FAILED')
        sys.exit(1)


if __name__ == '__main__':
    main()
