# Otoqa Platform Console — Definitive Plan (v2)

_Status: agreed direction, pre-implementation record. Last updated 2026-08-06._
_Scope: the internal "provider" console for Otoqa platform maintainers — logs, error/bug
triage, account support, platform billing, and performance/health._

Everything in §3 was verified directly against source (file:line cited). Anything we could
NOT verify from the repo is listed in §14 **Open decisions & verify-before-build** — nothing
in this plan silently assumes those answers.

---

## 1. Purpose, goals, non-goals

**Goals**
- Answer "what is happening on the platform right now?" without the Convex dashboard or CLI.
- Let support operations (account fixes, flag changes, billing corrections) happen through an
  audited UI instead of `npx convex run` from an engineer's laptop.
- Make platform billing real: frozen invoices, adjustments, and eventually payments.
- Detect problems before customers report them (alerting, health boards, error feeds).

**Non-goals (explicitly out of scope)**
- No changes to tenant-facing features, tenant RBAC, or the tenant login experience.
- No write-impersonation of tenant users (read-only "view as org" is Phase 4, gated on need).
- No self-hosted log/metrics infrastructure (no ClickHouse/Grafana stack to operate).
- Not a general BI tool — product analytics stays in PostHog.

## 2. Glossary (naming collision warning)

| Term | Meaning |
| --- | --- |
| **Platform staff / operator** | Otoqa employees using this console. Authenticated by the *staff issuer* only. |
| **Tenant staff** | A customer org's employees. NOTE: the dispatch mobile app already uses the word "staff" for these users (`apps/dispatch/app/(auth)/staff.tsx`, tenant WorkOS SSO). Console code and docs must always say **platform staff** to avoid this collision. |
| **Tenant** | A customer organization (`organizations` table row). |
| **Staff issuer** | The dedicated identity provider for the console (§5). Distinct from tenant WorkOS and Clerk issuers. |

## 3. Verified current state (evidence base)

### What exists to build on
- **Tenant audit trail**: `auditLog` with closed unions, before/after, 365-day retention
  (`convex/auditLogArchive.ts:47`), monthly S3 archive.
- **Platform billing data**: per-load metering, `DEFAULT_BILLING_RATE_PER_LOAD = 2.65`
  (`convex/platformUsageHelpers.ts:26`), metering cutover Jul 1 2026 (`:39`), per-org rate
  override (`convex/platformUsage.ts:360`), monthly `platformUsageStats`, nightly raise-only
  recalc, deterministic invoice numbers.
- **Health tables**: `fourKitesPushTickHealth` (`convex/schema.ts:1359`), `apiAuditLog`
  (`:3358`, 30-day prune at `convex/externalTrackingAuth.ts:200`), `webhookDeliveryQueue`
  with dead-letter handling.
- **Snapshot pattern proven 3×**: `organizationStats`, `fourKitesPushTickHealth`,
  `loadStatusCounts` — cron-built rollups instead of live scans.
- **Alert dedupe pattern proven**: `dispatchAlerts` `by_dedupe` index — one OPEN alert per
  key, push per incident not per tick (`convex/dispatchAlerts.ts:14`).
- **Client error tracking**: PostHog on all three clients (web `capture_exceptions:true` at
  `instrumentation-client.ts:11`; driver app dual clients + session replay; dispatch global
  handler). No Sentry anywhere. Nightly autofix CI reads PostHog issues.
- **Multi-provider Convex auth**: `convex/auth.config.ts` already registers 2 WorkOS
  customJwt providers + conditional Clerk — adding a staff issuer is an established pattern.

### Confirmed gaps / defects the plan addresses
- **No platform-staff concept anywhere** (repo-wide search: one unrelated comment).
- **Legacy grandfathering**: `convex/lib/permissions.ts:37` — token with no permissions claim
  passes every tenant check. Platform checks must be a separate fail-closed path.
- **29 cron jobs**, most with zero try/catch (verified: `settlementsCron.ts`,
  `autoAssignmentCron.ts`, `recurringLoadsCron.ts`, `fourKitesScheduledSync.ts` each have 0).
- **Billing history mutability**: `getBillingOverview` recomputes closed cycles from the
  *current* rate (`convex/platformUsage.ts:360,408-425`); statuses are documented
  "DERIVED PLACEHOLDERS" (`:345`). No payment processor; Stripe columns unused
  (`convex/schema.ts:243-244`).
- **`featureFlags.setFlag`** (`convex/featureFlags.ts:120`): public mutation, org check only,
  no role check. No client code calls it (verified) — safe to tighten.
- **`forceResync.clearFourKitesLoads`** (`convex/forceResync.ts:18-30`): collects the entire
  `loadInformation` table and deletes all `FK-` loads across ALL orgs (env-gated).
- **Sensitive PII at rest**: drivers table stores `ssn`, `licenseNumber`, `dateOfBirth`
  (`convex/schema.ts:762-764`) → console must treat PII display as a controlled action (§8).
- **Dead nav link** `/operations/compliance` (`components/web/shell/nav.ts:61`, no route).
- **Ungated dev page** `app/(app)/dev/create-form` (login-protected but role-ungated; its own
  docstring says delete or gate).
- **`/v1/health` is authenticated** (`convex/http.ts`) — there is no public liveness probe
  anywhere, and no external uptime monitoring configured in-repo.
- **CI** (`.github/workflows/ci.yml`) has no `apps/admin` entry yet — must be added with the
  app.

## 4. Architecture (final)

**One repo, one Convex deployment, two Vercel projects, separate staff issuer.**

| Piece | Decision |
| --- | --- |
| Console app | New workspace app `apps/admin` (Next.js), deployed as a **second Vercel project** (Root Directory `apps/admin`) at `admin.otoqa.com`. Own env vars, own domain, own failure/rollback domain. `noindex` + robots disallow. Ignored-build-step so each project only rebuilds on relevant path changes. |
| Backend | Same Convex deployment. New `convex/platform/` namespace (`orgs.ts`, `billing.ts`, `health.ts`, `flags.ts`, `support.ts`, `logs.ts`). Every exported function begins with `requirePlatformStaff(ctx)`. Tenant helpers are never loosened. |
| Staff auth | Dedicated staff issuer (§5) added as an additional `customJwt` provider in `convex/auth.config.ts`. Authorization = **issuer check + email allowlist**, not roles. |
| Logs | **Convex log streaming → Axiom** (config, not code) for raw logs, search, retention, and log-based monitors → Slack. Convex keeps only curated operational state. ⚠ Plan-gating: see §14-V1. |
| Cross-org reads | Cron-built snapshot tables ONLY (never live cross-org scans) — the established in-repo pattern. Console polls (15–30s); no tenant-grade reactivity needed. |
| Client errors | PostHog API consumed via an `apps/admin` server route (key server-side only). Convenience view — Axiom + `systemEvents` are the primary incident surfaces. |

**Rejected alternatives (recorded so we don't relitigate):**
- *Same-app route group + staff WorkOS org*: rejected — shared environment roles create a
  tenant→platform escalation surface; `membership[0]` (layout picks first membership,
  `app/(app)/layout.tsx:20`) breaks for mixed-membership accounts; env allowlists drift.
- *Host-routing both sites in one Vercel project*: rejected — re-couples deploys, sessions,
  secrets, failure domains.
- *Separate backend/database for the console*: rejected — the data of record lives in Convex;
  syncing it out adds an ETL surface with no benefit at this scale. Logs are the exception
  and go to Axiom.
- *Convex deploy-key/server-only access*: rejected as primary path — relies on semi-official
  admin APIs and loses typed client ergonomics; issuer-checked public functions are supported
  and fail closed.

## 5. Identity & access specification

**Provider (recommended): a separate WorkOS project used only for platform staff.**
- AuthKit login with **Google OAuth (social login)** restricted by allowlist — NOT an
  enterprise Google Workspace SSO *connection*. Rationale: AuthKit + social OAuth sits in
  WorkOS's free tier; enterprise SSO connections are per-connection paid. ⚠ Verify current
  pricing at setup (§14-V2). MFA comes from enforcing 2-step verification in Google Workspace.
- Fallback option (no WorkOS at all): Auth.js + Google OAuth + a small `jose` route minting
  short-lived Convex JWTs with a self-hosted JWKS. More code we own; choose only if we want
  zero WorkOS in the staff path.

**Token contract** (staff JWT template): `iss` = staff issuer, `aud` = staff client id,
`email`, `sub`, short TTL (≤15 min access token).

**`requirePlatformStaff(ctx)`** (in `convex/lib/auth.ts`):
1. `ctx.auth.getUserIdentity()` — reject null.
2. Reject unless `identity.issuer === STAFF_ISSUER` (Convex env var — single source of truth;
   tenant WorkOS and Clerk issuers fail here by construction).
3. Reject unless `identity.email` ∈ `STAFF_EMAIL_ALLOWLIST` (Convex env var, exact emails —
   not a domain match, to defeat lookalike domains) and `identity.email_verified`.
4. Never consult `isPermitted` / tenant claims. No grandfathering. Fail closed on any
   missing claim.

**Access model**: flat — platform staff have full console access. No console role system at
current team size; revisit when headcount makes least-privilege tiers meaningful. The audit
log (§6) is the compensating control.

**Session/step-up rules** (industry standard for consoles):
- Access token TTL ≤15 min; console session max age 12h; re-login daily.
- **Step-up confirmation for destructive/PII actions** ("sudo mode"): re-prompt IdP auth if
  the last authentication is older than 15 minutes before executing a destructive action or
  revealing sensitive PII.
- Offboarding = disable the Google account and remove from `STAFF_EMAIL_ALLOWLIST` (two
  independent kills). Quarterly access review of the allowlist (calendar item, recorded in
  the console itself as a `systemEvents` entry).
- Break-glass: if the staff IdP is down, the Convex dashboard remains the manual fallback
  (already the status quo); document this in the runbook rather than building a bypass.

## 6. Data model additions (Convex)

Sketches — final validators at implementation time; all tables indexed org-leading where
applicable, all with explicit retention.

- **`platformAuditLog`** — every platform-staff **write** + sensitive **read** (§8):
  `{actorEmail, action (closed union), targetOrgId?, targetTable?, targetId?, before?,
  after?, reason?, stepUpVerified: boolean, ip?, userAgent?, timestamp}`.
  Retention: **7 years** (billing/compliance-grade; longer than tenant audit's 365d), same
  S3 archive pattern as `auditLogArchive`. `reason` required for destructive actions.
- **`systemEvents`** — curated actionable events:
  `{severity: info|warn|error|critical, source, orgId?, code, message, context?, createdAt}`.
  30-day prune (match `apiAuditLog`); never written unconditionally in 10s/1min paths
  (failure-only or sampled there).
- **`cronHealth`** — ONE row per job, upserted every tick:
  `{jobName, lastStartedAt, lastFinishedAt, lastDurationMs, lastOutcome: ok|error,
  lastError?, consecutiveFailures, ticksToday}`. (Same shape philosophy as
  `fourKitesPushTickHealth`.)
- **`cronRuns`** — append-only history, ONLY for ≤hourly jobs and for failures of any job.
  30-day prune.
- **`orgHealthSnapshots`** — one row per org, rebuilt by cron (~15 min):
  `{orgId, memberCount, activeDrivers, activeSessions, loadsThisCycle, lastActivityAt,
  integrationStatus, openAlerts, flagsOverridden, updatedAt}`. Console org directory reads
  ONLY this.
- **`platformInvoices`** — `{orgId, periodKey, invoiceNumber (keep existing deterministic
  scheme so history never renumbers), loadsWritten, ratePerLoadSnapshot, amountSnapshot,
  adjustments: [{label, amountDelta, reason, addedBy, addedAt}], status: draft|issued|sent|
  paid|void, issuedAt?, dueAt?, paidAt?, voidReason?}`. Closed cycles render from the
  invoice, never recomputed.
- **`platformAlerts`** — `{dedupeKey, kind, severity, orgId?, status: open|acked|resolved,
  firstSeenAt, lastSeenAt, count, acknowledgedBy?}` with a `by_dedupe` index (mirror
  `dispatchAlerts`), cooldown per key.
- **`supportTickets`** — `{source: user_report|staff|automated, status, severity, orgId?,
  userRef?, loadRef?, title, body, deviceContext? (app, version, ota_update_id), githubUrl?,
  createdBy, timestamps}`.

## 7. Feature specifications (five pillars)

### 7.1 Logs & errors
- Axiom: all Convex function logs streamed; saved views per source (crons, integrations,
  mobile endpoints); monitors for error-rate and specific codes → Slack. Console links
  deep into Axiom queries rather than re-implementing search.
- Console "Needs attention" feed = `systemEvents` (error/critical first, org filter).
- Client errors page: top PostHog error-tracking issues per app (web/driver/dispatch),
  grouped by release / `ota_update_id` so a bad OTA push is visible within minutes; link
  each issue to session replays (driver app already records them).

### 7.2 Bug issues / support tickets
- `supportTickets` + in-app "Report a problem" on all three clients with auto-attached
  context. **Driver app submission MUST ride the existing offline queue** (`lib/offline-queue.ts`)
  — reports from drivers with no signal are the most valuable ones.
- Automated ticket sources: webhook dead-letters, `sync_stall_alert`, cron
  `consecutiveFailures ≥ 3`.
- Optional GitHub issue link field connects tickets to the existing autofix-PR loop.

### 7.3 Account support operations
- **Org directory**: reads `orgHealthSnapshots` only; search, sort by health/activity;
  soft-deleted orgs visible with state.
- **Org detail**: members (from synced `orgMembers`, not live WorkOS calls — avoids WorkOS
  rate limits), identity links (Clerk↔WorkOS, phone snapshots), drivers + session states,
  billing summary, flags, integration health, recent tenant audit entries, prior staff
  actions on this org.
- **Actions** (each: step-up if destructive, `reason` required, `platformAuditLog` entry):
  - Force-end stuck session — staff-scoped variant of the existing tenant-facing
    `driverSessions.adminEndSession` (`convex/driverSessions.ts:751`).
  - Clerk resync / re-provision (wraps existing `clerkSync.*` internal actions).
  - Unlink/relink `userIdentityLinks` (wrong phone, org move).
  - Ack `sessionEndedWithActiveLoad` rows.
  - Feature flags: per-org and global editor (replaces CLI `setFlagInternal`); global scope
    writes are the console's most powerful lever — always step-up + reason.
  - Soft-delete / restore org (delete requires typed org-name confirmation).
- All support mutations **idempotent** (safe on double-click/retry): key on target state,
  not on "do it again".

### 7.4 Platform billing
- Revenue dashboard from `platformUsageStats` × frozen/current rates: MRR, accruals, top
  orgs, cycle-over-cycle. (Small table — direct query is fine here.)
- Contract management: rate (effective-dated — a change applies from the NEXT cycle unless
  explicitly backdated with reason), license window, contacts. Audited.
- Invoice lifecycle: cycle-close job (1st of month UTC, after the usage recalc window)
  drafts invoices; staff issue/send/mark-paid/void; adjustments as line items (credits,
  goodwill, disputes) — never edit the metered number.
- **Recalc-vs-invoice drift edge case**: the nightly raise-only recalc may raise
  `loadsWritten` for an already-invoiced period. This must NOT silently change anything:
  emit a `systemEvents` warn + show a drift badge on the invoice; resolution is a manual
  adjustment line. `rebaseline*` actions hard-fail if the period has an issued invoice.
- Tenant billing page switches from derived placeholders to reading `platformInvoices`
  once Phase 3 lands (fixes the rate-change-rewrites-history bug).
- Stripe (later): customer creation against reserved `organizations_sensitive` columns,
  payment links or invoice push, webhook → `paid`, dunning. Only after manual lifecycle
  works.

### 7.5 Performance & reliability
- **Cron wrapper**: `runCronJob(name, handler)` at the **action level** (a failing mutation
  would roll back its own ledger row); records to `cronHealth` (+ `cronRuns` per policy §6);
  **rethrows** so Convex logs → Axiom still capture the failure.
- Jobs board: all 29 jobs, last outcome, duration trend, consecutive failures.
- Integration health: `fourKitesPushTickHealth` across orgs, Samsara poll health, webhook
  queue depth + dead-letters, partner API p95 / 429 rate from `apiAuditLog`.
- GPS/sync: promote `_devTools/syncLatencyDiag` percentiles into staff queries; surface
  driver `sync_stall_alert` events.
- Data integrity: `loadStatusCounts` verify mismatches surfaced, not buried in logs.

## 8. Security & compliance standards (industry baseline)

1. **PII minimization + break-glass reveal.** Driver SSN/license/DOB (`schema.ts:762-764`)
   are **redacted by default** everywhere in the console. Reveal is a distinct action:
   step-up auth + reason + `platformAuditLog` **read** entry. Platform support almost never
   needs raw SSNs — the default UI shows last-4 at most.
2. **Sensitive-read auditing.** Writes are always audited; reads are audited for designated
   sensitive views (PII reveal, banking/insurance fields in `organizations_sensitive`).
   Standard SOC 2 expectation for admin consoles.
3. **Step-up ("sudo") for destructive ops** — §5.
4. **Access reviews** — quarterly allowlist review; offboarding kills both the Google
   account and the allowlist entry.
5. **Retention policy stated per table** — §6. Staff audit: 7y. Events/runs: 30d.
   Tenant audit stays 365d + archive.
6. **Data subject requests (backlog, not Phase 0-3):** per-driver export/delete tooling.
   PII deletion must also consider S3 audit/GPS archives.
7. **Secrets separation**: staff IdP secrets, PostHog key, Axiom token exist only in the
   admin Vercel project + Convex env. Tenant project holds none of them.
8. **Console hardening**: `noindex`, no public assets of interest, optional middleware IP
   allowlist (self-implemented; Vercel Trusted IPs is Enterprise-only), Vercel
   Authentication on preview deployments, strict CSP.
9. **Existing findings folded into Phase 0**: tighten `setFlag`; org-scope
   `clearFourKitesLoads` (and long-term migrate all `OTOQA_ENABLE_DEV_TOOLS` tools into
   `convex/platform/` and retire the env gate); gate/delete `/dev/create-form`; remove dead
   compliance nav link. Open security-review items 8/9/11/12 tracked separately.

## 9. Operational standards

- **Alert routing matrix** (initial):

  | Condition | Severity | Route |
  | --- | --- | --- |
  | Cron `consecutiveFailures ≥ 3` (any job) | high | Slack #platform-alerts |
  | `fourKitesPushTickHealth.lastTickKind = all_failed` | high | Slack |
  | Webhook dead-letters > 10/day | medium | Slack |
  | Error-rate spike (Axiom monitor) | high | Slack |
  | Invoice/usage drift detected | medium | Slack |
  | Platform staff destructive action executed | info | Slack (visibility, not approval) |

  Phone-grade paging (PagerDuty et al.) deferred until there's an on-call rotation to page —
  §14-D4.
- **Dead-man's switch (monitor the monitor).** A 5-min heartbeat cron logs a known line;
  an Axiom **absence monitor** alerts if it stops. If the alerting pipeline itself dies, we
  find out from its silence.
- **External synthetic monitoring.** `/v1/health` is authenticated, so today NOTHING checks
  the platform from outside. Add: an unauthenticated lightweight liveness endpoint in
  `convex/http.ts` (returns 200 + no data) + an external checker (UptimeRobot/Checkly) on
  it, the tenant sign-in page, and admin sign-in page.
- **Public status page** (industry standard, currently missing): a hosted status page
  (Instatus/BetterStack tier is fine) for tenant-visible incidents; console links to it and
  the runbook for updating it.
- **Backups/DR**: document Convex backup schedule and run a restore test once; record RPO/RTO
  expectations in the runbook. (Convex manages backups; the standard we're adding is *tested*
  restore + written expectations.)
- **Runbooks live in `docs/runbooks/`** and the console links them next to the relevant
  board (e.g. FourKites all_failed → its runbook).
- **SLIs to track from day one** (SLO targets set after 1 month of baseline data):
  GPS ping ingestion latency p95; partner API availability + p95; webhook delivery success
  rate; cron success rate; sync-stall rate; error-tracking issue inflow per release.

## 10. Deployment & environments

- **Vercel**: two projects, one repo (tenant = root, admin = `apps/admin`), ignored-build
  steps both directions, `admin.otoqa.com` on the admin project only. Separate env var sets.
- **Environment matrix**: prod admin → prod Convex; preview/dev admin → dev Convex
  deployment. The staff WorkOS project needs matching staging/prod environments (different
  issuers per env, both registered in the respective Convex deployment's auth config).
  No environment switcher inside the console — one deploy per environment.
- **CI**: add `apps/admin` lint/typecheck (and its tests) to `.github/workflows/ci.yml`
  alongside the driver/dispatch entries.
- **Convex env vars added**: `STAFF_ISSUER`, `STAFF_EMAIL_ALLOWLIST`; later `AXIOM_*` is
  dashboard config, not env.

## 11. Risks & edge cases → resolutions

| # | Risk / edge case | Resolution |
| --- | --- | --- |
| 1 | Tenant→platform role escalation | Dissolved: separate issuer; tenant tokens rejected by construction |
| 2 | `membership[0]` mixed-membership breakage | Dissolved: separate site + dedicated staff accounts |
| 3 | Offboarding lag on stale claims | ≤15 min token TTL + dual kill (IdP + allowlist) + step-up before destructive ops |
| 4 | Cross-org scans hit Convex limits / reactivity storms | Snapshot tables only; console polls |
| 5 | Failing mutation rolls back its own cron-ledger row | Action-level wrapper, separate outcome write, rethrow |
| 6 | Ledger volume from 10s/1min jobs | `cronHealth` upserts for high-frequency; history rows only ≤hourly + failures |
| 7 | Rate change rewrites billing history (latent bug) | `platformInvoices` freeze rate+amount; closed cycles render from invoice |
| 8 | Raise-only recalc drifts an invoiced period | Drift badge + systemEvent + manual adjustment; rebaseline hard-fails on invoiced periods |
| 9 | Soft-deleted org with open balance | Policy: accrual stops at deletion; open invoices remain collectible; restore resumes metering |
| 10 | Alert storms from 1-min sweeps | `by_dedupe` + cooldown (proven pattern) + Axiom monitor grouping |
| 11 | PostHog outage during an incident | Convenience view only; Axiom + systemEvents primary; server-side proxy tolerates failure |
| 12 | Offline drivers can't file bug reports | Reports ride the existing offline queue |
| 13 | View-as-org scope creep | Parallel read surface; stays Phase 4 |
| 14 | Two staff editing same org concurrently | Last-write-wins + both writes audited; optimistic concurrency only if it bites |
| 15 | Staff PII exposure | Redact-by-default + break-glass reveal + read audit (§8) |
| 16 | Alerting pipeline dies silently | Dead-man's switch (§9) |
| 17 | Nobody notices a full outage | External synthetic checks + public liveness endpoint (§9) |
| 18 | "Staff" naming collision with dispatch app | Glossary (§2); code says `platformStaff` everywhere |

## 12. Phasing with acceptance criteria

| Phase | Scope | Done when |
| --- | --- | --- |
| **0 — Foundation** | Staff IdP + issuer in Convex auth config; `requirePlatformStaff`; `apps/admin` shell deployed at admin.otoqa.com; `platformAuditLog`; Axiom streaming on (or fallback per §14-V1); external synthetic checks; hardening (setFlag, forceResync scope, dev page, dead link); CI entry | A staff member logs in via the staff issuer and sees an empty console; a tenant-token replay against a platform function is rejected (test exists); logs searchable in Axiom; uptime checks green |
| **1 — Visibility** | `orgHealthSnapshots` + directory + org detail (read-only); revenue dashboard; `cronHealth`/`cronRuns` + wrapper on all 29 jobs; integration health board; `systemEvents` + needs-attention feed; client errors page | On-call can answer "what's broken and for whom" in <2 min without Convex dashboard; every cron failure is visible within one tick |
| **2 — Operations** | Support actions (sessions, Clerk resync, identity links, flags UI, acks); step-up auth; `supportTickets` + report-a-problem (incl. offline path); `platformAlerts` + Slack routing + dead-man's switch; status page + runbooks | A non-engineer resolves a standard account issue end-to-end in the console; every action shows in `platformAuditLog` with reason |
| **3 — Billing maturity** | `platformInvoices` + cycle-close job + adjustments + drift detection; tenant billing page reads invoices; rate changes effective-dated | An issued invoice's amount is immutable under rate changes and recalcs; tenant page shows real statuses |
| **4 — Advanced** | Stripe payments + dunning; read-only view-as-org; SLO dashboards on baselined SLIs | Payment collected via Stripe against a real invoice |

## 13. Testing strategy

- Every `convex/platform/*` function: convex-test cases for staff-allowed,
  tenant-WorkOS-rejected, Clerk-rejected, unauthenticated-rejected, missing-claims-rejected
  (no grandfathering). Mirror the fail-closed style of `platformUsage.test.ts`.
- Billing: invoice freeze under rate change; drift detection on post-invoice recalc;
  adjustment math; rebaseline refusal on invoiced periods.
- Cron wrapper: failure recorded + rethrown; high-frequency policy honored.
- Admin app: Playwright smoke (login redirect, directory renders, a destructive action
  demands step-up + reason).
- CI runs all of the above via the extended matrix.

## 14. Open decisions & verify-before-build (no assumptions)

**Verify (facts to check, cheap, before Phase 0 starts):**
- **V1 — Convex log streaming plan gating.** Log streams may require a paid Convex plan.
  Check the current deployment's plan + pricing. Fallback if unavailable: keep
  `systemEvents` as the primary backend-event surface and revisit; do NOT build a custom
  log pipeline.
- **V2 — WorkOS staff-project pricing.** Confirm AuthKit + Google OAuth (social) is free at
  our seat count and that we are NOT provisioning a paid enterprise SSO connection.
- **V3 — Vercel plan.** Confirm the team plan supports the second project + preview
  protection features we intend to use.
- **V4 — Axiom free-tier limits** vs our log volume (the 10s Samsara poll is the volume
  driver; consider log-level tuning on that job).
- **V5 — Convex backup/restore mechanics** for the DR runbook (§9).

**Decide (choices someone must make; defaults proposed):**
- **D1 — Staff IdP**: separate WorkOS project (default) vs Auth.js+Google.
- **D2 — IP allowlist on admin**: yes if office/VPN egress is stable; else skip (default: skip until VPN exists).
- **D3 — `systemEvents`/`cronRuns` retention**: 30d default — confirm.
- **D4 — Paging**: Slack-only until an on-call rotation exists (default), then re-evaluate.
- **D5 — Status page vendor** and whether it's public or customer-link-only.
- **D6 — Soft-deleted-org billing policy** (§11-9 proposes: accrual stops, invoices remain
  collectible) — confirm with whoever owns customer contracts.
- **D7 — Staff account convention**: dedicated `@otoqa.com` Google accounts (default) vs
  personal-plus-alias.
