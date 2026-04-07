# Weekly Scheduling Solver — Complete Technical Documentation

## Purpose
Given a set of contract lanes (origin→destination routes with fixed pickup times) and a target driver count, produce a weekly schedule that assigns every lane to a driver with minimal deadhead, maximum route quality, and full FMCSA HOS compliance.

---

## Shared Infrastructure (used by both v4 and v5)

### Data Model
| Component | Description |
|-----------|-------------|
| `Lane` dataclass | id, origin/dest city+coords, pickup/finish times, route miles/hours, dwell |
| `build_graph()` | Adjacency graph: which lanes can follow which (within max deadhead) |
| `can_add_leg()` | HOS-aware feasibility check: can this lane be added to a shift? |
| `can_connect()` | Physical feasibility: deadhead distance between two lanes |
| `haversine()` | Great-circle distance between lat/lng coordinates |

### HOS Constraints (FMCSA)
| Rule | Limit |
|------|-------|
| Daily drive | 11.0 hours |
| Daily duty (span-based) | 14.0 hours |
| Off-duty between days | 10.0 hours |
| Weekly duty | 70.0 hours |
| Pre/post trip | 1.0 hour (configurable) |
| Max legs per day | 8 (configurable) |
| Max deadhead | 75 miles (configurable) |
| Max wait between legs | 2.0 hours (configurable) |

### Per-Day Sequencing: `_sequence_driver_day()`
- Input: list of lane IDs assigned to one driver on one day
- Uses OR-Tools CP-SAT circuit model to find optimal ordering
- Minimizes total deadhead miles
- 5-second timeout, falls back to greedy time ordering
- Returns: ordered IDs, drive hours, DH miles, is_exact flag, leg gaps
- **Used by both v4 and v5**

### Quality Scoring: `_row_quality_score()`
```
score = DH_miles × 3.0
      + (corridor_count - 1) × 50
      + total_wait × 10
      + (50 if not exact)
      + (200 if singleton)
```
Higher = worse. Used by v2 optimizer and benchmark scorecard.

### API Layer: `solver_api.py`
| Endpoint | Description |
|----------|-------------|
| `POST /solve-weekly` | Production endpoint (called by Convex) |
| `POST /solve` | Legacy endpoint |
| `GET /health` | Health check |

Features:
- Input validation: rejects malformed JSON (400), missing fields (400), solver crashes (500)
- Error envelopes: `{"success": false, "error": "..."}` on all error paths
- CORS headers on all responses
- Field aliases supported: `originCity`/`origin_city`, `id`/`name`, etc.

---

## v4 Engine (Production Default)

### Architecture
```
Phase 1: CP-SAT Assignment Model
    ↓ assigns lanes to drivers per day
Phase 2: Extract assignments
Phase 3: Drive violation repair
Phase 4: Final sequencing + HOS validation
Phase 5: Fragment-aware local repair
Phase 5b: DH repair on worst rows
    ↓
v2 Post-Solve Optimizer (opt-in)
    ↓
Best-of-N Run Selector
```

### Phase 1: CP-SAT Assignment (`_build_and_solve`)
**How it works:**
- Pre-detects reverse pairs via mutual-best matching (`_detect_pair_blocks`)
- Collapses pairs into atomic "blocks" (2-leg units assigned together)
- Identifies exclusive blocks: LV pairs with combined drive >5h get full isolation
- Builds a single CP-SAT model assigning all lanes simultaneously
- Decision variables: `assign[day][lane_id][driver]` = BoolVar

**Objective function (weighted sum):**
| Weight | Component | Purpose |
|--------|-----------|---------|
| 300 | Corridor count penalty | Penalize distinct corridors per driver-day (dominant) |
| 250 | Cross-corridor overlap | Penalize time-overlapping legs from different corridors |
| 200 | Pair corridor protection | Penalize cross-corridor legs on pair-row drivers |
| 80 | Corridor block reward | Reward same-corridor pair blocks on same driver |
| 30 | Sequence-cost proxy | Penalize large time gaps between same-driver legs |
| 10 | Zero-DH pairing | Reward consecutive legs with <5mi deadhead |
| 3 | Deadhead penalty | Penalize deadhead miles between assigned pairs |
| 2 | Return-to-base | Penalize far-from-Colton finishes |
| 2 | Span excess | Penalize daily duty over 10h target |
| 1 | Idle penalty | Penalize span minus active drive (configurable weight) |
| 1 | Weekly excess | Penalize weekly duty over 58h target |
| 1 | Heavy day penalty | Penalize >12h duty or >7 legs per day |

**Progressive corridor escalation:**
- 2 corridors: 300 (acceptable)
- 3 corridors: 4,800 (2.7x steeper)
- 4 corridors: 16,800 (5x steeper)
- 5+ corridors: 28,800 (near-prohibitive)

**What works well:**
- Finds 9 drivers (proven optimum for 917DK)
- All lanes assigned, HOS compliant
- LV exclusive pairs always isolated
- 615→616 SA pair consistently protected
- No 5-corridor disaster rows

**What doesn't work well:**
- Blind to sequencing cost — assigns lanes without knowing the DH they'll create
- Same-corridor spread: puts 5 SD legs on one driver that create 143mi DH when sequenced
- Results vary run-to-run (CP-SAT parallel search with num_workers=8 is non-deterministic)

### v2 Post-Solve Optimizer
**Enabled via:** `config.enable_local_optimize: true`

**One-way fragment moves:**
- Finds worst estimated driver-day by quality score
- Extracts corridor-coherent fragments
- Moves fragments to other drivers on the same day
- Two-stage scoring: cheap prefilter → exact resequencing (top 2 candidates)
- Time-slot fit scoring: prefers insertions that fill gaps between existing legs

**Wrong-corridor swap search:**
- After one-way moves exhausted, tries targeted swaps
- Finds minority-corridor fragment in worst row
- Looks for complement fragment (dominant corridor) in another same-day row
- Swaps if both rows improve

**Guardrails:**
- Frozen rows: exact days + clean 2-leg pairs — cannot be donors OR recipients
- Coverage validation: `Counter((day_name, lane_id))` multiset unchanged
- Exact day count must not decrease
- Max single-day DH must not increase
- HOS violations on modified drivers must not increase
- Tabu memory: prevents oscillation (moving fragment back and forth)

**Quality scoreboard:** Logs pre/post worst score, total overlaps, total DH. Per-move explainability with scores, DH, overlap counts.

**Budget:** 5 iterations, 15s wall clock, 12 max exact scores.

### Best-of-N Run Selector
**Enabled via:** `config.best_of_n: 3`

- Runs solver with fixed seeds [42, 123, 271]
- Scores each result by quality ranking
- Picks the best

**Quality ranking:**
```
score = exact_days × 800
      - max_day_dh × 5
      - (max_day_dh - 150) × 10    [if max_dh > 150, steep escalation]
      - three_plus_corridor_rows × 600
      - total_dh × 0.3
```

### v4 Performance on 917DK (50 lanes, 9 drivers)
| Metric | Typical Range |
|--------|--------------|
| Exact days (weekly) | 20-23 |
| Exact days Monday | 4 (3 LV + SA pair) |
| Max single-day DH | 143-162 mi |
| Total weekly DH | 1400-2100 mi |
| 3+ corridor rows | 0-5 |
| 5-corridor rows | 0 (eliminated) |
| Runtime (best-of-3) | ~300-470s |
| 615→616 pair | Protected |

**Known ceiling:**
- 41 Monday lanes, 7 corridors, 3 exclusive LV pairs = 6 drivers handling 35 local legs
- Same-corridor DH spread (D4-style SD rows) is structural — can't be fixed by assignment
- Exact day count plateaus at ~21-23 — limited by circuit solver timeout on complex days
- Weight tuning has hit diminishing returns

---

## v5 Engine (Experimental, Opt-in)

### Architecture
```
Phase 0: Run v4 to get seed routes (180s)
    ↓
Phase 1: Bootstrap candidate pool (DFS + singletons + exclusive pairs)
    ↓ inject v4 seed routes
Phase 2: LP Master (GLOP) → dual prices per lane
    ↓
Phase 3: SPPRC Pricing → generate improving columns
    ↓ repeat until LP converges
Phase 4: Integer Cover (CP-SAT) → select best routes per day
    ↓
Phase 5: Weekly Assembly (CP-SAT) → assign routes to weekly driver slots
    ↓
v2 Post-Solve Optimizer (shared with v4)
```

### Phase 0: v4 Seed Extraction
- Runs v4 with seed=42, 180s budget
- Extracts each driver-day route as a `CandidateRoute`
- These seeds provide the "globally compatible" routes that naive DFS can't discover
- **This is why v5 depends on v4** — without seeds, minimum cover is 16 routes, not 9

### Phase 1: Candidate Generation (`_generate_day_candidates`)
**Three generators per day:**

**(a) Exclusive pair candidates** — LV pairs as isolated 2-leg routes (non-negotiable)

**(b) Full DFS route generation** — For each lane, DFS with `can_add_leg` pruning. Extends greedily by low-DH edges. Emits all 2+ leg chains found. Hard cap: 2000 candidates before pruning.

**(c) Singleton fallback** — Every lane as a 1-leg candidate (guarantees coverage)

**Candidate pruning:**
- Always keep: exclusive + singletons
- Sort by stable composite key: `(cost, -leg_count, sorted_lane_set)`
- Diversity buckets: 20% corridor-pure, 10% mixed, 10% short, 10% long
- Hard cap: 500 candidates per day
- Singleton penalty: +200 cost

**CandidateRoute dataclass:**
```
lane_set, ordered_ids, drive_hours, dh_miles, duty_hours,
start_time, end_time, corridor_count, dominant_corridor,
is_exact, is_exclusive, cost, leg_gaps
```

### Phase 2: LP Master (`_solve_lp_master`)
- GLOP linear programming solver
- Covering relaxation: `sum(x[i] covering lane) >= 1` per lane
- Objective: `minimize sum(x[i] × (1 + 0.001 × cost[i]))`
- Returns dual prices per lane (shadow prices)
- Dual prices guide SPPRC: high-dual lanes are "expensive to cover" and need better routes

### Phase 3: SPPRC Pricing (`_spprc_pricing`)
**Shortest Path with Resource Constraints via label-setting DP:**
- Labels: `(last_lane, drive, duty, clock, visited_set, reduced_cost, path)`
- Extends labels by adding feasible next lanes (via `can_add_leg`)
- Domination: label A dominates B if `(drive_A <= drive_B AND duty_A <= duty_B AND rc_A >= rc_B)` at same state key
- State key: `(last_lane, num_legs, corridor_frozenset)` — corridor-aware for diversity
- MAX_PER_STATE=10, MAX_PROCESSED=200k per round
- Emits routes with reduced cost > -0.5 (improving or near-improving)

**What SPPRC does well:**
- Explores ALL feasible paths, not just greedy ones
- Dual-guided: prioritizes lanes the LP says are expensive
- 18k+ labels processed per round
- LP bound drops materially across rounds

**What SPPRC doesn't do well enough (yet):**
- Can't discover the specific 6-8 leg multi-corridor routes v4 finds
- LP bound converges at ~11 (need ~9) without v4 seeds
- With v4 seeds, works immediately — the seed routes bridge the gap

### Phase 4: Integer Cover (`_select_day_cover`)
- CP-SAT set partitioning model
- Variables: `x[i]` = use candidate route i (binary)
- Coverage: each lane covered exactly once
- Route count: hard cap at n_drivers
- Objective: minimize `cost_sum + 50 × route_count` (quality-driven, route count as tiebreaker)
- Exclusive lanes can only appear in exclusive candidates

### Phase 5: Weekly Assembly (`_assemble_weekly`)
- CP-SAT optimization model (NOT greedy)
- Variables: `y[day][route][driver]` = assign route to driver (binary)
- Constraints: each route to exactly 1 driver, max 1 route per driver per day
- Off-duty: 10h between consecutive working days
- Weekly duty: 70h cap per driver
- Objective: minimize drivers_used × 1000 + route cost pass-through

### v5 Performance on 917DK (50 lanes, 9 drivers)
| Metric | Best Run | Worst Run | Notes |
|--------|----------|-----------|-------|
| Exact days | 26 | 24 | **Consistently higher than v4** |
| Max DH | 156 | 201 | Varies |
| Total DH | 1178 | 2101 | **Unstable — key weakness** |
| 3+ corridor rows | 3 | 6 | Similar to v4 |
| Runtime | ~230s | ~230s | Faster than v4 best-of-3 |

### What v5 does better than v4
- **More exact days** (+4 to +5 consistently) — the set-cover picks routes that sequence exactly more often
- **Better weekly assembly** — CP-SAT driver linking respects off-duty/weekly constraints globally
- **Structural potential** — once SPPRC improves, v5 can find routes v4 never considers

### What v5 does worse than v4
- **Total DH variance** — run-to-run results swing ±500mi (same as v4 but amplified)
- **Depends on v4 seeds** — without v4's routes, minimum cover is 16 routes (not 9)
- **Not yet production-stable** — failed the benchmark promotion scorecard

---

## Comparison Table

| Feature | v4 | v5_hybrid |
|---------|-----|-----------|
| **Status** | Production default | Experimental opt-in |
| **Assign method** | CP-SAT all-at-once | Route candidates + set cover |
| **Sequencing** | After assignment | Before assignment (pre-sequenced routes) |
| **Knows DH cost** | No (blind to sequencing) | Yes (routes are pre-costed) |
| **LP dual prices** | No | Yes (GLOP) |
| **SPPRC pricing** | No | Yes (label-setting DP) |
| **Weekly assembly** | Implicit (same model) | Explicit CP-SAT linker |
| **Exact days** | 20-23 | 24-26 (higher) |
| **DH stability** | Varies ±400mi | Varies ±500mi (worse) |
| **Pair protection** | Phase 1 penalty + v2 freeze | Same (shared) |
| **Corridor penalties** | Progressive escalation | Route cost includes corridor count |
| **v2 optimizer** | Full rescue layer | Light polish only |
| **Best-of-N** | Yes (3 seeds) | Not yet (single v4 seed) |
| **Runtime** | ~300-470s | ~230s |
| **Dependencies** | Self-contained | Needs v4 for seed routes |

---

## Shared Components (identical in both)

| Component | What it does |
|-----------|-------------|
| `_sequence_driver_day()` | Circuit-model per-day optimal ordering |
| `_greedy_time_order()` | Fallback ordering when circuit fails |
| `_detect_pair_blocks()` | Mutual-best matching for reverse pairs |
| `_compute_dh()` | Haversine deadhead between lanes |
| `_corridor_of_leg()` | Normalized corridor string |
| `_row_quality_score()` | Quality scoring with DH + corridor + wait + idle |
| `_metrics_from_chain()` | Drive, DH, gap computation for ordered chains |
| v2 optimizer | Fragment moves, swaps, tabu, scoreboard |
| API validation | Input validation, error envelopes, CORS |
| Quality scoreboard | Pre/post metrics logging |
| Pair protection | Clean 2-leg pairs frozen from modification |

---

## Known Issues (both engines)

### Non-determinism
- CP-SAT with `num_workers > 1` produces different results on different runs
- Same input, same seed, different output — caused by parallel search timing
- Masked by best-of-N averaging
- Fix: `num_workers=1` for benchmarks (too slow for production)
- Fix: `PYTHONHASHSEED=0` for reproducible hash ordering

### Structural Ceiling (917DK)
- 41 Monday lanes, 7 corridors, 3 exclusive LV pairs
- 6 non-LV drivers must cover 35 local legs
- At least 1 driver-day will have 2+ corridors (unavoidable math)
- SD afternoon legs are inherently time-spread → ~143mi DH is the floor
- Neither v4 nor v5 can fundamentally change this — it's the contract structure

---

## Configuration Reference

### Solver Config (passed from Convex)
| Key | Default | Description |
|-----|---------|-------------|
| `solver_version` | `'v4'` | `'v4'` or `'v5_hybrid'` |
| `enable_local_optimize` | `false` | Enable v2 post-solve optimizer |
| `best_of_n` | `1` | Run N seeds, pick best (v4 only) |
| `target_drivers` | auto-search | Fixed driver count target |
| `max_wait` | `2.0` | Max idle wait between legs (hours) |
| `max_legs` | `8` | Max legs per driver per day |
| `max_deadhead` | `75` | Max deadhead miles between legs |
| `pre_post_hours` | `1.0` | Pre/post trip inspection time |
| `idle_weight` | `1` | Phase 1 idle penalty weight (experimental) |

### Current Production Settings (Convex)
```json
{
  "enable_local_optimize": true,
  "best_of_n": 3,
  "solver_version": "v4"
}
```

---

## File Map
| File | Lines | Purpose |
|------|-------|---------|
| `weekly_solver_v4.py` | ~4800 | Main solver (v4 + v5 + v2 optimizer) |
| `solver_api.py` | ~370 | HTTP API wrapper with validation |
| `lane_solver.py` | ~710 | Shared library (Lane, graph, haversine, DFS) |
| `entries.json` | 50 entries | 917DK test fixture |
| `test_solver_regression.py` | ~100 | 12-assertion regression test |
| `benchmark_v5_hybrid.py` | ~360 | v4 vs v5 scorecard comparison |
| `SOLVER_BASELINE.md` | ~240 | Development history + checkpoint notes |

---

## Promotion Path for v5_hybrid

### Benchmark Scorecard

**Hard gates (must all pass on every contract):**
- drivers ≤ v4
- HOS compliant
- All lanes covered
- No new HOS violations
- recommendedDriverCount ≤ v4
- Protected pair rows preserved

**High priority (v5 must win or tie):**
- Exact day count
- Worst row score
- Max single-day DH

**Medium:**
- 3+ corridor rows
- Total fleet DH (within +2%, or +5% with strong high-priority wins)

**Veto (instant fail):**
- Max DH up >50mi
- Exact days down ≥2
- Protected pair regression

### Current Status
- v5_hybrid passed hard gates on 917DK
- v5_hybrid scored 1W/0T/2L on high priority (only exact days won)
- **HOLD** — not yet promoted
- **Blocker:** total DH variance too high (±500mi run-to-run)
- **Next step:** resolve non-determinism, then re-benchmark
