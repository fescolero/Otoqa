#!/usr/bin/env python3
"""Compare: raw CP-SAT vs solve_exact_set_cover API path."""
import json, sys, time
sys.path.insert(0, "/opt/solver")
from lane_solver import *
from solver_api import lanes_from_json, solve

entries = json.load(open("/opt/solver/entries.json"))
lanes = lanes_from_json(entries)
lanes.sort(key=lambda l: (
    l.pickup_time if l.pickup_time is not None else 99,
    l.origin_city.lower(), l.dest_city.lower(), l.route_miles,
))

lm = {l.id: l for l in lanes}
graph = build_graph(lanes, 75)

# Generate templates (same as API)
templates = generate_all_shifts(lanes, graph, 8, 0.25, 2.0)
all_ids = set(l.id for l in lanes)
usable = [t for t in templates if len(t) >= 2]
singles = [[l.id] for l in lanes]
all_templates = usable + singles

print(f"Templates: {len(all_templates)} ({len(usable)} multi + {len(singles)} single)")

# PATH A: Raw CP-SAT (what diagnose.py did — got 9)
from ortools.sat.python import cp_model

lane_list = sorted(all_ids)
valid = [t for t in all_templates if all(lid in all_ids for lid in t)]
print(f"Valid templates: {len(valid)}")

# Check dedup
seen = set()
dupes = 0
for t in valid:
    k = frozenset(t)
    if k in seen: dupes += 1
    seen.add(k)
print(f"Unique lane-sets: {len(seen)}, dupes: {dupes}")

# Build model
model = cp_model.CpModel()
x = [model.NewBoolVar(f'x_{t}') for t in range(len(valid))]

lane_covering = {}
for lid in lane_list:
    covering = [t for t in range(len(valid)) if lid in valid[t]]
    lane_covering[lid] = covering
    model.Add(sum(x[t] for t in covering) == 1)

model.Minimize(sum(x))

# NO hints, NO dedup, just raw solve
solver = cp_model.CpSolver()
solver.parameters.max_time_in_seconds = 300
solver.parameters.num_workers = 8

print(f"\n=== Raw CP-SAT ===")
t0 = time.time()
status = solver.Solve(model)
t1 = time.time()
print(f"Status: {solver.StatusName(status)}")
print(f"Objective: {solver.ObjectiveValue()}")
print(f"Best bound: {solver.BestObjectiveBound()}")
print(f"Time: {t1-t0:.1f}s")

# PATH B: Through solve_exact_set_cover (what API does)
print(f"\n=== solve_exact_set_cover ===")
t2 = time.time()
result = solve_exact_set_cover(all_ids, all_templates, max_time_seconds=300, lane_map=lm, graph=graph)
t3 = time.time()
print(f"Result: {len(result)} shifts in {t3-t2:.1f}s")
