# Platform Console — Operations-Readiness Plan

_Status: proposal for review. Written 2026-08-16 against commit `7931a9e`._
_Companion to `docs/platform-admin-console-plan.md` (the build plan) and
`docs/platform-billing-spec.md` (billing). This document does not restate them —
it audits what actually shipped, compares it to how comparable consoles are run,
and proposes the work that turns a wired-up draft into something an on-call
person can be handed._

---

## 1. Where we actually are

The v2 plan phased the work 0→4. Verified against source, essentially **all five
phases have landed as code**, and the tests are real (55 passing across
`access.test.ts` + `phase1..4.test.ts`, covering staff-allowed / tenant-rejected /
Clerk-rejected / unauthenticated-rejected on every namespace).

| Phase | Planned | Shipped | Notes |
| --- | --- | --- | --- |
| 0 Foundation | staff issuer, `requirePlatformStaff`, admin app, audit log, hardening, CI | ✅ code complete | `convex/lib/auth.ts:126`, `auth.config.ts`, `apps/admin/*`, `platformAuditLog` (`schema.ts:4053`), CI typecheck entry (`.github/workflows/ci.yml:41`) |
| 1 Visibility | snapshots, org directory/detail, revenue, cron ledger, health, events feed, client errors | ⚠️ mostly | Everything except the **PostHog client-errors page** (§7.1 of the build plan) — not built, no route, no dependency in `apps/admin/package.json` |
| 2 Operations | support actions, step-up, tickets + report-a-problem, alerts + Slack, dead-man's switch, status page, runbooks | ⚠️ partial | Actions/step-up/alerts shipped. **`reportProblem` has zero callers** in web/dispatch/driver. **No `docs/runbooks/`**, no status page |
| 3 Billing | invoices, cycle close, adjustments, drift, effective-dated rates, tenant page reads invoices | ✅ complete | `platform/invoices.ts` (658 lines), drift hook, `getBillingOverview` now reads `platformInvoices` (`platformUsage.ts:425`) |
| 4 Advanced | Stripe, view-as-org, SLO dashboards | ✅ code complete | `platform/stripe.ts` incl. webhook signature verify + nightly reconcile; SLI board in `platform/slo.ts`; read-only recent-loads slice on org detail |

**What's genuinely good and should not be touched:** the isolation contract
(separate issuer, fail-closed, no tenant helper reuse), the audit helper that
*refuses to log* — and therefore refuses to happen — without a reason on
destructive actions (`lib/platformAudit.ts:74`), the action-level cron wrapper
with rethrow, the invoice immutability rule, and the honest denial screen that
distinguishes the three rejection causes. That's better than most internal
consoles at this stage.

**The gap is not features. It's the difference between "the code exists" and
"an operator can trust it at 3am."** Three themes:

1. **It can lie by omission.** A cron that stops firing entirely stays green
   forever. The needs-attention feed never clears. Alerting is inert until a
   webhook env var is set, and nothing says so.
2. **It's config-gated on things nobody has confirmed.** Step-up auth, Axiom,
   Slack, synthetic checks — all unverified against production.
3. **It's a dashboard, not a workflow.** No search, no pagination, no
   per-object history, no runbooks, no "run this job now", no way to file the
   tickets the ticket board displays.

---

## 2. How this compares to consoles that are run for real

Not aspiration — these are the specific things mature internal consoles (Stripe's
internal admin, Shopify, Vercel, AWS/GCP consoles, PagerDuty-adjacent tooling)
have that we don't, ordered by how much they'd change a real incident:

| Pattern | Them | Us | Verdict |
| --- | --- | --- | --- |
| **Liveness of the monitoring itself** | Heartbeat + absence monitor + configured-integrations self-check on the dashboard | Heartbeat line logged (`platform/alerts.ts:20`), but the absence monitor lives in Axiom, which may not exist. Slack silently no-ops without `SLACK_ALERT_WEBHOOK_URL` | **Must fix.** Silence is currently indistinguishable from health |
| **Staleness detection on scheduled work** | Job registry with expected cadence; "hasn't run in 3× interval" is a first-class alert | Only `consecutiveFailures ≥ 3` alerts. No expected interval stored | **Must fix.** Biggest blind spot in the system |
| **"What changed recently"** timeline | Deploys + flags + staff actions in one chronological view — the most-used incident page anywhere | Pieces exist (`platformAuditLog`, flag `updatedAt`), never joined | High value, cheap |
| **Per-object history** | Every object page shows prior admin actions on it | `by_target_org` index exists (`schema.ts:4067`) and **has no reader** | Cheap, high value |
| **Global search** | One box → org, user, load, invoice, ticket | Client-side substring filter on the org directory only | Medium |
| **Alert → runbook link** | Every alert carries a link to "what to do about it" | No runbooks exist | Must fix before handing to anyone but the author |
| **Ack/ownership on signals** | Ack has an owner, a note, and a snooze | Alerts ack (owner recorded); `systemEvents` cannot be acked at all | Must fix — an unclearable feed gets ignored |
| **Access review** | Console shows who has access + last login; quarterly review is a workflow | Allowlist is an env var, invisible from the console | Must fix (compliance-grade, and it's ~40 lines) |
| **Pagination + export** | Cursor paging, CSV export, saved filters | `take()` caps everywhere, `.collect()` on the directory, no export | Medium (bites at volume) |
| **Console observability** | The admin app reports its own errors | No PostHog/Sentry in `apps/admin` | Medium |
| **Blast-radius controls** | Confirm-typed names ✅, plus notify-on-destructive and (bigger orgs) approval | Typed confirm exists; Slack notify on destructive action is in the plan's matrix but not implemented | Low effort, do it |
| **Keyboard/command palette** | Standard | None | Later — real, but not readiness |

Two deliberate non-gaps worth recording so we don't relitigate them: **no console
RBAC tiers** (flat access + audit is the right call at this headcount) and **no
paging/PagerDuty** (no on-call rotation to page yet). Both stay as-is.

---

## 3. Findings, with evidence

### 3.1 Launch gates — unverified config the design leans on

**G1. Step-up auth may fail closed against real tokens.**
`requireRecentStaffAuth` (`convex/lib/auth.ts:186`) requires an `auth_time` claim
and rejects when it's absent. Every test injects it manually
(`phase2.test.ts:38`). Nothing has confirmed a WorkOS AuthKit access token
carries `auth_time`. If it doesn't, **every destructive action is bricked**:
force-end session, global flags, identity-link edits, org delete/restore, void
invoice, billing config, Stripe push. This is the single highest-risk unknown.
_Fix path if absent:_ mint sudo console-side — a `/step-up` route that re-runs
AuthKit with `prompt=login`, records the timestamp in a short-lived signed cookie
+ a `platformStepUp` row, and have the guard read that instead of the claim.

**G2. Axiom (plan §14-V1) is still undecided.** Three capabilities are delegated
to it and exist nowhere else: log search, error-rate monitors, and the
dead-man's-switch absence monitor. If Axiom isn't on, the heartbeat line at
`platform/alerts.ts:20` is decoration.
_Fallback that needs no vendor:_ a `platformHeartbeat` row + an external cron-ping
monitor (UptimeRobot/Cronitor "expected heartbeat" URL, free tier) hit by the
evaluator — the check then lives outside our infrastructure, which is the whole
point of a dead-man's switch.

**G3. Slack alerting is inert until `SLACK_ALERT_WEBHOOK_URL` is set**
(`platform/alerts.ts:notifySlack` returns early). No surface tells you it's unset.

**G4. `/liveness` exists (`convex/http.ts:164`) but nothing checks it.** No
external monitor is configured or documented.

**G5. No `docs/runbooks/`, no status page.** Both were plan §9 commitments.

**G6. Convex backup/restore never tested (plan §14-V5).** No RPO/RTO written down.

### 3.2 Reliability — where the console can be wrong

**R1. Stale-job blindness.** `cronHealth` (`schema.ts:4095`) stores no expected
cadence, and the evaluator only reacts to `consecutiveFailures`. A job removed
from `crons.ts`, a scheduler stall, or an action killed by timeout/deploy before
`record` runs leaves the last-known-good row untouched — **the board shows green
indefinitely**. With 29 jobs including revenue-critical ones
(`platform-invoice-cycle-close`, `recalculate-platform-usage`), this is the
failure mode most likely to cost money quietly.

**R2. No in-flight marker.** `cronRunner.run` writes the ledger only *after* the
target returns (`platform/cronRunner.ts:47`). A hung or killed action is
invisible — not failed, not running, just absent.

**R3. Console queries subscribe to the platform's hottest tables.** Convex
queries are live subscriptions, so cost scales with `open tabs × write rate`:
- `slo.sloOverview` takes the last 500 `apiAuditLog` rows — that table is written
  on **every partner API request**.
- `health.integrationHealth` subscribes to `webhookDeliveryQueue` and
  `fourKitesPushTickHealth` (written every 60s per org).
- `billing.revenueOverview` `.collect()`s **all** organizations and every org's
  `platformUsageStats` — invalidated by every metered load write.
- `jobs.listJobs` subscribes to `cronHealth`, upserted **every 10 seconds** by
  the Samsara poll.

This contradicts the plan's own rule (§4: cross-org reads come from cron-built
snapshots, console polls). A single dashboard left open on a wall display
re-runs these continuously.

**R4. `systemEvents` can never be cleared.** No ack, no resolve, no dedupe
(`platform/events.ts`, `schema.ts:4248`). The "needs attention" panel accumulates
until the 30-day prune. An operator learns within a week that the red panel means
nothing — which then hides the one event that mattered.

**R5. No pagination or server-side search anywhere.** `orgs.listOrgs` is a
`.collect()`; audit/tickets/invoices are `take(200–300)` with no cursor. Search on
the org directory is client-side over the already-fetched array.

**R6. One error boundary blanks the whole console.** `AccessBoundary`
(`ConsoleShell.tsx:197`) wraps all page content; a single failing panel query
replaces the entire page with the error screen.

**R7. The admin app has no error tracking of its own.** A console that breaks
tells no one.

### 3.3 Workflow depth — what's missing for a non-engineer to finish a job

**W1. Org detail doesn't show prior staff actions on that org.** The index is
built and unused (`schema.ts:4067`). "What have we already done to this account?"
is the first question in any support interaction.

**W2. Audit log: no search, no filter, no export, no archive.** `recentAuditLog`
returns the newest 200, period. Retention is declared as 7 years (plan §6) but
nothing archives it — compare the tenant log, which has a real S3 archive
(`convex/auditLogArchive.ts`).

**W3. The ticket board has no way to receive tickets.**
`platform/tickets.ts:reportProblem` is deliberately non-staff-gated so tenant
clients can call it — and **nothing calls it**. No web, dispatch, or driver entry
point exists. It's also **unrated-limited**, while
`@convex-dev/rate-limiter` is already a dependency in use
(`convex/externalTrackingAuth.ts:18`); any authenticated user can insert rows
without bound.

**W4. No client-errors surface.** The nightly autofix workflow already reads
PostHog error-tracking issues, so the data path is proven; the console just never
got the page. Grouping by release / `ota_update_id` was specifically called out
because a bad driver OTA push is our fastest-moving incident class.

**W5. Jobs board is read-only.** No "run now" (the #1 operator action on a failed
job), no per-job drill-down — `jobs.recentRuns` exists and **has no caller** — no
duration trend, so a job degrading from 2s to 45s is invisible until it fails.

**W6. Health board is missing half of plan §7.5:** no Samsara poll health, no GPS
ingestion latency, no `sync_stall_alert` surfacing, no `loadStatusCounts` verify
mismatches, no per-partner 429 rate.

**W7. Alert matrix is 3 of 6 conditions.** Implemented: cron failures, webhook
dead-letters, FourKites `all_failed`. Missing: billing/usage drift (the systemEvent
is written but never escalates), error-rate spike (Axiom-dependent), and
destructive-staff-action visibility.

**W8. Smaller ops friction:** no org-scoped invoice list on the org page; no
ticket detail/thread; no notification when a ticket arrives; no CSV export
anywhere; step-up failure tells the operator to "sign out and back in" instead of
offering a re-auth button.

### 3.4 Security & compliance

**S1. Staff allowlist is invisible.** No console view of who has access, no
last-seen per actor (the `by_actor` index is also unused). Quarterly access
review (plan §8-4) can't be performed from the console it's supposed to be
recorded in.

**S2. No security headers beyond `X-Robots-Tag`** (`apps/admin/next.config.ts`).
Plan §8-8 asked for strict CSP. Missing: CSP, HSTS, `X-Frame-Options: DENY`,
`Referrer-Policy`, `Permissions-Policy`.

**S3. PII break-glass is half-specified.** `sensitive_data_revealed` is in the
audit union and in the destructive set (`lib/platformAudit.ts:42,52`) but has no
implementation. Today that's *safe* — the console renders no SSN/DOB/licence — but
it means there's no sanctioned path when support genuinely needs a last-4, and an
unused enum invites someone to wire it up without the read-audit.
**Recommendation: keep PII out of the console entirely** and make that an explicit
decision rather than an accident.

**S4. Destructive actions aren't announced.** Plan §9 routes them to Slack for
visibility (not approval). Cheap compensating control for flat access; not built.

**S5. Break-glass procedure is a sentence in a plan doc**, not a runbook with
named holders of Convex dashboard access.

---

## 4. Proposed work, sequenced

Effort is rough dev-days for one person. "Impact" is on incident outcomes, not
looks.

### Ops-0 — Launch gates (~2 days, mostly verification)

Nothing else matters until these are true. None of it is speculative work.

| # | Work | Impact |
| --- | --- | --- |
| 0.1 | Sign in as staff against the real WorkOS project and dump token claims via the existing `access.debugIdentity` query. Confirm `auth_time`. If absent, build the `/step-up` re-auth route + `platformStepUp` record (G1) | Blocker — half the console's mutations |
| 0.2 | Decide Axiom yes/no (G2). If no: heartbeat row + external cron-ping monitor | Blocker — monitoring the monitor |
| 0.3 | Set `SLACK_ALERT_WEBHOOK_URL`; add a **"Console self-check"** panel on Overview showing which integrations are live (Slack ✓/✗, Stripe ✓/✗, staff allowlist size, last evaluator heartbeat, last snapshot rebuild) (G3) | Makes silence visible |
| 0.4 | Configure external checks on `/liveness`, tenant sign-in, admin sign-in (G4) | Blocker — nothing watches from outside |
| 0.5 | `docs/runbooks/` with the five that matter: FourKites `all_failed`, cron failing, webhook dead-letters, billing drift, staff IdP down / break-glass. Link them from alerts by `kind` (G5, S5) | Turns alerts into actions |
| 0.6 | Restore drill on a Convex backup; write RPO/RTO into the runbook (G6) | Compliance + real risk |

**Done when:** a staff member can execute one destructive action end-to-end on
production; killing the evaluator produces an alert from outside our
infrastructure within 15 minutes; every alert kind links to a runbook.

### Ops-1 — Stop the console from lying (~5 days)

| # | Work | Impact |
| --- | --- | --- |
| 1.1 | **Stale-job detection.** Add `expectedIntervalMs` to the `job()` descriptor in `crons.ts`, persist it on `cronHealth`, add an in-flight marker written *before* the target runs, show `stale`/`running` chips on the board, and add a `job_stale` alert condition (`lastStartedAt` older than 3× interval) (R1, R2) | Closes the biggest blind spot |
| 1.2 | **`platformMetricsSnapshot`** — one row, rebuilt every 5 min by cron, carrying SLI/health/revenue rollups. Repoint `slo.sloOverview`, `health.integrationHealth`, `billing.revenueOverview` at it (R3) | Cost becomes O(1) in open tabs; matches the plan's own snapshot rule |
| 1.3 | **`systemEvents` ack + dedupe** — dedupe key, occurrence count, ack/resolve with actor, feed defaults to unacked, bulk-ack older than N days (R4) | The feed becomes trustworthy |
| 1.4 | **Pagination + server-side search** on orgs, audit, tickets, invoices (R5) | Survives volume |
| 1.5 | **Per-panel error boundaries** + retry; keep `AccessBoundary` for auth only (R6) | One bad query stops taking the console down |
| 1.6 | PostHog init in `apps/admin` (server-side key, own project or distinct app tag) (R7) | The console reports its own failures |
| 1.7 | Job duration trend (p95 from `cronRuns`) + `recentRuns` drill-down wired to the UI (W5, partial) | Catch degradation before failure |

**Done when:** stopping a cron in a staging deployment raises an alert within 3
intervals; the SLO/health/billing boards issue one snapshot read each; the
needs-attention feed can be driven to zero.

### Ops-2 — Make it a workflow, not a dashboard (~7 days)

| # | Work | Impact |
| --- | --- | --- |
| 2.1 | **Org timeline** — merge platform-staff actions (`by_target_org`), tenant audit, flag changes, tickets and alerts for that org into one chronological view on org detail (W1) | The support view we don't have |
| 2.2 | **Audit search/filter/export** by actor, org, action, date + CSV; 7-year S3 archive mirroring `auditLogArchive.ts` (W2) | Makes the retention promise real |
| 2.3 | **Report-a-problem in all three clients** — web, dispatch, driver (driver rides `lib/offline-queue.ts` per plan §7.2) — plus a rate limit on `reportProblem` (W3) | The ticket board starts receiving work |
| 2.4 | **Client-errors page** — `apps/admin` server route → PostHog issues, grouped by app / release / `ota_update_id`, deep-linked to session replays (W4) | Bad OTA visible in minutes |
| 2.5 | **Jobs "run now"** (staff-gated, audited, idempotent-by-construction jobs only) (W5) | The action operators actually want |
| 2.6 | **Health board completion** — Samsara poll health, GPS ingest latency, `sync_stall_alert`s, `loadStatusCounts` mismatches, per-partner 429s (W6) | Plan §7.5 delivered |
| 2.7 | **Alert matrix completion** — drift escalation, destructive-action Slack notice, error-rate (if Axiom) (W7, S4) | Matrix matches reality |
| 2.8 | Ticket detail + Slack notice on new ticket; org-scoped invoice list on the org page (W8) | Round out the loops |

**Done when:** a non-engineer resolves a standard account issue start to finish —
find org, read its timeline, take the action, resolve the ticket — without asking
an engineer or opening the Convex dashboard.

### Ops-3 — Hardening, compliance, and proof (~4 days)

| # | Work | Impact |
| --- | --- | --- |
| 3.1 | **Access page** — parsed allowlist, last session per actor (`by_actor`), quarterly-review action recorded as a `systemEvent` (S1) | Access review becomes possible |
| 3.2 | **Security headers** — CSP, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (S2) | Baseline hygiene |
| 3.3 | **PII decision recorded** — recommend: console never renders driver PII; remove the unused `sensitive_data_revealed` path, or implement reveal + read-audit if we decide otherwise (S3) | No half-built break-glass |
| 3.4 | **Playwright smoke in CI** — login redirect, directory renders, destructive action demands step-up + reason (plan §13, never built) | Regression protection on the gate |
| 3.5 | **Status page** — vendor chosen, incident-update runbook, console links to it (G5 cont.) | Customer-facing incident comms |

---

## 5. What I'd cut or defer

Stated so the plan isn't padded:

- **Console RBAC tiers** — no. Flat access + a real audit trail is correct at this
  headcount; tiers create maintenance without reducing risk.
- **PagerDuty / phone paging** — no, until there's a rotation to page. Slack +
  external synthetic checks cover it.
- **Global search / command palette** — nice, not readiness. Revisit after Ops-2.
- **Write-impersonation ("act as org")** — stays out of scope permanently unless
  a concrete support case forces it. The read-only recent-loads slice is enough.
- **Self-hosted metrics/logging stack** — no, unchanged from the original plan.

---

## 6. Decisions I need from you

| # | Decision | My recommendation |
| --- | --- | --- |
| A1 | Axiom on a paid Convex plan, or the external heartbeat-monitor fallback? | Fallback first (free, external, satisfies the dead-man's switch). Add Axiom when log *search* becomes the bottleneck, not before |
| A2 | If `auth_time` is missing from staff tokens: build the `/step-up` route, or drop step-up to "reason + typed confirm only"? | Build the route. Losing step-up on org-delete and global-flag writes is the wrong trade |
| A3 | Does the console ever show driver PII? | No. Record it as policy and delete the unused audit action |
| A4 | Status page: public, or customer-link-only? | Link-only to start; public once there are enough tenants that individual emails don't scale |
| A5 | Is "run now" on crons acceptable given some jobs write money (`platform-invoice-cycle-close`)? | Allow it, but with an explicit deny-list for money-writing jobs; those stay CLI-only |
| A6 | Sequencing: all three tracks in order, or Ops-0 + Ops-1 now and re-scope after? | Ops-0 + Ops-1 now. Ops-2's priorities will look different once the console has been on-call for two weeks |

---

## 7. One-paragraph summary

The console is further along than "rough draft" — all five planned phases are
coded and meaningfully tested, and the security model is the part most teams get
wrong and this one got right. What's missing is the operational layer: it can't
tell you a job silently stopped, its attention feed can't be cleared, its
alerting is inert until an env var nobody has set is set, its step-up path has
never been proven against a real token, and there are no runbooks behind any of
it. Ops-0 and Ops-1 (~7 days) fix everything that would let the console be
confidently wrong. Ops-2 (~7 days) turns it from a set of read-only boards into
something a non-engineer can finish a job in. Ops-3 (~4 days) is the compliance
and hardening tail.
