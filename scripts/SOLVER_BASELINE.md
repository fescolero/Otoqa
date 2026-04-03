# Weekly Solver v1 Baseline

## Commit
Branch: `autofix/20260331-104805-sqlite-retry-reads-v3`
Commit: `5224ded`
Date: 2026-04-02

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

## Known Limitations
- Estimated days (~63%) still show assignment-bucket patterns
- Per-day circuit has 5s timeout — complex local days fall back to greedy
- Local repair improves fleet DH more than per-row plausibility
- One structural 3-corridor day at 9 drivers is unavoidable
- CP-SAT nondeterminism means results vary slightly (seed helps)

## Next Sprint
- Post-solve fragment-aware repair (Option 2)
- Make Phase 5 repair corridor-coherent
- Only on estimated rows, strict guardrails
- Don't touch CP-SAT model for fragment assignment
