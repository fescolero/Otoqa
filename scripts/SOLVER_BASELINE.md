# Weekly Solver Baseline

## Current Production: v4 (v2.1 tuning)
Branch: `autofix/20260331-104805-sqlite-retry-reads-v3`
Latest: `3e6031f`

### What's deployed
- Phase 1 CP-SAT assignment with corridor penalties + pair protection + sequence-cost proxy
- v2 post-solve optimizer (moves, swaps, scoreboard, explainability, tabu)
- Best-of-3 with fixed seeds and quality ranking
- API validation + error envelopes
- `enable_local_optimize: true` + `best_of_n: 3` in Convex config

### 917DK results (9 drivers, 50 lanes)
- 4 exact days reliably (3 LV + SA pair)
- No 5-corridor disaster rows
- 615→616 SA pair always protected
- Worst DH: ~143-160mi (same-corridor SD spread — structural)
- Floor is high, ceiling is structural

---

## v5 Prototype: Route-Candidate Solver

### Architecture (validated)
```
Phase 1: Generate candidate driver-day routes (pre-sequenced, costed)
Phase 2: Select covering set via CP-SAT per day
Phase 3: Assemble weekly schedule via CP-SAT driver linking
```

### What the prototype proved
1. Route-first is implementable in this codebase
2. CandidateRoute data model works
3. Daily cover + weekly assembly framing is valid
4. CP-SAT set partitioning works for route selection
5. Weekly assembly as optimization (not greedy) is correct

### What the prototype exposed
**Naive DFS candidate generation produces overlapping, locally-correlated routes.**
- 500 candidates per day, but minimum cover is 16 routes (not 9)
- DFS chains are greedy and similar — they share the same popular legs
- The master problem (set cover) can't find a 9-route cover because the candidates aren't diverse enough
- This is NOT a set-cover problem — it's a candidate generation problem

### Lesson
> A successful route-first solver needs **iterative candidate generation**, not one-shot enumeration.
> The master problem must influence which candidates get created.

---

## v5.1 Next Step: Mine Candidates from v4 Solutions

### Option B: Route mining (practical bridge path)
1. Run v4 solver (best-of-3) to get strong 9-driver schedules
2. Extract each driver-day route as a seed candidate
3. Mutate seeds:
   - Drop 1 leg → generate shorter variant
   - Add 1 same-corridor leg → generate extended variant
   - Swap 1 cross-corridor leg for same-corridor leg
   - Recombine: take legs from 2 different v4 routes
4. Sequence all mutations via `_sequence_driver_day()`
5. Solve set-cover over the mined + mutated pool
6. If cover improves over v4, use it. Otherwise keep v4 result.

### Why this works
- v4 already produces 9-route covering sets (proven feasible)
- The seed candidates ARE globally compatible by construction
- Mutations explore the neighborhood of proven solutions
- Set-cover can find better combinations from the mutated pool

### Diagnostic Result: v4-seeded test
- Added 5 v4 seed routes to v5 pool
- LP dropped 12.27 → **10.22** (frac routes = 9.0)
- **Integer 9-route cover: SUCCESS**
- Confirms: v5 architecture works, bottleneck is purely pricing
- **SPPRC is the confirmed next build**

### Option A: Column generation (long-term)
- Start with small candidate pool
- Solve day-cover master problem
- Inspect uncovered/expensive lanes (dual values)
- Generate new candidates targeted at those lanes
- Repeat until convergence
- This is the research-backed path but more complex to implement

---

## Architecture Stack

### What carries forward to v5 (all reusable)
- API validation + error envelopes (solver_api.py)
- Quality scoreboard + explainability
- Pair protection (Phase 1 + v2 freeze)
- Best-of-N with quality ranking
- CandidateRoute dataclass
- `_select_day_cover()` — CP-SAT set partitioning
- `_assemble_weekly()` — CP-SAT weekly driver linking
- `_sequence_driver_day()` — per-day circuit sequencer
- v2 post-solve optimizer (light polish only in v5)
- All UI/Convex infrastructure

### What gets replaced in v5
- `_build_and_solve()` (v4 Phase 1) → `_build_and_solve_v5()` with mined candidates
- `_generate_day_candidates()` → mine from v4 solutions instead of naive DFS

### 3 durable optimization layers (target)
1. **Candidate generation** — mine from v4 + mutate
2. **Cover selection** — CP-SAT set partitioning + weekly linking
3. **Light polish** — v2 optimizer (moves, swaps, not rescue)
