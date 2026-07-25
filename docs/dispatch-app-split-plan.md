# Otoqa Dispatch App — Split & Implementation Plan

> Status: **v1.0 — verified.** Three verification passes completed (log at end): codebase fact-check, external-documentation cross-check (13/13 claims confirmed), adversarial review (all findings incorporated).
> Scope: split mobile into **Otoqa Driver** (existing, cleaned up) and **Otoqa Dispatch** (new; serves in-house dispatchers *and* owner-operators), built against approved design bundle **Otoqa_Mobile8**.
> Backend: the single shared Convex deployment (topology unchanged).

---

## 0. ⚠ Immediate security hotfix — ✅ SHIPPED

Adversarial review found unauthenticated public mutations in `convex/loadCarrierAssignments.ts`. Implementation-time correction: `cancelAssignment` was **already authenticated** (`requireCallerIdentity` + broker/carrier org match) — the review's sixth finding was stale. The genuinely unauthenticated surface was **five** mutations: `assignDriver`, `startLoad`, `completeLoad` (no `ctx.auth` check; org "verification" was comparing a client-supplied `carrierOrgId` string), plus `acceptOffer`/`declineOffer`. Anyone with the Convex URL and an assignment ID could assign/complete loads or accept/decline offers.

**Shipped:** `assertCallerInCarrierOrg(ctx, externalOrgId)` in `convex/lib/auth.ts` — dual-path, parity-shaped per §4.2/§4.3: org-claim tokens (WorkOS web/staff) match the claim; Clerk mobile callers resolve via `userIdentityLinks` by `clerkUserId` **and** the phone fallback (mirroring `getUserRoles` Methods 1+2), role OWNER/ADMIN, non-deleted org, same org-match set as `requireCarrierAuth` (`clerkOrgId`/`workosOrgId`/`_id`). Wired into all five mutations against the **stored** `assignment.carrierOrgId` (not the client arg); all pre-existing arg/status checks unchanged. Covered by `convex/loadCarrierAssignments.auth.test.ts` (13 tests: fail-closed matrix — unauthenticated, unlinked, cross-org, MEMBER, deleted-org, mismatched claim; old-build parity — Clerk OWNER by link, Clerk ADMIN by phone fallback, WorkOS org claim; behavior parity — original error messages and status-transition rules). Full suite green (725 tests / 69 files).

> Field note: the dual-lockfile hazard (OQ-10) bit during this work — `bun.lock` freezes `convex@1.31.2`, which is incompatible with `convex-test@0.0.49` (peer `^1.32`); `package-lock.json` resolves `convex@1.35.1` and is the lockfile that actually works. Until OQ-10 standardizes, **install with `npm ci`**, not bun.

---

## 1. Decisions log (settled)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Two apps total: Driver + Dispatch. Owner mode removed from the Driver app after a migration window. | Verified zero cross-imports between screen trees; different products; store-review isolation. |
| D2 | Dispatch serves **two personas**: in-house dispatcher (staff) and owner-operator. One codebase, capability-gated UI. | ~95% shared function; only Pay/settlements differs. |
| D3 | Pay & settlements visible **only** to users with the settlements capability. Staff never see the section (absent, not locked). UI keys off a **server-returned capability flag**, never the auth provider. | Client hiding is cosmetic; enforcement is server-side (§4). |
| D4 | Auth: **Clerk phone OTP** for owner-operators (primary); **WorkOS + Google Workspace SSO** for staff behind "Company staff? Sign in". One Convex deployment validates both (already true). | Staff are Google Workspace users; WorkOS keeps offboarding centralized. |
| D5 | No "switch to driving" button. Owner-operators open the Driver app directly. Cross-app sign-in-token handoff deferred. | User decision; both sessions are long-lived. |
| D6 | Dispatch requests **no location permission**, no camera, no microphone until voice ships (Phase 3). Design's Permissions-row copy drops "Location" at build time. | Minimal manifest = fast review. Grounded in Guideline 5.1.1(iii) data minimization; unused-permission rejections are commonly reported (not Apple-documented as automatic). |
| D7 | Design v8 (Otoqa_Mobile8) approved build-ready — with one copy correction: pay-period labels must be **dynamic** (see §5.7; the org pay model is WEEKLY/BIWEEKLY/MONTHLY per `schema.ts:2040-2061`, so "weekly · pays Wednesday" can't be hardcoded). | Reviewed against codebase + store guidelines. |
| D8 | Monorepo restructure: workspace apps + shared packages; single source of Convex codegen. | `mobile/convex/_generated` already drifts from root (verified). |

---

## 2. Target architecture

```
Otoqa/
├─ convex/                     # unchanged — single backend serving web + both apps
├─ app/ …                      # Next.js web (unchanged)
├─ apps/
│  ├─ driver/                  # current mobile/ moved here (com.otoqa.driver, scheme otoqa-driver)
│  └─ dispatch/                # NEW Expo app (com.otoqa.dispatch, scheme otoqa-dispatch)
└─ packages/
   ├─ mobile-core/             # theme/design tokens, design-icons, i18n (en/es), shared UI
   └─ convex-client/           # Convex client + auth token sources + re-exported _generated types
```

- **Workspaces (Phase 0 chore):** none exist today; root carries *both* `bun.lock` and `package-lock.json`, `mobile/` has its own `bun.lock` + `.npmrc` (`legacy-peer-deps=true`) — standardize on one package manager with workspaces (bun is the leading candidate; OQ-10). Reference: Convex's official [Turborepo + Next.js + Expo + Clerk monorepo template](https://github.com/get-convex/turbo-expo-nextjs-clerk-convex-monorepo) (backend as shared package — the endorsed pattern via official template).
- Expo monorepo support is first-class (`expo/metro-config` auto-detects; [docs](https://docs.expo.dev/guides/monorepos/)). EAS builds run from each app directory ([EAS monorepo docs](https://docs.expo.dev/build-reference/build-with-monorepos/)).
- Per-app: `app.json` (bundle id, **deep-link scheme — Dispatch needs `otoqa-dispatch` for the AuthKit PKCE browser return**, EAS projectId, OTA channel + runtimeVersion; Driver's runtimeVersion is the hardcoded string `"1.6.0"`, `appVersionSource: "remote"`), `eas.json`, icon/splash/store assets (scheduled in Phase 1 — new assets for Dispatch).

### 2.1 Convex codegen (fixes existing drift)

`packages/convex-client` re-exports root `convex/_generated`; both apps import from the package. One `npx convex codegen`, zero copies.

---

## 3. Auth architecture (Dispatch app)

### 3.1 What exists (verified)

- **Driver mobile:** hand-rolled provider around a raw `ConvexReactClient` + `convex.setAuth(fetchToken, onChange)` (`mobile/lib/convex.tsx:186-278`), Clerk token source, 3s false-debounce, 10s timeout, capped reauth, AppState recovery. Keep untouched for Driver.
- **Web:** `ConvexProviderWithAuth` + WorkOS adapter `useAuthFromAuthKit` (`components/ConvexClientProvider.tsx:21-69`) — refresh on `forceRefreshToken`, retry/backoff. **Model for the mobile WorkOS token source.**
- **Backend:** `convex/auth.config.ts` trusts both WorkOS issuers + one Clerk issuer (`CLERK_ISSUER_URL`) — see §3.4 for the Clerk-instance migration implication.

### 3.2 Pluggable token source

Generalize the mobile provider to a `TokenSource` interface (`isLoaded`, `isSignedIn`, `getToken({forceRefresh})`, `signOut`) per Convex's [custom auth contract](https://docs.convex.dev/auth/advanced/custom-auth):

- `clerkTokenSource` — today's code path (Driver exclusively; Dispatch for owner-operators).
- `workosTokenSource` — AuthKit hosted flow + PKCE ([WorkOS Expo integration](https://workos.com/docs/integrations/react-native-expo), [expo-authkit-example](https://github.com/workos/expo-authkit-example)): access+refresh tokens in `expo-secure-store`, refresh via `authenticateWithRefreshToken()`, browser return on `otoqa-dispatch://` scheme; fetch logic mirrors web's `useAuthFromAuthKit`.
- Persisted `authProvider` flag (SecureStore) selects the source; recovery machinery is source-agnostic.

### 3.3 Identity & session resolution

New query `dispatchMobile.getSession` (leaves `carrierMobile.getUserRoles` untouched):

- **Clerk caller:** resolve via `userIdentityLinks` `by_clerk` **and the phone fallback** (Methods 1 and 2 of `getUserRoles` — both, exactly).
- **WorkOS caller:** org + RBAC claims via existing `assertCallerOwnsOrg` / `getCallerPermissionClaims` (`convex/lib/auth.ts`).
- Returns org info + capability flags (§4.2). The app renders from these flags only.

### 3.4 ⚠ Clerk production-instance migration (dedicated Phase 0 workstream — was underscoped)

`eas.json` ships `pk_test` keys in **all** profiles including production (verified) — every field user today lives on the Clerk **dev** instance. Migration to a production instance is a real project, not a checklist line:

1. **Dual Clerk issuers** in `auth.config.ts` during the window (add the prod issuer alongside the existing `CLERK_ISSUER_URL` entry) so old builds' dev-instance tokens keep validating.
2. **Identity re-link:** prod-instance users get new Clerk user IDs, invalidating `userIdentityLinks.clerkUserId` (`requireCarrierAuth` is strict `by_clerk`). Strategy: re-link keyed on verified phone number at first prod-instance sign-in (mirror the existing phone-fallback matching), backfilled by a migration script.
3. **Forced re-sign-in** for all drivers/owners when their build moves to prod keys — comms + staged rollout required.
4. Dispatch registers against the **production** instance from day one (Native Applications entry there).
5. Risk-table row added (§10).

---

## 4. Roles, capabilities, authorization

### 4.1 What exists (verified — this section is mostly adoption)

- **RBAC for WorkOS users is built:** 8 areas × view/edit/manage (`lib/team-rbac.ts` — `loads` "Create loads, assign drivers, work the board", `fleet`, `accounting` "Invoices, settlements, and pay", `team`…), policy in `convex/lib/permissions.ts` (admin bypass → legacy grandfathering → strict check), server guard `assertOrgPermission(ctx, orgId, slug)` in `convex/lib/auth.ts`.
- **Team invites are built** on web (`app/(app)/settings/team/`, `app/api/team/invites/*`). Dispatcher onboarding = existing invite flow with a dispatcher role.
- `userIdentityLinks.role ∈ {OWNER, ADMIN, MEMBER}` — used by the Clerk path only. **No DISPATCHER schema extension needed** (staff are WorkOS/RBAC-governed).

### 4.2 Capability mapping

| Capability | WorkOS caller (staff) | Clerk caller (owner-operator) |
|---|---|---|
| `canDispatch` | `loads:edit` | identity-link role **OWNER or ADMIN** |
| `canViewSettlements` | `accounting:view` (expected absent from the dispatcher preset — OQ-2 confirms) | **OWNER or ADMIN** |
| `canManageDrivers` | `fleet:edit` | **OWNER or ADMIN** |

> **Parity rule (regression-critical):** production today grants owner mode to Clerk identity-link **OWNER or ADMIN** (`carrierMobile.ts:1010`). The Clerk path of every guard MUST accept both — and MUST include the phone-fallback match (H1/H2 findings) — until owner mode is fully removed from field builds. Tightening (e.g., ADMIN loses settlements) happens only after the migration window closes, gated on OQ-2. **OQ-2 is therefore a Phase 0 blocker, not a background question.**

### 4.3 Enforcement (server-side, not just UI)

Dual-path guard `requireCapability(ctx, orgId, capability)`:
- WorkOS caller → `assertOrgPermission` with the mapped slug (exists).
- Clerk caller → identity-link lookup **mirroring `getUserRoles` exactly: `by_clerk` then phone fallback, OWNER/ADMIN** — with an old-build-vs-guard parity test.

Current posture (corrected after review): the settlements queries and `carrierMobile` endpoints **already** verify org membership server-side via `requireCarrierAuth` (Clerk-only, fail-soft). The genuinely unauthenticated surface is the six `loadCarrierAssignments` mutations — fixed by the §0 hotfix. Guard adoption therefore means:
1. §0 hotfix mutations (immediately).
2. New `dispatchMobile.*` endpoints (§5) use `requireCapability` from birth, **failing loud** (typed errors), not empty.
3. Existing `carrierMobile.*`/`mobileSettlements.*` reads gain WorkOS-path support via `dispatchMobile.*` wrappers (§4.5) — their Clerk behavior for old builds is left byte-identical through the migration window.

### 4.4 Behavior freeze for old builds (supersedes "frozen signatures")

The freeze is on **old-build-observable behavior**, not just signatures: every endpoint the shipped Driver app calls (driver mode *and* owner mode) keeps identical auth outcomes, result shapes, and fail-soft semantics until owner mode is removed from all supported builds. CI review rule + the parity test above enforce it.

### 4.5 Staff access to existing reads (H4 fix — scheduled work, not an afterthought)

Every read the Dispatch MVP needs currently authenticates via Clerk-only `requireCarrierAuth` and would return **silently empty** for WorkOS staff. Phase 1 therefore ships `dispatchMobile.*` wrappers (dual-path auth, fail-loud) for the full MVP read set, enumerated now: `getDashboard`, `getActiveLoads`, `getCompletedLoads`, `getDrivers`, `getDriverById`, `getAvailableDrivers`, `getDriverLocations`, `loadCarrierAssignments.get`/`getWithDetails`, plus the settlements pair for the Pay screens. The originals stay untouched for old builds.

### 4.6 Legacy-token caveat & concurrency

- WorkOS tokens with no permissions claim pass every check (grandfathering). **OQ-2b (Phase 0 blocker):** confirm RBAC roles are seeded for all staff before Dispatch launch; optionally strict-mode the settlements guard.
- Multi-dispatcher concurrency: assignment mutations return `alreadyAssigned` so clients show "Assigned to X by Y just now" (no silent last-write-wins).

---

## 5. Feature build plans

> Patterns per [Convex best practices](https://docs.convex.dev/understanding/best-practices/) (verified in-repo: 41 convex vitest files with `convex-test`; 28 cron jobs incl. 1-min/10-s cadences; `ctx.scheduler.runAfter` ~90×): thin public wrappers over model code, `internal*` cron targets, index-only queries, `usePaginatedQuery` for lists.

### 5.1 Ranked assignment suggestions (Phase 1)

- **Build:** `dispatchMobile.suggestDriversForLoad(loadId)` — proximity (haversine vs pickup), workload, equipment match, last-ping staleness → ranked candidates + structured `warns[]`; blocked candidates ranked-with-warning (design behavior).
- **Data gaps:** no live HOS (OQ-3) → ship without the HOS chip; endorsements not modeled (OQ-4).
- **Back-test:** convex-test fixtures — determinism, tie-breaks, org-scoping, warns; authz matrix.

### 5.2 Notifications / exceptions engine (Phase 2)

- **Verified signals to reuse:** check-in/out mutations (+dwell), geofence arrival/departure timestamps (tested), POD-missing predicate (`lib/settlementShared.ts:368-373`), detour flow with reason codes, `driverLatestLocation` recency.
- **Build:** `dispatchAlerts` table (`by_org_status`, dedupe on open `{kind, loadId}`); 1-min detection cron (`internalMutation`, cursor + `runAfter(0,…)` continuation — the documented Convex batching pattern): missed check-in, missed appointment, tracking lost, POD missing, missed check-out. Event-driven kinds fire in-line (load cancelled; declined — via the now-guarded `declineOffer`, driver UI in Phase 3). Reactive `listOpen(orgId)` feed.
- **Back-test:** per-scenario convex-test; batch continuation >1 page; dedupe; lifecycle.

### 5.3 Chat — driver ↔ dispatch (Phase 2)

- **Build:** `threads` + `messages` + per-participant `lastReadAt`; `by_org_lastMessage`, `by_thread_created`; `usePaginatedQuery`; rate-limited via the already-registered `@convex-dev/rate-limiter`. Serves both apps (lights up the Driver app's stub Messages tab). Push depends on §5.7.
- **Back-test:** thread idempotency, unread counts, pagination order, authz; 10k-message seed for index-only access.
- **Web parity** for chat/alerts is deliberately out of scope for Phase 2 (OQ-14 decides timing).

### 5.4 Appointment window adjustment (Phase 2)

- `dispatchMobile.adjustStopWindow` — capability-guarded, audit-logged (`auditLog.ts` exists), knock-on via `_helpers/timeUtils` `OverlapInfo`. Customer auto-notification = Phase 2b (no channel exists; OQ-11).
- **Back-test:** overlap units; authz matrix; audit assertions.

### 5.5 Live fleet map (Phase 1)

- `getDriverLocations` (via wrapper) + `react-native-maps`; fleet-bounding-box centering, **no user location** (D6).
- **Back-test:** org-scoping/authz; manual device matrix.

### 5.6 Mobile load creation (Phase 2; dictation Phase 3)

- Mobile wrapper over the web creation model functions (no forked validation).
- **Back-test:** web-vs-mobile parity test (identical input → identical load docs).

### 5.7 Pay screens (Phase 1) + push pipeline (Phase 2)

- **Pay:** `getCarrierStatements` / `getCarrierStatementDetails` behind `canViewSettlements`; "blocked on paperwork" reuses the settlement POD predicate. **Period copy is dynamic** — org pay model is WEEKLY/BIWEEKLY/MONTHLY with configurable start day (`schema.ts:2040-2061`; resolves former OQ-5): labels render from the org's actual config, never "weekly / pays Wednesday" hardcoded. Statement export: share the web-generated PDF artifact (OQ-6 confirms).
- **Push (corrected scope — net-new):** no user-facing sends exist today (`driverPushTokens` is write-only; `fcmWake` is Android-only FCM data wakes). Build the documented Expo pipeline: Convex action → `exp.host/--/api/v2/push/send` + receipt checking ([docs](https://docs.expo.dev/push-notifications/sending-notifications/)); Android needs per-app `google-services.json` + FCM V1 service-account credentials uploaded to Expo; iOS APNs via EAS ([setup](https://docs.expo.dev/push-notifications/push-notifications-setup/)). New `dispatchPushTokens` keyed to the org user (works for both identity types). Benefits the Driver app too.
- **Back-test:** settlement golden tests incl. one **biweekly and one monthly** org fixture; push receipt handling (mock transport); token lifecycle.

### 5.8 Phase 3 (mini-plans at kickoff)

| Feature | Prereq | Verified starting point |
|---|---|---|
| Bundled runs + auto-plan | 5.1 at scale | `autoAssignment.ts` rule engine + hourly cron |
| Voice agent | 5.1–5.4 | STT: [`expo-speech-recognition`](https://github.com/jamsch/expo-speech-recognition) (maintained; streaming partials; New-Arch compatibility demonstrated in the field, not vendor-stated — validate in a spike). **Mic permission enters manifests here only.** |
| Driver accept/decline | Driver-app UI | `acceptOffer`/`declineOffer` exist (guarded by §0 hotfix), zero callers |
| Load-creation dictation | 5.6 + voice stack | — |
| Cross-app sign-in handoff | deferred (D5) | Clerk sign-in tokens verified feasible |

---

## 6. Driver app cleanup (owner-mode removal)

**Sequence (corrected timing):** Release N ships the owner-mode **feature-flag check + interstitial** (old builds don't consult any flag today — the flag only controls builds that contain the check, so the migration window starts at N, not before). Existing infra: `mobile/lib/feature-flags.ts` + Convex `featureFlags` table (verified). Release N+1/N+2 → flag off for all, then delete.

Delete list (verified):
- `app/(app)/owner/**`, **`app/(app)/driver/**`** (`driver/[id].tsx`, `driver/edit.tsx` — reachable only from the owner drivers list; would otherwise survive as orphans), `role-switch.tsx`, role picker in `(driver-tabs)/more.tsx`
- Mode machinery in `useBootstrap` + `_layout.tsx` (contexts, gates, `@app_mode_selection`)
- Owner analytics events; all remaining `carrierMobile` imports
- Permissions: `NSMicrophoneUsageDescription` + `RECORD_AUDIO` + `requestMicrophonePermissionsAsync()` (unused-capability exposure)
- Dead dep `expo-auth-session`; `owner/feature-unavailable.tsx`; owner "Coming Soon" placeholders (Guideline 2.1 exposure)

**Regression safeguards:** store build (not OTA) + `runtimeVersion` bump; device smoke of the driver critical path (sign-in → scan → shift → check-in/out incl. offline-queued replay → detour → POD → pay → end) plus offline-boot and gate-timeout paths; behavior freeze per §4.4; Messages tab decision at cleanup time (OQ-7).

---

## 7. Store compliance checklist

### iOS
- [ ] **4.8** — staff Google sign-in is enterprise SSO with existing Workspace accounts behind "Company staff? Sign in" → exempt from Sign in with Apple ([guidelines §4.8](https://developer.apple.com/app-store/review/guidelines/#login-services), verified text incl. the enterprise-account exception). Phone OTP primary is first-party. Never a bare consumer Google button.
- [ ] **2.1(a)** — demo account info required for login apps (explicit in guidelines). No placeholder screens at submission.
- [ ] **Review access (OQ-1 resolved):** Clerk fictional numbers verify with `424242`; test mode **can be enabled on production instances** (Dashboard or Backend API `PATCH /instance {"test_mode": true}`) but is instance-wide and discouraged by Clerk — enable only during review windows, or use the review-mode-flag fallback ([Clerk docs](https://clerk.com/docs/guides/development/testing/test-emails-and-phones)). Staff persona: dedicated Workspace review account.
- [ ] **Permissions** — Dispatch: notifications only (mic arrives with Phase 3). Driver: existing set minus mic.
- [ ] Clerk production instance per §3.4 (requires a domain); register `com.otoqa.dispatch` there; WorkOS redirect allowlist incl. `otoqa-dispatch://` return.
- [ ] Separate listing/`ascAppId`; new icon/splash/store assets (Phase 1).

### Android
- [ ] **Play "App access"** — reusable, non-expiring credentials for both personas, English instructions, OTP bypass ([requirements](https://support.google.com/googleplay/android-developer/answer/9859455)).
- [ ] **Data safety** — new form for Dispatch (no location; accurate analytics disclosure).
- [ ] Manifests — Dispatch: no location/background/mic; Driver: drop `RECORD_AUDIO`.
- [ ] New Firebase Android app for `com.otoqa.dispatch` + FCM V1 credentials on the Dispatch Expo project (push, Phase 2).
- [ ] Confirm publishing under the existing **organization** Play account (12-tester/14-day closed-testing rule applies only to personal accounts created after Nov 2023 — verify account type once; expected exempt).

---

## 8. Phases

**Hotfix (now):** §0 — authenticate the six `loadCarrierAssignments` mutations with parity-shaped guards.

**Phase 0 — Foundations:** workspace restructure (byte-equivalent Driver build gates everything); package-manager standardization (OQ-10); shared codegen package; **Clerk prod-instance migration workstream (§3.4)**; Clerk Native Applications + WorkOS redirect config; `dispatchMobile.getSession` + `requireCapability`; **blockers resolved: OQ-2 capability sign-off, OQ-2b RBAC seeding audit**.

**Phase 1 — Dispatch MVP (store submission):** dual-path auth (§3); `dispatchMobile.*` read wrappers (§4.5); board-lite; drivers list/detail; load detail; ranked assign (5.1); live map (5.5); Pay gated with dynamic period copy (5.7); More/settings; first-run + brand-new-org empty states (no drivers/loads yet); crash monitoring + analytics wiring (OQ-12/13); store assets; review accounts.

**Phase 2 — Operational core:** alerts engine (5.2), chat both apps (5.3), window adjustment (5.4), mobile load creation (5.6), Expo push pipeline + dispatch tokens (5.7), board horizon buckets. **Driver cleanup releases N → N+2 in parallel (§6).**

**Phase 3 — Differentiators:** runs/auto-plan, voice agent (+ mic), driver accept/decline UI, dictation.

Phase exit criteria: convex-test green; device-matrix smoke (iOS+Android × both personas); design-parity review vs Mobile8.

---

## 9. Testing strategy

- **Backend:** extend existing vitest/`convex-test` (41 files, verified). Every new endpoint ships an **authz matrix test** (right capability passes; wrong role / wrong org / unauthenticated / legacy-claims fail per policy). **Old-build parity tests** for the §0 hotfix and any guard touching endpoints field builds call (§4.4).
- **Auth:** token-source contract tests (incl. `forceRefresh`); manual matrix — cold start, expiry mid-session, offline boot, sign-out, provider switch, browser-return cancel.
- **Mobile:** no test infra exists (verified) — Phase 0 adds a minimal vitest project for `packages/*` pure logic; scripted device passes per release.
- **Money:** golden tests across weekly/biweekly/monthly org fixtures (5.7).
- **Dispatch offline states:** Dispatch does not inherit the driver offline queue; it ships defined offline/reconnect/empty states (cached reactive queries + a reconnect banner) — scripted-device-pass scenarios included.

## 10. Risks

| Risk | Mitigation |
|---|---|
| **Clerk dev→prod instance migration breaks field users** | §3.4 workstream: dual issuers, phone-keyed re-link + backfill, staged rollout, comms |
| Guard adoption breaks owner mode in old builds | Parity rules (§4.2/4.3): OWNER+ADMIN + phone fallback, behavior freeze (§4.4), parity tests |
| WorkOS mobile adapter edge cases | Mirror web's proven adapter; contract tests; staff-only blast radius |
| Legacy WorkOS tokens bypass RBAC | OQ-2b seeding audit (Phase 0 blocker); optional strict-mode on settlements |
| `_layout.tsx` gate regressions during cleanup | Subtractive-only diffs; gate-path smoke; rollback build |
| Alert noise/duplication | Dedupe key + tests before push wiring |
| Store rejection on OTP review access | OQ-1 resolved (prod test mode, window-scoped) + review-flag fallback |
| Restructure breaks Driver CI | Phase 0 byte-equivalence gate |
| Push pipeline is net-new | Phase 2 sized accordingly; receipts + token pruning day one |
| Two-app crash blindness | OQ-12 (monitoring) resolved in Phase 1, before store launch |

## 11. Open questions

**Resolved during verification:** ~~OQ-1~~ (Clerk prod test mode — see §7), ~~OQ-5~~ (pay periods are per-org WEEKLY/BIWEEKLY/MONTHLY — see D7/§5.7).

- **OQ-2 (Phase 0 blocker):** capability sign-off — which WorkOS preset roles carry `accounting:view`? Post-cleanup, do Clerk ADMIN links keep settlements? Dispatcher `fleet:edit`?
- **OQ-2b (Phase 0 blocker):** RBAC seeded for all staff (no legacy no-claims tokens) before launch?
- **OQ-3:** HOS source (ELD vs computed) — blocks the HOS chip.
- **OQ-4:** Equipment/endorsement home (driver vs truck) + ownership.
- **OQ-6:** Statement export = share web PDF artifact (recommended) — confirm.
- **OQ-7:** Driver Messages tab between cleanup and chat: hide or keep empty-state?
- **OQ-8:** Staff SSO domain allowlist (design hardcodes `otoqa.com`).
- **OQ-9:** Final Dispatch display name ("Otoqa Dispatch" vs "Otoqa Dispatcher").
- **OQ-10:** Package manager for the workspace (bun vs npm).
- **OQ-11:** Customer-notification channel for window changes (Phase 2b scope).
- **OQ-12:** Crash/error monitoring choice (nothing exists in mobile today — Sentry vs alternatives) for both apps.
- **OQ-13:** PostHog: separate project/key for Dispatch, or shared key with app property? (Same key currently baked into every driver profile.)
- **OQ-14:** Web parity timing for alerts/chat (web planner already assigns via `directAssign`/`offerLoad` — mobile and web assignment paths must stay consistent; decide owner and timing).

---

## Verification log

- [x] **Pass 1 — codebase fact-check** (14 items, file:line evidence). Corrections applied: push scope (§5.7 — no sends exist), §5.2 signal reuse, §4 rewritten around existing RBAC/`assertOrgPermission`/team invites, workspace/lockfile state, runtimeVersion facts.
- [x] **Pass 2 — documentation cross-check** (13 external claims: 12 confirmed, 1 confirmed-with-wording-downgrade). OQ-1 resolved (Clerk prod test mode). Wording fixes applied: D6 (5.1.1(iii) grounding), §5.8 (STT New-Arch nuance), §5.7 (FCM V1 credential requirement confirmed).
- [x] **Pass 3 — adversarial review** (4 high, 5 medium, 8 low findings — all incorporated): §0 security hotfix (unauthenticated assignment mutations); §4.2 parity rule (OWNER+ADMIN + phone fallback); §3.4 Clerk-instance migration workstream; §4.5 staff read-path wrappers; §4.4 behavior freeze; §6 delete-list completion (`app/(app)/driver/**`) + flag-timing correction; D7/§5.7 dynamic pay-period copy; §7 Play org-account line; §9 offline states; OQ-12/13/14 added.
