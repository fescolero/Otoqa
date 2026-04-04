# Weekly Solver v2.0 Baseline

## Commit
Branch: `autofix/20260331-104805-sqlite-retry-reads-v3`
Latest commit: `96cd308`
Date: 2026-04-03

## What shipped in v2.0

### Phase 1 improvements
- **Progressive corridor-count penalty** (`b2de606`)
  - 2 corridors: 300 (acceptable)
  - 3 corridors: 4,800 (2.7x steeper than v1)
  - 4 corridors: 16,800 (5x steeper)
  - 5+ corridors: 28,800 (6x steeper)
  - Result: eliminated 5-corridor disaster rows

- **Pair corridor protection** (`96cd308`)
  - 200-weight penalty per cross-corridor leg assigned to a driver with a clean reverse pair
  - Result: 615→616 SA pair no longer gets contaminated with SD/SB legs

### v2 local optimizer (post-solve)
- **Opt-in**: gated behind `config.enable_local_optimize` (off by default, enabled in Convex)
- **One-way fragment moves** (`d0335b6`): move corridor-coherent fragments between same-day drivers
- **Wrong-corridor swap search** (`711c5b0`): target minority-corridor fragments, swap with complement
- **Quality scoreboard** (`d0335b6`): pre/post worst score, total overlaps, total DH
- **Explainability** (`d0335b6`): per-move logging of scores, DH, overlaps, corridors
- **Tabu memory** (`d0335b6`): prevents oscillation (D9→D4 then D4→D9)
- **Clean pair protection** (`1ff1294`): estimated 2-leg pairs with same corridor + <20mi DH are frozen
- **Budget**: 5 iterations, 15s wall clock, 12 max exact scores

### API hygiene
- **Input validation** (`10586b1`): reject malformed requests (400), catch solver crashes (500)
- **Error envelopes**: consistent `{"success": false, "error": "..."}` on all error paths
- **CORS**: headers on all responses including errors
- **Schema fix** (`97e03d7`): added `targetDriverCount` to Convex schema

## Contract: 917DK (50 lanes, 9 drivers)

### Monday best result (v2.0)
```
D1: 2L exact  — LV (307+308)
D2: 2L exact  — LV (303+304)
D3: 8L est    — SB-dominant + SA oddball. 2 corridors.
D4: 6L est    — COI + ANA. 2 corridors, geographically close.
D5: 8L est    — SD + SA + MV. ~3 corridors. Needs v2.1.
D6: 2L exact  — SA pair (615+616). PROTECTED.
D7: 5L est    — Pure SD. +149mi DH. Same-corridor density problem.
D8: 2L exact  — LV (301+302)
D9: 6L est    — SA + MV + SB. ~3 corridors. Needs v2.1.
```

### Metrics comparison
| Metric | v1 baseline | v2.0 best |
|--------|------------|-----------|
| Exact days Mon | 4 | 4 (can produce 4, not guaranteed) |
| 3+ corridor rows | 2 | 0-2 (usually 0-1) |
| 5-corridor rows | 1 | 0 (eliminated) |
| 615/616 pair | sometimes broken | protected |
| Max single-day DH | 150mi | ~149mi |
| v2 moves accepted | n/a | 1-2 per run |

## Known limitations (v2.0 ceiling)
- **Same-corridor DH**: D7-style pure-corridor rows with high DH are not addressed by corridor count pressure
- **Exact count varies**: 3-4 exact days depending on CP-SAT search path (seed=42 but timing-sensitive)
- **Nondeterminism**: v1 CP-SAT produces different base assignments across runs
- **Swap hit rate**: wrong-corridor swap search finds improving swaps ~30% of runs (complement pool often thin)
- **3-corridor rows still possible**: penalty makes them expensive but not impossible

## v2.1 Sprint Plan

### Primary: time-window slot-fit scoring
- Score recipient days by how well a fragment's pickup times fit between existing legs
- Reduce same-corridor deadhead by preferring tight time-slot insertions
- This targets D7-style rows where the problem is spread, not corridor mixing

### Secondary: experimental Phase 1 DH penalty
- Optional penalty for same-corridor spread (large time gaps between same-corridor legs)
- Behind a flag, not the default
- Test whether it helps without creating new tradeoff problems

### Do not touch
- Corridor-count weights (solved)
- Cross-day logic (too risky)
- More random v2 tuning without clear targets

## Architecture (v2.0)
```
Phase 1: CP-SAT assignment (pair blocks, HOS, corridor penalties, pair protection)
Phase 2: Extract assignments
Phase 3: Drive violation repair
Phase 4: Final sequencing + validation
Phase 5: Fragment-aware local repair (one-way moves)
Phase 5b: DH repair on worst rows
v2: Post-solve local optimizer (opt-in)
  - One-way fragment moves
  - Wrong-corridor swap search
  - Quality scoreboard + explainability
  - Tabu memory
  - Clean pair protection
  - Rollback on any regression
```

## Files
- `scripts/weekly_solver_v4.py` — solver (~3100 lines)
- `scripts/solver_api.py` — HTTP wrapper with validation
- `scripts/lane_solver.py` — shared library
- `scripts/entries.json` — regression test fixture
- `scripts/test_solver_regression.py` — 12-assertion regression test
- `scripts/SOLVER_BASELINE.md` — this file
