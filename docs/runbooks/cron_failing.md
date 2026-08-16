# Runbook — `cron_failing`

**What fired.** 3+ consecutive failed ticks. One flaky tick is noise; three is a
stuck job.

**Check first**

1. Jobs board → **History** on the job. `p50`/`p95` duration plus the last 25
   runs. Did it slow down before it started failing? That usually points at data
   volume rather than a code bug.
2. The `lastError` on the row is the truncated message; the full stack is in the
   Convex logs (the wrapper rethrows precisely so this stays true).
3. Was there a deploy immediately before the first failure? Compare with
   `git log` for the job's module.

**Fix**

- New code → revert or fix forward; the job recovers on its next tick and the
  consecutive counter resets to 0 automatically.
- Bad data (one poisoned row failing every run) → find it from the error, fix
  the row, let the job retry. Do not add a blanket try/catch that swallows the
  failure — that converts a loud problem into a silent one.
- Upstream vendor outage → snooze the alert for the vendor's stated ETA rather
  than resolving it, and note the vendor ticket on the alert.

**Escalate when** the failing job writes money or ends driver sessions, or when
failures span multiple unrelated jobs (look for a shared helper or a schema
change).

**Resolved when** one tick succeeds. Auto-resolves within 5 minutes.
