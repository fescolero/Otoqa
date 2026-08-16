# Platform Console — Operations-Readiness Plan

_Status: reviewed and partially executed. Written 2026-08-16 against commit `7931a9e`._
_**Implementation progress is tracked in §10** — the audit in §1–§5 describes the
state BEFORE this work and is kept as written so the reasoning stays legible._
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

## 4. Action coverage: what you can see vs. what you can do

This is the larger gap, and it cuts across every surface. The console has **21
exported mutations/actions total**. Everything else is a read. The result is a
recurring pattern: a board tells you something is wrong, and the fix is still a
CLI command or a Convex dashboard edit — which is exactly what the console was
built to eliminate.

| Surface | You can see | You can do | Missing actions that ops will hit |
| --- | --- | --- | --- |
| **Billing** | invoices, aging, revenue, usage | issue, mark sent, record payment, void, adjust drafts, next-cycle rate, push to Stripe | edit/reverse a payment; carry credit; back-date a rate; one-off invoices; write-off; refund; resend; edit due date — see §5 |
| **Orgs** | directory, detail, snapshot, members, flags, usage, audit, recent loads | soft-delete, restore, set flags | **suspend for non-payment**; read-only mode; extend/edit license window; edit billing contact & contract number; rename; change org type; create an org |
| **Members** | synced list (name, email) | *nothing* | invite; remove; change role; reset password; reset MFA; unlock; force sign-out; resend invite. The tenant app already has these as `/api/team/*` — the console has none of them |
| **Drivers** | list, phone, Clerk link status | Clerk resync | fix the phone **on the driver row** (only `userIdentityLinks.phone` is editable — the driver record isn't, and phone mismatch is the top driver-app support ticket); deactivate; clear a stuck sync |
| **Sessions** | active sessions, unacked end-alerts | force-end, ack | extend; reassign a leg; clear stuck geofence/leg state |
| **Integrations** | FourKites tick health only | *nothing* | test a connection; rotate credentials; re-run a sync; disable push for one org; **no Samsara surface at all** |
| **Webhooks** | pending / dead-letter counts | *nothing* | **requeue a dead-letter** — no requeue mutation exists anywhere in the codebase, only a prune cron. The alert fires at >10 and the only remedy is the CLI |
| **Jobs** | last outcome, duration, failure counts | *nothing* | run now; pause; drill into history (`recentRuns` exists, no caller) |
| **Alerts** | open/acked/resolved | ack | resolve by hand; snooze/mute; add a note; assign |
| **Tickets** | list, filter | create, status, severity, assign, resolution note | reply to reporter; merge/dedupe; delete; attachments; notify on arrival |
| **Flags** | global + per-org, string values | set/remove | typed (bool/number) values; percentage rollout; scheduled expiry; apply to a segment; see which orgs a flag actually affects |
| **Staff access** | your own email | *nothing* | view the allowlist; see last-seen per actor; record an access review |

**The design rule for all of it:** every new write goes through the same three
gates that already exist and work — `requirePlatformStaff` (or
`requireRecentStaffAuth` when destructive), a required `reason`, and a
`platformAuditLog` entry inside the same transaction — plus idempotency keyed on
target state. That contract is the reason adding actions here is safe; it should
not be relaxed for convenience on any of them.

## 5. Billing: from a report into a ledger you can operate

Billing deserves its own treatment because the gaps aren't cosmetic — the
**documented correction workflow is not implemented**, so today there is
genuinely no supported way to fix a wrong number.

### What's actually broken

1. **Payments are append-only with no correction path.** `recordPayment`
   (`platform/invoices.ts:360`) only appends. No edit, no delete, no reversal. A
   staff typo ($5,000 for $500) permanently marks the invoice paid, and the only
   remedy is a Convex dashboard edit — unaudited, exactly what the console exists
   to prevent. No handling for a bounced check or an ACH return either.
2. **Overpayment disappears.** When `amountPaid >= total` the invoice flips to
   paid; the excess sits in `amountPaid` and is never surfaced or carried. The
   schema has **no credit concept at all** (verified: zero credit fields).
3. **Underpayment has no state.** A short-pay leaves the invoice `issued`/`sent`
   with a silent balance. No `partially_paid` status, no short-pay reason, no
   write-off, no bad-debt path, no payment-plan note.
4. **The carry-forward the code tells you to use doesn't exist.**
   `addAdjustment` rejects non-drafts with "post-issue corrections ride the NEXT
   cycle (spec §4)" — but nothing carries anything forward. `cycleClose` never
   looks for pending credits. The error message points at a mechanism that was
   never built.
5. **Rates only move forward.** `updateBillingConfig` accepts
   `ratePerLoadNextCycle` and nothing else. You cannot back-date a rate (the
   build plan §7.4 explicitly permitted "backdated with reason"), cannot correct
   the base `billingRatePerLoad`, cannot remove or edit a wrong schedule step,
   and the schedule isn't visible in the UI at all. A contract signed mid-month
   at a new rate cannot be honored for the current cycle.
6. **No one-off invoices.** Implementation fees, onboarding, professional
   services, hardware — nothing outside metered usage can be billed. Invoices
   exist only via `cycleClose`.
7. **Contract fields are display-only.** `billingEmail`, `billingContactName`,
   `billingPhone`, `platformContractNumber`, `platformLicenseStart/End` render on
   org detail with no mutation behind them. The license window enforces nothing.
8. **The manual (non-Stripe) path has no delivery.** `markSent` is an
   honor-system status flip — no email, no PDF, no hosted link (only the Stripe
   path produces one), no resend, no due-date edit, no reminders.

### The design answer

Don't make money fields editable. **Make them append-only with corrective
entries** — standard double-entry practice, and it preserves the immutability
rule the ledger was built on:

- **Payment ledger with reversals.** Keep `payments` append-only; add a
  `reversePayment` mutation that appends a negative entry referencing the
  original, with reason + audit. Recompute `amountPaid` and status from the sum.
  Nothing is ever edited or deleted; the trail shows the mistake *and* the fix,
  which is what an auditor and a customer dispute both need.
- **An org credit ledger.** New `platformCredits` table:
  `{workosOrgId, amount, source: overpayment|goodwill|dispute|service_credit|manual,
  reason, createdByEmail, invoiceRef?, consumedByInvoiceId?, createdAt}`.
  Overpayment auto-posts a credit; `cycleClose` consumes available credit as a
  negative line on the next invoice; the org page shows the balance and its
  history. This is the missing carry-forward, and it makes the existing
  "corrections ride the next cycle" message true.
- **Payment states that match reality.** Add `partially_paid` and `written_off`
  to the status union, with `writeOff(reason)` as a distinct audited action so
  bad debt is a decision on the record rather than an invoice that quietly sits
  open forever.
- **Rate changes with an effective date, not just "next".** Replace
  `ratePerLoadNextCycle` with `effectiveFromPeriod` + rate, allowing a past
  period **only** when no committed invoice covers it (reuse
  `orgHasCommittedInvoices`, already written); if one does, refuse and direct the
  operator to a credit instead. Add step edit/delete and show the schedule.
- **Manual invoices.** `createManualInvoice(orgId, periodKey, lines[], reason)`
  producing a draft in the same ledger, same lifecycle, flagged `manual: true`
  so metered and non-metered revenue stay distinguishable.
- **Contract editing** for billing contact, contract number and license window,
  audited like everything else — plus a decision on whether an expired license
  actually does anything (today: nothing).
- **Delivery on the manual path:** render the invoice PDF (the repo already has
  `@react-pdf/renderer` in use for tenant invoices), email it to `billingEmail`,
  record `sentAt` + recipient, and support resend.

Two invariants worth stating explicitly in code review: the metered number
(`loadsWritten`) is **never** editable by anyone, and an issued invoice's frozen
lines are **never** rewritten — every correction is a new entry. Those hold in
the current design and must survive all of the above.

## 6. Proposed work, sequenced

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

### Ops-B — Billing operability (~6 days) — §5 in full

Independent of Ops-1/2; can run in parallel since it touches only
`platform/invoices.ts`, the schema, and the billing board.

| # | Work | Impact |
| --- | --- | --- |
| B.1 | `reversePayment` (append-only negative entry, reason + audit); recompute `amountPaid`/status from the sum; bounced-check / ACH-return as a reversal reason | Fixes the "we can't correct what we received" hole |
| B.2 | `platformCredits` ledger + auto-post on overpayment + consumption as a negative line in `cycleClose` + balance and history on the org page | Makes carry-forward real; the code already tells operators it exists |
| B.3 | `partially_paid` + `written_off` statuses; `writeOff(reason)` action; short-pay reason on payments | Under-payment stops being an invisible open balance |
| B.4 | Effective-dated rate changes (past periods allowed only when no committed invoice covers them, via the existing `orgHasCommittedInvoices`); schedule step edit/delete; schedule visible in the UI | Mid-cycle contracts can be honored |
| B.5 | `createManualInvoice` — one-off fees, onboarding, services, hardware; `manual: true` flag | Non-metered revenue becomes billable |
| B.6 | Contract editing: billing contact/email/phone, contract number, license window — audited; decide whether license expiry enforces anything | Stops the Convex dashboard being the only editor |
| B.7 | Manual-path delivery: invoice PDF (reuse `@react-pdf/renderer`), email to `billingEmail`, `sentAt` + recipient recorded, resend, due-date edit | `markSent` stops being an honor system |

**Done when:** a mis-keyed payment, an overpayment carried to next month, a
short-pay written off, and a back-dated contract rate can each be handled
end-to-end in the console, with the full trail (mistake *and* correction) visible
on the invoice.

### Ops-A — Account actions (~5 days) — the rest of §4

| # | Work | Impact |
| --- | --- | --- |
| A.1 | **Requeue dead-lettered webhooks** (single + bulk, audited). Currently alerted-on with no remedy anywhere in the codebase | Closes an alert that has no action |
| A.2 | **Member management** — invite, remove, change role, reset password, reset MFA, force sign-out. The tenant `/api/team/*` routes already do this; wrap them staff-side | The most common support request we can't serve |
| A.3 | **Org lifecycle** — suspend for non-payment, read-only mode, license extension, rename; keep soft-delete as the heavy option | Suspension is a business lever we don't have |
| A.4 | **Driver record fixes** — phone on the `drivers` row (not just the identity link), deactivate, clear stuck sync | Top driver-app ticket class |
| A.5 | **Integration panel** — test connection, rotate credentials, re-run sync, disable push per org; add a Samsara surface | Alerts on FourKites/Samsara become actionable |
| A.6 | **Alert workflow** — manual resolve, snooze/mute, note, assign | Ack-only isn't a workflow |
| A.7 | **Flags v2** — typed values, percentage rollout, scheduled expiry, affected-org preview | Safer use of the most powerful lever |

### Ops-3 — Hardening, compliance, and proof (~4 days)

| # | Work | Impact |
| --- | --- | --- |
| 3.1 | **Access page** — parsed allowlist, last session per actor (`by_actor`), quarterly-review action recorded as a `systemEvent` (S1) | Access review becomes possible |
| 3.2 | **Security headers** — CSP, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (S2) | Baseline hygiene |
| 3.3 | **PII decision recorded** — recommend: console never renders driver PII; remove the unused `sensitive_data_revealed` path, or implement reveal + read-audit if we decide otherwise (S3) | No half-built break-glass |
| 3.4 | **Playwright smoke in CI** — login redirect, directory renders, destructive action demands step-up + reason (plan §13, never built) | Regression protection on the gate |
| 3.5 | **Status page** — vendor chosen, incident-update runbook, console links to it (G5 cont.) | Customer-facing incident comms |

---

## 7. What I'd cut or defer

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

## 8. Decisions I need from you

| # | Decision | My recommendation |
| --- | --- | --- |
| A1 | Axiom on a paid Convex plan, or the external heartbeat-monitor fallback? | Fallback first (free, external, satisfies the dead-man's switch). Add Axiom when log *search* becomes the bottleneck, not before |
| A2 | If `auth_time` is missing from staff tokens: build the `/step-up` route, or drop step-up to "reason + typed confirm only"? | Build the route. Losing step-up on org-delete and global-flag writes is the wrong trade |
| A3 | Does the console ever show driver PII? | No. Record it as policy and delete the unused audit action |
| A4 | Status page: public, or customer-link-only? | Link-only to start; public once there are enough tenants that individual emails don't scale |
| A5 | Is "run now" on crons acceptable given some jobs write money (`platform-invoice-cycle-close`)? | Allow it, but with an explicit deny-list for money-writing jobs; those stay CLI-only |
| A6 | Sequencing: everything in order, or Ops-0 + Ops-1 now and re-scope after? | Ops-0 + Ops-1 first, with **Ops-B running in parallel** — billing corrections are blocked on a real workflow today, and that track touches different files so it won't collide |
| A7 | Payment corrections: reversal entries (append-only, both the error and the fix visible) or editable payment rows? | Reversals. Editable money history is the thing auditors and disputes punish, and it breaks the ledger's immutability rule |
| A8 | Overpayment default: auto-post a credit for next cycle, or refund? | Auto-credit, with refund as an explicit second action. Credits are cheaper and reversible; refunds need a payment rail |
| A9 | Back-dated rate changes: allowed when no committed invoice covers the period, or never? | Allowed with reason + audit under that guard. Refusing outright forces manual credits for every mid-month contract signing |
| A10 | Does an expired `platformLicenseEnd` do anything (block access, alert, nothing)? | Alert + a console badge to start; blocking access is a business decision, not a default |
| A11 | Member management (invite/remove/reset MFA) from the console — in scope, or stays tenant-side? | In scope. It's the most common support request, and doing it tenant-side means asking the customer to fix their own lockout |

---

## 9. Implementation progress

_Updated 2026-08-16. Everything below is merged on `claude/platform-admin-ops-ready-k31m94`._

### Shipped

**Billing operability (Ops-B) — §5 in full except delivery**

| # | Item | Where |
| --- | --- | --- |
| B.1 | `reversePayment` — append-only negative entry, status recomputed from the ledger sum, idempotent, step-up + reason | `platform/invoices.ts` |
| B.2 | `platformCredits` ledger — overpayment auto-posts, consumed at issue as a `credit` payment, FIFO, splits across invoices, released when an invoice is voided | `platform/credits.ts` |
| B.3 | `partially_paid` + `written_off` statuses, `writeOffInvoice`, aging excludes written-off and clamps overpaid balances | `platform/invoices.ts` |
| B.4 | `setRateStep` / `removeRateStep` with back-dating guarded by `committedPeriodsFrom` | `platform/invoices.ts` |
| B.5 | `createManualInvoice` + the `kind` discriminator, with every `by_org_period` lookup routed through `meteredInvoiceForPeriod` | `platform/invoices.ts`, `platformUsage.ts` |
| B.6 | `updateContract` — billing contact, contract number, license window | `platform/invoices.ts` |
| — | Console UI for all of the above | `InvoicesBoard.tsx`, `OrgSupportPanels.tsx` |

**Reliability (Ops-1 subset)**

| # | Item | Where |
| --- | --- | --- |
| 1.1 | Stale/hung job detection: declared cadence on all 35 jobs, in-flight marker written before the target runs, `jobState()` shared by board and evaluator, `cron_stale`/`cron_hung` alerts, `retireJob` | `crons.ts`, `cronRunner.ts`, `jobHealth.ts`, `alerts.ts` |
| 1.3 | `systemEvents` dedupe + ack, with recurrence-after-ack resurfacing; bulk ack that never touches `critical` | `lib/systemEvents.ts`, `platform/events.ts` |
| 1.5 | `PanelBoundary` — one failing panel no longer blanks the console | `apps/admin/components/PanelBoundary.tsx` |
| 1.7 | Job duration p50/p95 + run history drill-down (`jobTrend`, and `recentRuns` finally has a caller) | `platform/jobs.ts`, `app/jobs/page.tsx` |

**Actions & operability (Ops-A / Ops-2 subset)**

| # | Item | Where |
| --- | --- | --- |
| A.1 | `requeueDeadLetters` + the Health-page UI — the dead-letter alert finally has a remedy | `platform/support.ts`, `app/health/page.tsx` |
| A.4 | `correctDriverPhone` on the driver row (distinct from the identity link) | `platform/support.ts` |
| A.6 | Alert `resolve` / `snooze` / `annotate`, snooze-aware evaluator so a manual resolve can't re-page every 5 minutes | `platform/alerts.ts` |
| 2.1 | Staff-actions-on-this-org panel — the `by_target_org` index has a reader | `platform/access.ts`, org detail page |
| 2.2 | Audit search/filter by org, actor, action, free text; `auditActors` rollup | `platform/access.ts` |
| 2.7 | Billing-drift escalation into the alert matrix | `platform/alerts.ts` |
| 0.3 | `consoleSelfCheck` + Overview panel: reports which integrations are unconfigured, never their values | `platform/selfCheck.ts`, `app/page.tsx` |
| 0.5 | `docs/runbooks/` — one per alert kind plus break-glass; every alert links to its runbook by `kind` | `docs/runbooks/` |
| 3.2 | Security headers: CSP (Convex ws + WorkOS allowed), HSTS, frame-deny, nosniff, no-referrer, permissions-policy | `apps/admin/next.config.ts` |

**Tests:** 38 new cases in `convex/platform/phase5.test.ts`, biased toward edge
cases rather than happy paths — double reversal, reversing a spent overpayment
credit, credit larger than the invoice, void returning credit, re-pricing a
billed period, manual/metered coexistence (including that the tenant page still
reads the metered row), staleness thresholds, requeue idempotency, dead
subscriptions, event ack resurfacing, and secret non-leakage. Two existing
assertions were updated where behaviour deliberately changed. **969 tests pass
repo-wide.**

### Deliberately not done, and why

| Item | Why it's still open |
| --- | --- |
| **0.1 step-up verification** | Needs a real WorkOS staff token — cannot be checked from here. Still the highest-risk unknown: if `auth_time` is absent, every destructive action (including all the new ones) fails closed. Use `access.debugIdentity` on the deployed console. |
| **0.2 / 0.4 / 0.6** Axiom, synthetic checks, restore drill | Configuration and vendor decisions (A1), not code. |
| **1.2 metrics snapshot** | The largest remaining code item. It's a refactor of three live queries onto a cron-built row; worth doing after the current changes settle, since it touches the same files. |
| **1.4 pagination** | Audit search landed; cursor pagination for orgs/tickets/invoices did not. Not yet load-bearing at current volume. |
| **1.6 console error tracking** | Needs a PostHog project decision for the admin app. |
| **2.3 report-a-problem clients** | Touches all three client apps; a separate change with its own review surface. The rate limit on `reportProblem` should land with it. |
| **2.4 client-errors page** | Needs the PostHog server-side key in the admin Vercel project. |
| **2.5 jobs "run now"** | Blocked on decision A5 (deny-list for money-writing jobs). |
| **2.6 health board completion** | Samsara/GPS/sync-stall surfaces — additive, no blockers. |
| **A.2 member management** | Needs WorkOS API calls server-side; the largest single remaining action gap and worth its own change. |
| **A.3 org suspend** | Blocked on a product decision: a suspend that doesn't enforce anything is theatre, and enforcement changes tenant behaviour (explicitly a non-goal of the original plan). |
| **B.7 invoice delivery** | PDF + email on the manual path. `markSent` is still an honour-system flip. |
| **3.3 PII decision** | Left untouched on purpose: `sensitive_data_revealed` is still an unused enum member because removing it is decision A3, not mine to make. The console still renders no driver PII either way. |
| **3.1 access page / 3.4 Playwright / 3.5 status page** | Unblocked, not yet started. `auditActors` is the first half of 3.1. |

### Notes for review

- **Money is never edited.** Reversals and credits are append-only; `amountPaid`
  is always recomputed as the sum of the ledger. `loadsWritten` and issued
  invoice lines remain untouchable by any code path added here.
- **Two schema invariants changed.** `by_org_period` is no longer unique (manual
  invoices), and `systemEvents` rows are now mutable (dedupe bumps
  `lastSeenAt`/`occurrences`). Both are handled at every call site, but they're
  the things most likely to surprise someone reading the old code.
- **One deliberate behaviour change on the tenant side:** the billing overview
  now filters to metered invoices so a one-off charge can't shadow a cycle. A
  consequence is that one-off invoices are currently invisible to tenants —
  acceptable while they're staff-raised and separately communicated, but it
  needs a tenant surface before one-offs become routine.

## 10. One-paragraph summary

The console is further along than "rough draft" — all five planned phases are
coded and meaningfully tested, and the security model is the part most teams get
wrong and this one got right. Two things separate it from operations-ready.
**First, it can be confidently wrong:** a job that stops firing stays green, the
attention feed can't be cleared, alerting is inert until an env var nobody has
set is set, and step-up auth has never been proven against a real token. **Second
— the bigger one — it can see but mostly can't act:** 21 mutations total, so most
boards end with "now go run a CLI command." Billing is the sharpest case, where
the code literally tells operators to use a carry-forward mechanism that was
never built, and a mis-keyed payment can only be fixed from the Convex dashboard.
Ops-0 + Ops-1 (~7 days) stop the console from lying; Ops-B (~6 days, parallel)
turns billing from a report into a ledger you can operate; Ops-A (~5 days) and
Ops-2 (~7 days) close the remaining action gaps; Ops-3 (~4 days) is the
compliance and hardening tail.
