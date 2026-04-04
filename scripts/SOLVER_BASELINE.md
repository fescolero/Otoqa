# Weekly Solver Baseline

## Current Production: v4 (v2.1 tuning)
Branch: `autofix/20260331-104805-sqlite-retry-reads-v3`
Latest: `6c0aad4`

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

---

## v5.2: SPPRC Pricing (current checkpoint)

### Architecture
```
LP master (GLOP) with dual prices ↕ SPPRC pricing subproblem
                ↓
         Integer cover (CP-SAT)
                ↓
         Weekly assembly (CP-SAT)
```

### SPPRC implementation
- Label-setting DP over lane-time network
- Domination by (last_lane, num_legs, corridor_set) + drive/duty/rc dimensions
- MAX_PER_STATE=10, MAX_PROCESSED=200k per round
- 18k-19k labels processed per pricing round
- No DAG restriction — `can_add_leg` handles time feasibility
- Generates 80 routes per round with best_rc > 0 (improving columns)

### What SPPRC proved
- Column generation can drive LP bound down materially
- LP Tuesday: 11.42 → 10.51 → 10.50 (close to 9)
- LP Monday: 12.39 → 11.51 → 11.13
- Pricing is no longer the blind bottleneck

### What SPPRC did NOT solve
- **LP-integer gap remains large**: LP=10.50, integer=17 on Tuesday
- The fractional optimal uses routes at partial weights that can't be realized integrally
- SPPRC columns are improving but the LP relaxation itself is loose

### Honest verdict
**We are at the boundary between "advanced prototype" and "research-grade routing solver."**

v5.2 proves route-first architecture + LP master + SPPRC pricing works as a system. The remaining gap is a master-side problem, not a column-quality problem.

---

## Next Sprint: Branch-and-Price (deferred)

### Why branch-and-price
The LP relaxation is loose because set-covering LPs often have fractional optima that can't be realized integrally. Branch-and-price:
- Branches on fractional variables
- Uses LP duals at each branch to guide further column generation
- Closes the LP-integer gap systematically

### Why it's a separate sprint
- Not a tweak — it's a new solver architecture
- Requires: branching strategy, tree search, incremental LP re-solves
- ~1-2 weeks of focused work

### Alternative: one more seeded-SPPRC diagnostic
Before committing to branch-and-price:
- Add v4 seeds to the SPPRC pool
- Check if integer cover collapses toward LP bound
- Tells us whether the gap is "missing columns" or "weak master structure"

### Decision for next sprint
- **Long-term engine**: branch-and-price
- **Uncertainty reduction first**: seeded-SPPRC diagnostic

---

## Session Takeaways

### What we proved
1. v4 (production) works: 9 drivers, 4 exact days, pair protection
2. v5 route-first architecture is sound (diagnostic: 9-route integer cover with seeds)
3. LP master with dual prices is correct
4. SPPRC pricing generates genuinely improving columns
5. Remaining blocker is the LP-integer gap (master-side)

### What we did NOT prove
- That v5 can beat v4 on its own (needs branch-and-price or better)
- That SPPRC alone can close the integer gap
- That the architecture works across contracts (only tested 917DK)

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
