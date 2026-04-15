#!/usr/bin/env python3
"""
Run the local greedy solver on exported Convex entries and output
a weeklySchedule JSON suitable for dev_injectSolverSchedule.

Usage:
  python3 scripts/run_solver_local.py <entries.json> [output.json]
"""
import json, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from weekly_solver_v4 import solve_weekly_v4_api

entries_file = sys.argv[1]
output_file  = sys.argv[2] if len(sys.argv) > 2 else '/tmp/solver_output.json'

with open(entries_file) as f:
    data = json.load(f)

# exportEntriesForSolver returns {entries: [...], bases: [...]}
entries = data['entries'] if isinstance(data, dict) and 'entries' in data else data
bases   = data.get('bases', []) if isinstance(data, dict) else []

print(f"Running greedy solver on {len(entries)} lanes, {len(bases)} base(s)...", flush=True)

config = {
    'solver_version': 'greedy',
    'max_wait': 2.0,
    'max_legs': 10,
    'max_deadhead': 100,
    'pre_post_hours': 1.0,
    'best_of_n': 3,
    'bases': bases,
}

result = solve_weekly_v4_api(entries, config=config)

if not result:
    print("ERROR: solver returned None", file=sys.stderr)
    sys.exit(1)

ws = result.get('weeklySchedule', [])
print(f"Solver complete: {result.get('driverCount')} drivers, {len(ws)} driver rows")

# Compute quality summary
total_dh = sum(
    sum(day.get('deadheadMiles', 0) for day in d.get('days', {}).values())
    for d in ws
)
print(f"Total deadhead: {total_dh:.0f} mi")

with open(output_file, 'w') as f:
    json.dump(ws, f)

print(f"Weekly schedule written to {output_file} ({os.path.getsize(output_file)} bytes)")
