# Weekly Solver v2.1 Final Baseline

## Commit
Branch: `autofix/20260331-104805-sqlite-retry-reads-v3`
Latest commit: `e494403`
Date: 2026-04-03

## What shipped

### Phase 1 CP-SAT improvements
- **Progressive corridor-count penalty** — 3rd corridor 2.7x steeper, 4th 5x, 5th 6x. Eliminated 5-corridor disaster rows.
- **Pair corridor protection** — 200-weight penalty for cross-corridor legs on pair-row drivers. Protects 615→616 SA pair.
- **Sequence-cost proxy** — Penalizes large time gaps (>3h) between same-driver legs. Makes solver aware of approximate sequencing costs before actual sequencing. Produces tighter-packed rows.
- **Configurable idle_weight** — behind flag, default 1. Higher values push tighter packing.

### v2 post-solve optimizer (opt-in)
- **One-way fragment moves** — corridor-coherent fragments between same-day drivers
- **Wrong-corridor swap search** — target minority-corridor fragments, swap with complement
- **Quality scoreboard** — pre/post worst score, total overlaps, total DH
- **Explainability** — per-move logging with scores, DH, overlaps
- **Tabu memory** — prevents oscillation
- **Clean pair protection** — estimated 2-leg pairs frozen as donors/recipients

### Best-of-N solver
- **Fixed seeds** [42, 123, 271] — deterministic, no timing luck
- **Quality ranking** — exact days (×800), max DH with escalation above 150mi, 3+ corridor penalty (×600), total DH tiebreaker
- **Default: best_of_n=3** in Convex config

### API hygiene
- Input validation (400/500 error envelopes)
- CORS on all paths
- Schema fix (targetDriverCount)

## Contract: 917DK (50 lanes, 9 drivers)

### Monday final result
```
D1: 2L exact  — LV (307+308)
D2: 6L est    — COI + ANA. Clean, well-packed. ~239mi.
D3: 2L exact  — LV (301+302)
D4: 5L est    — Pure SD. +143mi DH. Structural same-corridor spread.
D5: 7L est    — SA + MV. +92mi DH. Moderate.
D6: 2L exact  — LV (303+304)
D7: 8L est    — SB-dominant + SA oddball. +67mi DH. Well-packed.
D8: 2L exact  — SA pair (615+616). PROTECTED.
D9: 7L est    — SD + MV + SB. +46mi DH. Improved but still mixed.
```

### What actually improved vs v1
| Metric | v1 start | v2.1 final |
|--------|----------|------------|
| 5-corridor rows | 1 | **0** (eliminated) |
| 615/616 pair | sometimes broken | **always protected** |
| 3+ corridor rows | 2 | 0-1 |
| Best estimated row | ~0mi DH, 1 corridor | D2: 6L COI+ANA, tightly packed |
| Worst estimated DH | +149mi | +143mi (slight improvement) |
| Consistency | varies wildly | best-of-3 with proper ranking |
| Observability | none | scoreboard + explainability |
| API safety | crashes on bad input | validation + error envelopes |

### What did NOT improve
- Exact day count: still 4 (3 LV + SA pair), not reliably 5
- D4-type SD spread: ~143mi DH is near-structural for this contract
- Total fleet miles: roughly same as v1
- The solver redistributes corridor mixing pain between drivers, doesn't eliminate it

### Honest assessment
The floor is higher (no disasters, pairs protected, tighter packing). The ceiling is about the same (4 exact, ~143mi worst DH). The value is in consistency and safety, not peak quality.

## Structural limits (917DK at 9 drivers)
- 41 Monday lanes, 7 corridors, 3 exclusive LV pairs = 6 drivers handling 35 local legs
- At least 1 driver-day will have 2+ corridors (unavoidable)
- SD afternoon legs (203/105/204/106/107) are inherently time-spread → ~143mi DH
- The solver is near-optimal within the assign-then-sequence architecture

## What would move the needle next
1. **Route-first architecture** — generate candidate driver-day routes with known DH, then select covering set. Fundamentally different solver. Would produce better results.
2. **More drivers** — 10 drivers gives more slack, potentially cleaner rows.
3. **Different contract windows** — tighter pickup windows reduce spread.
4. **Integrated sequencing** — deeper Phase 1 modeling of transition costs. The sequence-cost proxy is a step toward this.

## Architecture
```
Phase 1: CP-SAT assignment
  - Pair blocks, HOS constraints
  - Corridor penalties (progressive)
  - Pair corridor protection
  - Sequence-cost proxy (time-gap penalty)
Phase 2: Extract assignments
Phase 3: Drive violation repair
Phase 4: Final sequencing + validation
Phase 5: Fragment-aware local repair
v2: Post-solve optimizer (opt-in)
  - One-way moves + wrong-corridor swaps
  - Quality scoreboard + explainability
  - Tabu memory + pair protection
Best-of-3: Fixed-seed multi-run with quality ranking
```

## All commits this session (20 total)
```
e494403 Add sequence-cost proxy to Phase 1
6e15c44 Improve best-of-N ranking
ea33937 Enable best-of-3 in Convex config
0418fbd Add best-of-N solver with fixed seeds
4e0b3e0 Add configurable idle_weight (behind flag)
46d724a v2.1: slot-fit scoring + idle spread penalty
f3500dc Lock v2.0 baseline doc
96cd308 Pair corridor protection in Phase 1
b2de606 Progressive corridor penalty in Phase 1
1ff1294 Clean pair row protection in v2
711c5b0 Wrong-corridor swap search
7a56ae5 Enable v2 in Convex config
d0335b6 Scoreboard, explainability, tabu
f90e0c9 Day ordering fix + v2Stats on exception
4c45404 v2 local optimizer (core)
10586b1 API validation + error envelopes
7a4e77a Dead file cleanup + track production files
97e03d7 Schema fix (targetDriverCount)
```

## Files
- `scripts/weekly_solver_v4.py` — solver (~3200 lines)
- `scripts/solver_api.py` — HTTP wrapper with validation
- `scripts/lane_solver.py` — shared library
- `scripts/entries.json` — regression test fixture
- `scripts/test_solver_regression.py` — 12-assertion regression test
