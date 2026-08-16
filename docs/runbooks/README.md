# Runbooks

One file per alert kind the platform console can raise. The console links here
by `kind`, so **the filename must match the alert's `kind` value** —
`platformAlerts.kind` → `docs/runbooks/<kind>.md`.

| Alert kind | Runbook | Raised by |
| --- | --- | --- |
| `cron_stale` | [cron_stale.md](./cron_stale.md) | job hasn't run for 3× its declared cadence |
| `cron_hung` | [cron_hung.md](./cron_hung.md) | run claimed a start and never reported (>15 min) |
| `cron_failing` | [cron_failing.md](./cron_failing.md) | 3+ consecutive failures |
| `webhook_dead_letters` | [webhook_dead_letters.md](./webhook_dead_letters.md) | >10 deliveries dead-lettered |
| `fourkites_all_failed` | [fourkites_all_failed.md](./fourkites_all_failed.md) | every push in a tick failed for one org |
| `billing_drift` | [billing_drift.md](./billing_drift.md) | usage rose after the period was invoiced |
| — | [break_glass.md](./break_glass.md) | the console or staff IdP is unavailable |

## Writing one

Keep them short and decision-shaped. An operator reads a runbook at 3am while
something is broken; the goal is the first correct action inside 30 seconds.

Every runbook answers, in this order: **what fired**, **what it means**, **what
to check first**, **how to fix it**, **when to escalate**, and **what "resolved"
looks like**.
