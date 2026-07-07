#!/usr/bin/env python3
"""Diagnose why CP-SAT finds 10 instead of 9 on this platform."""
import json, sys, time
sys.path.insert(0, "/opt/solver")
from lane_solver import *
from solver_api import lanes_from_json
from ortools.sat.python import cp_model

entries = json.load(open("/opt/solver/entries.json"))
lanes = lanes_from_json(entries)

# Sort deterministically (same as solver_api.py)
lanes.sort(key=lambda l: (
    l.pickup_time if l.pickup_time is not None else 99,
    l.origin_city.lower(), l.dest_city.lower(), l.route_miles,
))

lm = {l.id: l for l in lanes}
graph = build_graph(lanes, 75)

print(f"Lanes: {len(lanes)}")
print(f"Graph edges: {sum(len(v) for v in graph.values())}")

# Generate templates
t0 = time.time()
templates = generate_all_shifts(lanes, graph, 8, 0.25, 2.0)
t1 = time.time()
print(f"Templates: {len(templates)} in {t1-t0:.1f}s")

# Check critical templates
count_105_106_107 = sum(1 for t in templates
    if any(lm.get(lid) and lm[lid].name == '9173Q-105' for lid in t)
    and any(lm.get(lid) and lm[lid].name == '9173Q-106' for lid in t)
    and any(lm.get(lid) and lm[lid].name == '9173Q-107' for lid in t))
count_107_108 = sum(1 for t in templates
    if any(lm.get(lid) and lm[lid].name == '9173Q-107' for lid in t)
    and any(lm.get(lid) and lm[lid].name == '9173Q-108' for lid in t))
print(f"Templates with 105+106+107: {count_105_106_107}")
print(f"Templates with 107+108: {count_107_108}")

# Run Phase 1 with verbose output
all_ids = set(l.id for l in lanes)
valid = [t for t in templates if all(lid in all_ids for lid in t)]
lane_list = sorted(all_ids)

lane_covering = {}
for lane_id in lane_list:
    covering = [t for t in range(len(valid)) if lane_id in valid[t]]
    lane_covering[lane_id] = covering

model = cp_model.CpModel()
x = [model.NewBoolVar(f'x_{t}') for t in range(len(valid))]
for lane_id in lane_list:
    model.Add(sum(x[t] for t in lane_covering[lane_id]) == 1)
model.Minimize(sum(x))

solver = cp_model.CpSolver()
solver.parameters.max_time_in_seconds = 300
solver.parameters.num_workers = 8
solver.parameters.log_search_progress = True

print(f"\n=== Running CP-SAT (300s, 8 workers) ===")
t2 = time.time()
status = solver.Solve(model)
t3 = time.time()

print(f"\nStatus: {solver.StatusName(status)}")
print(f"Objective: {solver.ObjectiveValue()}")
print(f"Best bound: {solver.BestObjectiveBound()}")
print(f"Time: {t3-t2:.1f}s")
print(f"Branches: {solver.NumBranches()}")
print(f"Conflicts: {solver.NumConflicts()}")
