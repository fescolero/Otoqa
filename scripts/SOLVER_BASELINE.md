# Weekly Solver v1 Baseline

## Commit
Branch: `autofix/20260331-104805-sqlite-retry-reads-v3`
Commit: `b22fd78` (latest)
Initial baseline: `5224ded`
Date: 2026-04-02 (updated 2026-04-03)

## Solver Settings
- CP-SAT random_seed: 42
- CP-SAT num_workers: 8
- Pre/post trip: 1.0h (60 min)
- Max legs: 8
- Max deadhead: 75 mi
- Max wait: 2.0h
- Max gap: 3.0h
- Drive buffer: 1.5h
- Base: Colton (34.043, -117.333)

## Contract: 917DK (50 lanes)
- Target: 9 drivers
- Corridors: SD, SA, SB, MV, CoI, ANA, LV (7 families)
- LV pairs: 301+302, 303+304, 307+308 (exclusive blocks)

## Monday Baseline Metrics
- Drivers: 9
- HOS Compliant: True
- Exact days: 4
- Estimated days: 5
- 3+ corridor days: 2
- Max single-day DH: 150 mi
- Total Monday DH: 284 mi
- LV blocks: all clean and isolated

## Monday Driver Summary
```
D1: 8L 7.1h/6.0h DH=150mi corr=3 [Estimated]  — structural worst
D2: 2L 1.8h/4.2h DH=0mi   corr=1 [Exact]       — SA pair (615+616)
D3: 8L 3.7h/6.6h DH=60mi  corr=2 [Estimated]
D4: 2L 7.4h/13.8h DH=0mi  corr=1 [Exact]       — LV (303+304)
D5: 5L 8.0h/14.0h DH=0mi  corr=1 [Estimated]   — SD chain
D6: 2L 6.8h/11.5h DH=0mi  corr=1 [Exact]       — LV (307+308)
D7: 4L 6.8h/8.2h DH=74mi  corr=1 [Estimated]   — SD
D8: 2L 7.4h/13.8h DH=0mi  corr=1 [Exact]       — LV (301+302)
D9: 8L 6.2h/7.5h DH=0mi   corr=3 [Estimated]   — multi-corridor
```

## Architecture
1. Pair-block pre-computation (mutual-best matching)
2. CP-SAT assignment over blocks + singletons
3. Per-day exact sequencing (circuit model, 5s timeout)
4. Greedy time-ordered fallback for estimated days
5. Phase 5 local repair on worst estimated rows
6. Compression engine (10->9, triggered when needed)

## Known Limitations (v1 ceiling)
- Estimated days (~63%) have overlapping local legs from different corridors
- Monday has 41 lanes with 197 time-overlapping pairs; max 9 non-overlapping per driver
- At 9 drivers with 6 non-LV handling ~35 local legs, overlaps are mathematically unavoidable
- Weight tuning has hit diminishing returns (proven: same result with different weights + fixed seed)
- Per-day circuit has 5s timeout — complex local days fall back to greedy ordering
- Local repair improves fleet DH more than per-row plausibility
- One structural 3-corridor day at 9 drivers is unavoidable

## What WON'T improve with more v1 tuning
- Cross-corridor overlap count (structural capacity limit)
- Estimated-day route plausibility (assignment-bucket pattern)
- Per-row deadhead concentration (limited by time-slot availability)

## v2 Local Optimizer (separate sprint)
A second-stage optimizer that runs AFTER v1 and cleans up estimated days.

Existing building blocks:
- `_generate_fragments_for_day()` — corridor-coherent fragment builder
- `_row_quality_score()` — scores by DH + corridors + overlaps
- `_count_cross_corridor_overlaps()` — overlap measurement
- `_identify_exclusive_units()` — knows what not to touch
- Phase 5 repair infrastructure — fragment move + resequence

What v2 needs:
- Time-slot-aware recipient scoring (not just HOS feasibility)
- Fragment-level understanding of which moves reduce overlaps
- Only touch Estimated non-exclusive rows
- Accept moves only if: HOS valid, exact count holds, max DH doesn't rise,
  worst-row overlap/quality improves

This is a sprint, not a tweak. Keep v1 stable; build v2 as a separate layer.
