# Runbook — `cron_stale`

**What fired.** A scheduled job has not started for more than 3× its declared
cadence (plus a 60s grace). Declared cadence comes from the `job()` descriptor
in `convex/crons.ts`; the state is computed in `convex/platform/jobHealth.ts`.

**What it means.** The job is not running *at all*. This is different from — and
usually worse than — a failing job: nothing throws, nothing logs, and before
staleness detection existed the board showed the last successful tick forever.

**Check first**

1. Jobs board → the job's row. Is `state` stale for one job or many?
   - **Many jobs stale at once** → Convex scheduling itself is stalled. Check
     the Convex status page and the deployment's Functions view. This is an
     incident, not a job bug.
   - **One job stale** → continue.
2. Is the job still present in `convex/crons.ts` on `main`? A job deleted in a
   deploy leaves its `cronHealth` row behind.
   - Deleted deliberately → **Retire** it from the jobs board (audited, and it
     un-retires automatically if it ever fires again).
3. Convex dashboard → Logs, filtered to the job name. A job that is scheduled
   but erroring *before* the wrapper records will show there and nowhere else.

**Fix**

- Job removed → retire the row.
- Scheduling stalled → escalate; there is no local fix.
- Renamed job → the old name goes stale and the new name appears as a fresh
  row. Retire the old one.
- Cadence declared wrongly (alert is a false positive) → correct the `every`
  argument in `crons.ts`; the value must match the schedule beside it.

**Escalate when** more than one job is stale, or a money-touching job
(`platform-invoice-cycle-close`, `recalculate-platform-usage`,
`driver-settlement-generation`) has been stale for more than one cycle.

**Resolved when** the job records a tick — the alert auto-resolves on the next
evaluator run (≤5 min). Don't manually resolve a stale alert whose job still
isn't running; it will simply re-open. Snooze it if you're waiting on a deploy.
