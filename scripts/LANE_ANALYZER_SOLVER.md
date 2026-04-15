# Lane Analyzer Weekly Solver

**Component:** `scripts/weekly_solver_v4.py` (greedy path)
**Last successful run:** 129-lane 917Q3 contract → **19 drivers** (down from 20)

This document captures the current state of the greedy weekly solver, the fixes that got us here, planned improvements, and — importantly — **approaches that caused regressions** and should be avoided.

---

## Architecture Overview

The solver has three codepaths selected by `config.solver_version`:

| Path | Entry | Status |
|---|---|---|
| `greedy` (default) | `_build_greedy_schedule` | **Production** — all current contracts use this |
| `v4` | `_build_and_solve` | CP-SAT full assignment — slow on large lane sets |
| `v5` / `v5_hybrid` | `_build_and_solve_v5` | Route-candidate approach — experimental |

The greedy path runs in **five phases**:

1. **Pair detection** — detect natural same-day reverse pairs (A→B immediately followed by B→A with gap ≤ 0.5h)
2. **Slot planning** (`_plan_day_slots`) — group lanes by corridor with city-overlap preference
3. **Route building** (`_build_corridor_route`) — greedy chain extension with pair-atomic enforcement
4. **Route merging** (`_do_all_pairs_merge`) — two-tier merge with best-of-3 orderings
5. **Singleton absorption** + **gap-fill pair moves** — post-merge refinement
6. **Weekly rotation** — CP-SAT assigns routes to drivers respecting 10h off-duty + 70h weekly cap

HOS constraints enforced per route: **11h drive**, **14h duty** (span-based), **10h off-duty** between days, **70h weekly**.

---

## The Journey: Fixes That Got Us Here

### 1. Slot-merge DH scoring bug (lines ~3361-3373)

**Problem.** When `_plan_day_slots` merged a small corridor into an existing slot, it scored DH using `slot_lids[-1]` (last leg by **insertion order**) instead of the chronologically last leg. After merge, the slot was not re-sorted, so every subsequent merge scored from the wrong endpoint.

**Fix.** Use `max(slot_lids, key=lambda lid: lane_map[lid].finish_time)` for the anchor, and re-sort the slot by pickup time after each merge.

**Impact.** Better grouping decisions → fewer routes per day.

### 2. Multi-ordering all-pairs merge (`_do_all_pairs_merge`)

**Problem.** The original merger picked the lowest-DH pair globally on each pass. A merge that saved 5 DH locally could orphan another route into a 150 DH merge.

**Fix.** Run the merge under **3 different orderings** (smallest-first, largest-first, earliest-pickup) and keep the one with the lowest total DH that meets the target.

**Impact.** 50-lane benchmark: DH dropped from 286 → 154 mi. Driver count matched proven optimum (9).

### 3. Gap-fill paired leg moves (lines ~4080-4155)

**Problem.** Gap-fill pass had a comment saying "pair moves handled separately below" — but no pair-move logic existed. Paired legs were skipped entirely, leaving DH on the table.

**Fix.** Added explicit pair-move branch: if a filler leg's partner is also on the source route, consider moving **both legs together** into the gap. Preferred over single-leg fill when the per-leg DH cost is ≤ 1.5× the single-leg cost (pair move removes 2 legs from the source = better compression).

### 4. Two-tier merge feasibility (`_fast_merge_check`)

**Problem.** The merge loop called `_sequence_driver_day` (full CP-SAT) hundreds of times per day just to test feasibility. On the 129-lane contract this took **220s per driver-count attempt** — the auto-search blew the 600s Convex budget.

**Fix.** Added `_fast_merge_check` using `_greedy_time_order` + `_metrics_from_chain` (no CP-SAT). Tier 1 uses the fast check; Tier 2 falls back to CP-SAT only when Tier 1 finds nothing (captures interleaving merges the greedy ordering misses).

**Impact.** 129-lane: 220s → **19s per attempt** (11× speedup). Auto-search now fits the Convex budget.

### 5. Skip unmergeable routes (duty > 12h)

**Problem.** Some routes (long-haul pairs like `9173Q-301`, `9173Q-303` with 13.8h duty spans, or `925LD-244` with a 13.7h overnight span) are structurally unmergeable — no leg can fit in their ~0-1h remaining duty headroom. The merge loop kept retrying them every iteration.

**Fix.** Pre-compute `w_duty` per route; skip any route with `duty > 12h` from merge candidacy. Rebuilds after each successful merge.

### 6. Early-exit before weekly rotation

**Problem.** `_build_greedy_schedule` built all daily routes, then **always** ran the expensive CP-SAT weekly rotation — even when the peak day already had more routes than the target driver count (guaranteed infeasible).

**Fix.** After route building, if `max_routes_any_day > n_drivers`, return `None` immediately — skip rotation.

**Impact.** Probe attempts that were always going to fail now return in ~1s instead of 20s.

### 7. Singleton absorption

**Problem.** The all-pairs merge sometimes left 1-2 leg routes that couldn't merge with each other (e.g. the 1-leg `925LD-244` + a 2-leg long-haul pair). These wasted driver slots.

**Fix.** After the all-pairs merge, iteratively try to absorb any remaining ≤2-leg route into a larger route. Skip small routes whose own duty already exceeds 12h (they're genuinely unmergeable).

### 8. DH corrections

- **Road-correction factor (1.15×)** applied to reported haversine distances for display (applied only at output, not in solver decisions to avoid tightening the HOS envelope).
- **City-pair distance cache** populated from known-good haversine computations; eliminates the 150mi fallback for unknown-coords cases.
- **Hub detection fallback** (`_hub_of_leg`): for unpaired return legs like `Las Vegas → Colton`, now checks origin/destination against a known-hub set and correctly assigns `Colton` as the hub (previously defaulted to origin city).

### 9. `max_legs` tuning (8 → 10)

**Problem.** The session config's `maxChainingLegs: 8` was capping routes at 8 stops even when drivers could physically fit more (short-haul SoCal corridors like Ontario↔MV at ~30 min each take very little drive time). This forced extra routes → extra drivers.

**Fix.** Bumped session config to `maxChainingLegs: 10`.

**Impact.** 129-lane contract: Tuesday **20 → 18**, Friday **20 → 19**, total drivers **20 → 19**.

HOS was not relaxed — `max_legs` is an artificial cap, not an HOS limit. The 14h duty and 11h drive constraints still apply. Drivers doing 10 short-haul stops use maybe 5h of drive time; they hit the cap long before HOS.

### 10. Contract-lane schedule field (days of week)

**Problem.** Every lane imported from `contractLanes` was hardcoded to `activeDays: [1,2,3,4,5]` (Mon-Fri) in `importLanesFromContract`. Lanes that actually ran Tue/Thu or Sat/Sun were scheduled on wrong days.

**Fix.**
- Added optional `scheduleRule` field to `contractLanes` schema (shape matches `laneAnalysisEntries`)
- Added `DaysOfWeekSelector` component (pill-style day picker + holiday checkbox)
- Wired into both create and edit contract-lane pages
- `importLanesFromContract` now reads `lane.scheduleRule` (falls back to Mon-Fri for old lanes)
- Extracted shared `scheduleRuleValidator` → `convex/lib/validators.ts`

---

## Current Production Behavior

| Benchmark | Before Session | After Session |
|---|---|---|
| 50-lane 917DK (single hub) | 10 drivers, 286 DH, 0.6s | **9 drivers**, 154 DH, **0.2s** |
| 129-lane 917Q3 (3 hubs) | 20 drivers, ~1194 DH, 220s/probe | **19 drivers**, 1664 DH, **19s/probe** |

The 129-lane case still has unavoidable structural costs:

- **3 long-haul LV pairs** (`9173Q-301/302`, `9173Q-303/304`, `9173Q-307/308`) — each pair owns a driver, duty span 11.5-13.8h, nothing else fits
- **`925LD-244`** — Ontario 23:56 → MV 12:48 next day — 13.7h duty span, zero headroom, owns its own driver
- **Cross-hub DH** — Ontario↔Anaheim transitions at ~16mi and SD orphaned returns at ~75mi

---

## Possible Improvements (Worth Trying)

### 1. Unify Tier 1 / Tier 2 merge loops

The fast-check and CP-SAT merge loops inside `_do_all_pairs_merge` have identical structure. Factoring into a parameterized inner helper would halve ~55 lines. **Risk: medium.** Worth doing once someone has time to carefully regression-test on both benchmarks.

### 2. Extract `_duty_span` helper

Duty-span computation (`max(ends) - min(starts) + pre_post_h`) is duplicated at 15+ sites throughout the file. Extracting a helper eliminates drift and fixes a latent `0.0` pickup-time bug (some sites use truthy `if lane.pickup_time` instead of `is not None`, so a midnight pickup gets silently dropped). **Risk: low** but requires touching code outside this session's scope.

### 3. Process-pool the 3 orderings

The best-of-3 orderings in `_do_all_pairs_merge` are independent and CP-SAT-bound. `ProcessPoolExecutor(max_workers=3)` could ~3× the merge phase. **Risk: medium** — process startup overhead and Python pickling of lane objects need to be measured.

### 4. LRU cache `_compute_dh`

The same city-pair haversine is computed repeatedly inside nested merge loops. `@functools.lru_cache(maxsize=4096)` keyed on lane-ids (or rounded lat/lng) would eliminate most repeat work. **Risk: low** — just instrument first to confirm it's actually a hot path.

### 5. Extract `_duty_span` → bake it into a `Route` dataclass

Instead of carrying `(legs, corridor_tag)` tuples and recomputing duty everywhere, define a `Route` dataclass with `legs`, `corridor`, `duty_hours`, `start_time`, `end_time`. Update on mutation. This is the structural fix that makes improvement #2 cleaner. **Risk: medium** — widespread change.

### 6. Let the user set `max_legs` per session from the UI

Currently requires editing the Convex session document manually or via CLI. A simple numeric input in the session config panel would make the Tue/Fri-compression trick accessible.

### 7. Read frequency from historical FourKites data on import

The new `scheduleRule` field on `contractLanes` is currently user-editable only. If the FourKites sync sees the same HCR+Trip combination running on specific days, we could auto-populate `activeDays` on first match.

### 8. Allow user to override specific lanes' schedules in the Lane Analyzer

Currently `scheduleRule` lives on `contractLanes`. If a specific Q3 analysis needs to override one lane's days without mutating the contract lane, the `laneAnalysisEntries` row could accept an override.

---

## ⚠️ Avoid These (Regressions We Hit)

### ❌ Do NOT apply road-correction to internal solver DH

**What we tried.** Multiplied `_compute_dh` output by 1.27 (national average circuity) for both reporting AND internal timing.

**What happened.** Internal HOS envelope tightened because `dh_hours = dh_miles / 55.0` now included ~30% more miles. Merges that previously fit within 14h duty now failed. 50-lane regressed from 9 → 10 drivers.

**Lesson.** Road-correction is output-only. The solver must use haversine internally because highway speeds (~55mph on I-10/I-15 in SoCal) are closer to haversine than to full-road-distance. Apply the correction factor **only** when writing `deadheadMiles` to the final schedule.

Current factor is **1.15×** (SoCal interstate is more direct than the national average).

### ❌ Do NOT add a hub-mixing penalty to the merge scorer

**What we tried.** Added a 300-point penalty when merging routes from different hubs (Colton/Ontario/Anaheim), thinking it would prefer same-hub merges.

**What happened.** The penalty was so large it forced the solver to leave small routes unmerged rather than accept any cross-hub merge. Total DH went from 1194 → **2192mi** with 3 new HOS violations.

**Lesson.** The corridor structure already encodes hub affinity implicitly (same-hub routes share cities). An explicit penalty disrupts the merge gradient and drives the solver into worse local minima.

### ❌ Do NOT relax `_sequence_driver_day`'s wait threshold without reviewing all callers

**What we tried.** Changed the internal wait filter from `wait > max_wait_h: continue` to `wait > HOS_MAX_DUTY: continue` to allow the Tier 2 path to accept more merges.

**What happened.** The comment still said "too long to wait" but the threshold was now 14h. Other callers of `_sequence_driver_day` (V2 optimizer, exact-sequencing pass) silently started accepting nonsensical waits.

**Lesson.** When relaxing a shared helper, either grep all callers or duplicate the function first. The wait bound is now enforced by `_fast_merge_check`; document the delegation or revert one of the two edits.

### ❌ Do NOT use CP-SAT inside O(n²) merge loops

**What we tried.** The original all-pairs merge called `_sequence_driver_day` (CP-SAT, 5s timeout, 4 workers) for every candidate pair, for every driver-count probe, for every ordering.

**What happened.** 220 seconds per probe on 129 lanes. Auto-search ran out of the 600s Convex action budget after 2-3 probes.

**Lesson.** Use `_fast_merge_check` (greedy + metrics only, no CP-SAT) for the hot feasibility loop. Reserve CP-SAT for the Tier 2 fallback and the final per-day sequencing, which runs O(days) times, not O(n²).

### ❌ Do NOT delete verbose per-day diagnostic prints entirely

**What we considered.** Removing the `for _dd in sorted(day_routes)` block that prints per-day route sizes and small-route breakdowns.

**What happened.** We gated it behind `SOLVER_DEBUG=1` instead. The diagnostic is essential when a contract has an unexpectedly high driver count — it shows which routes are 1-2 legs and why (duty span too wide, unmergeable, etc). Removing it blindly would make future bug reports much harder to triage.

**Lesson.** For solver output, default **quiet**, but keep the detailed printer one env var away. Never delete diagnostic output without gating.

### ❌ Do NOT collapse `scheduleRule` validator into an anonymous inline object in every mutation

**What we had.** Three files (`schema.ts`, `contractLanes.ts`, `laneAnalyzer.ts`) each had an inline `v.object({activeDays, excludeFederalHolidays, customExclusions})`.

**What could go wrong.** The three would drift. A new field added to one would silently fail validation in the others.

**Lesson.** Shared validators live in `convex/lib/validators.ts`. All three sites now import `scheduleRuleValidator` from there.

### ❌ Do NOT hardcode `[1,2,3,4,5]` as the contract-lane import default without exposing it to the user

**What was there.** `importLanesFromContract` assumed every contract lane runs Mon-Fri. Any lane actually running Tue/Thu or Sat/Sun was scheduled on the wrong days → solver would either over-schedule or drop the lane from its real days.

**Lesson.** `scheduleRule` now lives on `contractLanes` and the UI exposes it. The Mon-Fri fallback still exists for lanes imported before the field was added, but it's marked as "default for lanes without schedule" — a clear opt-in for the user to correct.

### ❌ Do NOT assume a 1-leg route is a bug

**What we assumed.** Saw Driver 4 on Monday with only 1 leg (`925LD-244`) and thought the merger had a bug.

**What it actually was.** That lane's pickup is 23:56 and delivery is 12:48 next day. The duty span is already 13.7h out of 14h. No other leg can possibly fit. The singleton is **correct** — it inherently needs its own driver.

**Lesson.** Before chasing a small-route "bug", check the duty span of the route. If it's > 12h, the route is structurally locked and nothing the solver does can change that. Our singleton-absorption loop now explicitly skips routes with `s_duty > 12.0`.

### ❌ Do NOT run `npx convex dev --once` against production without checking the branch

Most Convex schema edits during this session were done on the dev deployment. When committing, make sure the branch matches the deployment environment. Schema changes pushed to the wrong env are hard to roll back.

---

## Key File Map

| File | Role |
|---|---|
| `scripts/weekly_solver_v4.py` | Solver (3 paths, ~5000 lines). Greedy is production. |
| `scripts/run_solver_local.py` | Local runner — reads `exportEntriesForSolver` JSON, writes `weeklySchedule` JSON for injection |
| `scripts/solver_api.py` | HTTP wrapper — Convex action calls this with POST /solve-weekly |
| `convex/schema.ts` | `contractLanes.scheduleRule` + `laneAnalysisEntries.scheduleRule` — both use shared validator |
| `convex/lib/validators.ts` | Shared `scheduleRuleValidator` |
| `convex/contractLanes.ts` | `create` / `update` mutations accept `scheduleRule` |
| `convex/laneAnalyzer.ts` | `importLanesFromContract` reads `lane.scheduleRule` with Mon-Fri fallback |
| `convex/laneAnalyzerActions.ts` | External solver action — posts to `$SOLVER_API_URL/solve-weekly`; handles large-lane try/catch |
| `convex/laneAnalyzerCalculations.ts` | Batch-processing variants for large lane sets |
| `components/contract-lanes/days-of-week-selector.tsx` | Reusable day picker (7-button pill row + holiday checkbox) |
| `app/(app)/operations/customers/[id]/contract-lanes/create/page.tsx` | New lane form — includes Operating Schedule card |
| `app/(app)/operations/customers/[id]/contract-lanes/[laneId]/edit/page.tsx` | Edit form — populates `activeDays` from existing rule |

## Debug Knobs

- **`SOLVER_DEBUG=1`** — verbose per-day route sizes + small-route duty breakdown
- **`config.target_drivers`** — force a specific driver count (skip auto-search)
- **`config.best_of_n`** — number of seeds to try (default 3, set to 1 for speed during debugging)
- **`config.max_legs`** — per-driver leg cap (default 8 in session config; **10 recommended for multi-hub contracts**)
- **`config.max_wait`** — max idle hours between legs (default 2h)
- **`config.max_deadhead`** — max DH miles per leg transition (default 75)

## Running Locally

```bash
# 1. Export session data
npx convex run laneAnalyzer:exportEntriesForSolver '{"sessionId":"<id>"}' > /tmp/entries.json

# 2. Run solver
python3 scripts/run_solver_local.py /tmp/entries.json /tmp/output.json

# 3. With debug output
SOLVER_DEBUG=1 python3 scripts/run_solver_local.py /tmp/entries.json

# 4. Start the HTTP API (for Convex integration)
python3 scripts/solver_api.py &  # runs on :8080
curl http://localhost:8080/health
```
