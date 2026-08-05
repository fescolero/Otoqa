# Platform Admin Console — Review & Build Plan

_Status: proposal (2026-08-05). Covers the internal "provider" console for Otoqa platform
maintainers: logs, bug triage, account support, platform billing, and performance/health._

## 1. Where the codebase stands today

### What already exists that the console can build on

| Area | What exists | Where |
| --- | --- | --- |
| Audit trail | Org-scoped `auditLog` (closed unions for entity/action, before/after diffs, 365-day retention, monthly S3 archive) | `convex/lib/audit.ts`, `convex/auditLog.ts`, `convex/auditLogArchive.ts` |
| Platform billing data | Per-load metering ($2.65/load default), monthly `platformUsageStats`, nightly raise-only recalc, deterministic invoice numbers, per-org billing overview + PDF/CSV | `convex/platformUsage.ts`, `convex/platformUsageHelpers.ts`, `app/(app)/settings/billing/` |
| Integration health | `fourKitesPushTickHealth` (per-org tick outcomes, consecutive-failure counters), `apiAuditLog` (partner API requests + latency, 30-day retention), `webhookDeliveryQueue` (retry + dead-letter) | `convex/schema.ts`, `convex/http.ts`, `convex/externalTrackingWebhooks.ts` |
| Diagnostics | GPS sync-latency percentile analysis, facet diagnostics, pay-engine shadow validation — all `internal*` functions runnable only from the Convex dashboard/CLI | `convex/_devTools/` |
| Dev tooling gate | `OTOQA_ENABLE_DEV_TOOLS` env kill-switch on client-callable diagnostics | `convex/diagnostics.ts`, `convex/manualCleanup.ts`, etc. |
| Feature flags | Per-org flags with a global `'*'` scope overlay; global writes are CLI-only (`setFlagInternal`) | `convex/featureFlags.ts` |
| Error tracking (clients) | PostHog on all three clients: web `capture_exceptions` + error boundaries, driver app dual clients (foreground + headless background) with session replay, dispatch app global error handler. Every mobile event carries OTA context. | `instrumentation-client.ts`, `apps/*/lib/analytics.ts` |
| Error → fix loop | Nightly CI job reads PostHog error-tracking issues + Convex logs and opens fix PRs | `.github/workflows/autofix-nightly.yml` |
| RBAC engine | Single `isPermitted(claims, slug)` chokepoint shared by Convex, Next API routes, and UI; 8 areas × view/edit/manage; WorkOS environment roles | `convex/lib/permissions.ts`, `lib/team-rbac.ts` |

### The gaps the console must fill

1. **No platform-staff identity.** Every auth path derives authority from the caller's own
   org (`requireCallerOrgId`, `assertCallerOwnsOrg` across ~53 files). Nothing in the system
   can answer "is this caller Otoqa staff?" — `admin` is strictly an org-scoped tenant role.
2. **No backend error visibility outside the Convex dashboard.** Convex functions log via
   `console.*` only; there is no queryable event/error store and no log streaming configured.
3. **No cron run ledger.** 29 cron jobs; most handlers have no try/catch, so a failed tick is
   visible only in dashboard logs. No "did last night's settlement generation succeed?" answer.
4. **Billing is metering-only.** No payment processor (Stripe columns are reserved but unused),
   and invoice statuses on the tenant billing page are derived placeholders, not lifecycle state.
5. **Support operations are mostly CLI-shaped.** Fixing an account (Clerk resync, flipping a
   flag, rebaselining usage, identity relinking) means `npx convex run` from an engineer's
   laptop — unaudited and unavailable to non-engineers. (Exception: force-ending a driver
   session already has a tenant-facing UI via `driverSessions.adminEndSession`.)
6. **Soft privilege gaps to close while we're here:** `featureFlags.setFlag` is a public
   mutation with no role check; `forceResync.clearFourKitesLoads` deletes FK loads across *all*
   orgs; `app/(app)/dev/create-form` is ungated; security-review findings 8/9/11/12 remain open.

## 2. Architecture decision

**Same monorepo, same Convex deployment, new isolated surfaces:**

- **Web:** new route group `app/(platform)/admin/*` with its own layout, nav, and shell —
  completely separate from the tenant `(app)` group. The layout does a server-side staff check
  and everything under it renders nothing without it.
- **Backend:** new directory `convex/platform/` (e.g. `orgs.ts`, `billing.ts`, `health.ts`,
  `flags.ts`, `support.ts`, `logs.ts`). **Every** exported function in this namespace begins
  with `requirePlatformStaff(ctx)`. Tenant helpers (`assertCallerOwnsOrg`, etc.) are never
  loosened to admit staff — cross-org access exists only inside `convex/platform/`, so the
  tenant attack surface does not widen.

Why not a separate app/deployment: shared schema/codegen and one deploy keep iteration fast, and
the isolation we need is authorization-level, not infrastructure-level. If stronger separation is
wanted later, the route group can move behind an `admin.otoqa.com` host check in `proxy.ts`
without backend changes.

### Staff identity

- Create a dedicated **"Otoqa Internal" WorkOS organization**; its org ID goes in a
  `PLATFORM_STAFF_ORG_IDS` env var on both Next and Convex.
- Seed two environment roles: `platform_admin` (full) and `platform_support` (read +
  low-risk account fixes; no billing writes, no destructive ops).
- `requirePlatformStaff(ctx, level?)` in `convex/lib/auth.ts`: verifies the JWT's `org_id` is in
  the staff allowlist **and** carries a platform role slug. Critically, the legacy
  "`permissions == null` ⇒ allow" grandfathering in `isPermitted` must **not** apply to
  platform checks — fail closed, always.
- Defense in depth: staff check in the `(platform)` server layout, again in every Convex
  platform function, and (optionally) a host/path check in `proxy.ts`.

### Staff audit log

New `platformAuditLog` table (separate from tenant `auditLog`): actor, action (closed union),
target org/entity, before/after, reason string (required for destructive ops), timestamp. Every
platform **write** logs; the org-detail page shows "staff actions on this org" so support history
is visible. Same S3 archival pattern as `auditLog`.

## 3. Feature pillars

### 3.1 Logs & errors

- **`systemEvents` table + `logSystemEvent(ctx, …)` helper** — structured, queryable backend
  events: `{severity, source, orgId?, code, message, context}`. Integration failures, webhook
  dead-letters, auth anomalies, and cron errors write here. Pruned like `apiAuditLog` (30d),
  with severity-based retention. This becomes the console's live "backend log" feed with
  org/source/severity filters.
- **Convex log streaming** (Axiom or Datadog) for raw `console.*` output and function-level
  execution logs — configuration, not code. `systemEvents` is for curated, actionable events;
  the stream is for forensic depth.
- **Client errors:** an admin "Errors" page that pulls top PostHog error-tracking issues per
  app (web / driver / dispatch) via the PostHog API (the `error_tracking:read` personal key
  already exists for the nightly autofix job), grouped by release/OTA update ID so a bad OTA
  push is visible within minutes.

### 3.2 Bug issues / support tickets

- **`supportTickets` table:** source (`user_report` | `staff` | `automated`), status, severity,
  linked org/user/load, free-form notes, optional GitHub issue URL.
- **In-app "Report a problem"** in both mobile apps and the web app that files a ticket with
  device + OTA + org context automatically attached (the mobile apps already compute all of it
  for PostHog).
- Automated sources: sync-stall alerts, dead-lettered webhooks, and repeated cron failures can
  open tickets so nothing relies on a human watching a dashboard.

### 3.3 Account issues (support operations)

- **Org directory:** searchable list of all organizations with health chips — member count,
  active drivers, loads this cycle, last activity, integration tick health, flag overrides,
  soft-deleted state.
- **Org detail page:** members (WorkOS API) and identity links (Clerk ↔ WorkOS, phone/email
  snapshots), drivers and their session state, billing summary, flags, integration status,
  recent tenant audit log, recent staff actions.
- **Support actions** (each audited, each a thin wrapper over logic that mostly already exists):
  - Force-end a stuck driver session — a staff-scoped variant of the existing public
    `driverSessions.adminEndSession` mutation (which is tenant-facing, already used by the
    web sessions UI, and org-scoped to the caller).
  - Clerk resync / re-provision for a driver or owner (`clerkSync.*` internal actions).
  - Unlink/relink a `userIdentityLinks` row (wrong phone, org move).
  - Acknowledge `sessionEndedWithActiveLoad` rows.
  - Per-org and global feature-flag editor (replaces CLI-only `setFlagInternal`; global writes
    require `platform_admin`).
  - Soft-delete / restore an organization.
- **Impersonation:** start with a read-only "view as org" (staff-scoped queries that render the
  tenant UI's data, watermarked, fully audited). True write impersonation via WorkOS only if a
  real need emerges — it's the riskiest feature in this class.

### 3.4 Platform billing

- **Cross-org revenue dashboard:** MRR/accruals from `platformUsageStats` × per-org rates,
  usage trends, top orgs, cycle-over-cycle deltas. All source data exists today.
- **Contract management:** edit `billingRatePerLoad`, contract number, license start/end,
  billing contacts (all existing `organizations` fields) — audited.
- **Real invoice lifecycle:** new `platformInvoices` table (`draft → issued → sent → paid |
  void`, issue/due/paid dates, line items) generated at cycle close, replacing the derived
  placeholder statuses on the tenant billing page. This is the prerequisite for payments.
- **Stripe (later phase):** customer creation against the reserved `organizations_sensitive`
  columns, invoice push or payment links, webhook → `paid` transitions, dunning. Deliberately
  after the lifecycle table so billing works manually first.
- **Metering tooling:** expose `rebaselineOrgPlatformUsage` and `diagnoseUsageAttribution` as
  staff actions with typed confirmation ("only safe pre-invoicing" guard becomes an actual check
  against `platformInvoices`).

### 3.5 Performance & reliability

- **Cron run ledger:** a `runCronJob(name, handler)` wrapper that records start/end/duration/
  error per tick into `cronRuns`, applied to all 29 jobs. Fixes the "no try/catch" gap once,
  centrally. Console shows a jobs board: last run, duration trend, consecutive failures.
- **Integration health board:** `fourKitesPushTickHealth` across all orgs (alert on
  `all_failed` / rising `consecutiveTransientTicks`), Samsara poll health, webhook queue depth +
  dead-letter count, partner API p95 latency and 429 rates from `apiAuditLog`.
- **GPS/sync health:** promote `_devTools/syncLatencyDiag` into staff queries — ping-latency
  percentiles per org/driver, offline-queue stall signals (driver app already emits
  `sync_stall_alert`).
- **Data integrity:** surface `load-status-counts-verify` mismatch counts and
  `loadStatusCountsMeta` instead of burying them in logs.
- **Platform alerting:** small evaluator cron (mirroring the existing tenant `dispatchAlerts`
  pattern) that checks thresholds — cron failed N consecutive ticks, dead letters > X, tick
  health `all_failed`, error-rate spike — and notifies Slack/email. Dashboards are for diagnosis;
  alerts are for detection.

## 4. Hardening to ride along (mostly small, high-value)

1. `featureFlags.setFlag`: require `settings:edit` (tenant) — and global scope only via the new
   platform console.
2. `forceResync.clearFourKitesLoads`: scope deletion to the caller's org (today it deletes
   FK loads across all orgs).
3. Gate or delete `app/(app)/dev/create-form` (its own docstring asks for this).
4. Remove the dead `/operations/compliance` nav link.
5. Re-visit open security-review items: SSRF blocklist gaps (finding 8), honest handling of the
   unenforceable IP allowlist (9), PII in logs (11), HTTP param validation (12).

## 5. Phasing

| Phase | Scope | Outcome |
| --- | --- | --- |
| **0 — Foundation** | Staff org + roles, `requirePlatformStaff`, `(platform)` shell + nav, `platformAuditLog`, hardening items 1–4 | Staff can log in to an empty, safe console; nothing else changed |
| **1 — Visibility** | Org directory + org detail (read-only), cross-org billing dashboard, cron run ledger + jobs board, integration health board, `systemEvents` + errors page (PostHog API) | "What is happening?" answerable without the Convex dashboard |
| **2 — Operations** | Support actions (sessions, Clerk resync, identity links, flags UI, usage rebaseline), `supportTickets` + in-app report-a-problem, platform alerting to Slack | Support stops requiring an engineer with CLI access |
| **3 — Billing maturity** | `platformInvoices` lifecycle, invoice generation at cycle close, then Stripe + dunning | Real receivables instead of derived placeholders |
| **4 — Advanced** | Read-only view-as-org, SLO dashboards, anomaly detection on usage/error rates | Proactive quality management |

## 6. Testing & guardrails

- Every `convex/platform/*` function gets `convex-test` coverage for: staff allowed,
  tenant-admin rejected, unauthenticated rejected, legacy-claims (no `permissions` array)
  rejected — mirroring the fail-closed patterns already proven in `platformUsage.test.ts` and
  `featureFlags.test.ts`.
- Destructive staff actions require a typed confirmation in the UI **and** a `reason` argument
  persisted to `platformAuditLog`.
- CI: the existing lint/typecheck/test matrix covers the new code automatically; add the
  platform route group to the web typecheck path (it already is, being in-repo).
