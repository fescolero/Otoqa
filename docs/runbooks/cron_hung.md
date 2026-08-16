# Runbook — `cron_hung`

**What fired.** A run claimed a start (`inFlightSince`) more than 15 minutes ago
and never reported an outcome.

**What it means.** The action was killed mid-flight — a timeout, a deploy that
landed during the run, or an infrastructure interruption. Because the ledger is
written *after* the target returns, the run left no outcome row at all.

**Check first**

1. Was there a deploy around `inFlightSince`? A deploy during a long action is
   the most common cause and is self-healing.
2. Convex dashboard → Logs for the job name around that timestamp. Look for a
   timeout or an out-of-memory kill.
3. Does the job self-schedule in batches (`archive-old-*`, snapshot rebuilds)?
   Those should never run long enough to hang — a hang there means a batch is
   not converging (check the cursor logic).

**Fix**

- Deploy-related → no action; the next tick clears `inFlightSince`.
- Genuine timeout → reduce the batch size, or split the work across more
  self-scheduled batches. Do not raise the hang threshold to hide it.
- Repeated hangs on the same job → treat as a bug, file a ticket, and consider
  retiring the schedule until it's fixed rather than leaving it half-running.

**Escalate when** the same job hangs twice in a day, or a hang leaves partial
writes (any job that mutates money or sessions).

**Resolved when** the job completes a run. The next successful `record` clears
the marker and the alert auto-resolves.
