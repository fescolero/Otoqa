# Otoqa Dispatch App — Split & Implementation Plan

> Status: **v1.2 — Phases 0–2 device-verified.** Three verification passes completed (log at end); all open questions answered by the product owner 2026-07-25 (decisions D9–D19) except the deliberately deferred OQ-11. §0 security hotfix shipped.
>
> **Device checkpoint 2026-07-26 (Android preview build, Clerk owner-operator path):** sign-in, Board with horizon buckets, Drivers, ranked assignment, Pay + statement detail, fleet map, notifications/alerts, window adjustment, and load creation all confirmed working on device. WorkOS staff sign-in deferred until dashboard access is available (client ID + `otoqa-dispatch://sso` redirect). Still pending user-side config: Android Google Maps API key, FCM V1/APNs push credentials, WorkOS dispatcher-role permission update. Next engineering: Phase 3 mini-plans (§5.3/5.5/5.6 dictation/runs) and driver-app cleanup release N (§6).
> Scope: split mobile into **Otoqa Driver** (existing, cleaned up) and **Otoqa Dispatch** (new; serves in-house dispatchers *and* owner-operators), built against approved design bundle **Otoqa_Mobile8**.
> Backend: the single shared Convex deployment (topology unchanged).

---

## 0. ⚠ Immediate security hotfix — ✅ SHIPPED

Adversarial review found unauthenticated public mutations in `convex/loadCarrierAssignments.ts`. Implementation-time correction: `cancelAssignment` was **already authenticated** (`requireCallerIdentity` + broker/carrier org match) — the review's sixth finding was stale. The genuinely unauthenticated surface was **five** mutations: `assignDriver`, `startLoad`, `completeLoad` (no `ctx.auth` check; org "verification" was comparing a client-supplied `carrierOrgId` string), plus `acceptOffer`/`declineOffer`. Anyone with the Convex URL and an assignment ID could assign/complete loads or accept/decline offers.

**Shipped:** `assertCallerInCarrierOrg(ctx, externalOrgId)` in `convex/lib/auth.ts` — dual-path, parity-shaped per §4.2/§4.3: org-claim tokens (WorkOS web/staff) match the claim; Clerk mobile callers resolve via `userIdentityLinks` by `clerkUserId` **and** the phone fallback (mirroring `getUserRoles` Methods 1+2), role OWNER/ADMIN, non-deleted org, same org-match set as `requireCarrierAuth` (`clerkOrgId`/`workosOrgId`/`_id`). Wired into all five mutations against the **stored** `assignment.carrierOrgId` (not the client arg); all pre-existing arg/status checks unchanged. Covered by `convex/loadCarrierAssignments.auth.test.ts` (13 tests: fail-closed matrix — unauthenticated, unlinked, cross-org, MEMBER, deleted-org, mismatched claim; old-build parity — Clerk OWNER by link, Clerk ADMIN by phone fallback, WorkOS org claim; behavior parity — original error messages and status-transition rules). Full suite green (725 tests / 69 files).

> Field note: the dual-lockfile hazard (OQ-10) bit during this work — `bun.lock` freezes `convex@1.31.2`, which is incompatible with `convex-test@0.0.49` (peer `^1.32`); `package-lock.json` resolves `convex@1.35.1` and is the lockfile that actually works. Until OQ-10 standardizes, **install with `npm ci`**, not bun.
>
> Deployment note (per product owner): the team runs **`convex dev`** — the live backend is the dev deployment. This hotfix goes live the next time `convex dev` syncs functions from a branch containing it; there is no separate `convex deploy` step today.

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
| D9 | **Capability sign-off (closes OQ-2):** staff **admin** → everything incl. settlements; an **accountant/billing** role → settlements view; **dispatcher** → assign work to existing drivers only (`loads:edit`, fleet *view*, **no** `fleet:edit`). All Clerk mobile users are one persona, displayed as **"Owner-operator"** (both OWNER- and ADMIN-linked keep settlements — owners don't share staff role granularity). **Scope note:** this gates *carrier org* settlements (`mobileSettlements.getCarrierStatements`) in the Dispatch app only. Drivers' access to their **own pay statements** in the Driver app (`driverMobile.getMyStatements`, driver-scoped) is a different feature and is untouched by this plan — verified in Pass 3 that the driver Pay screens use none of the guarded endpoints. | User decision 2026-07-25. |
| D10 | **Chat is dropped entirely.** No in-app messaging in either app: §5.3 removed, the driver app's Messages tab is deleted permanently in the cleanup release (closes OQ-7), and the dispatch design's thread screens / "Message driver" actions are replaced with **Call driver**. Contact happens by phone/SMS outside the app. | User decision 2026-07-25. |
| D11 | **HOS (closes OQ-3):** estimate from driver shift sessions for now; build toward an ELD integration later. The HOS chip ships when the estimate lands (Phase 2+), clearly labeled as an estimate. | User decision 2026-07-25. |
| D12 | **Equipment/endorsements (closes OQ-4):** live on **both** truck (trailer type) and driver (endorsements). Gap: the driver record has no UI to view/edit endorsements — new work item (§5.1). Maintained by org admins; by the owner-operator in owner-op orgs. | User decision 2026-07-25. |
| D13 | **Statement export = share the web-generated PDF** (closes OQ-6). | User decision 2026-07-25. |
| D14 | **Staff SSO domains are per-tenant** — WorkOS org SSO config decides which domains are valid (closes OQ-8). Sign-in copy must be dynamic (no hardcoded `otoqa.com`; design change request). | User decision 2026-07-25. |
| D15 | **App name: "Otoqa Dispatch"** (closes OQ-9). | User decision 2026-07-25. |
| D16 | **Package manager: bun** workspaces (closes OQ-10). Phase 0 regenerates a fresh `bun.lock` (must resolve `convex ≥1.32` — the current one is stale/broken vs `convex-test`) and deletes `package-lock.json`. Until then: `npm ci`. | User decision 2026-07-25. |
| D17 | **Crash/error monitoring: PostHog error tracking** for both apps (closes OQ-12) — already the integrated vendor; JS exception autocapture + native-crash capture via `@posthog/react-native-plugin`, with the Expo plugin uploading debug symbols during EAS builds. Sentry only if deep tracing is ever needed. | Verified: PostHog RN error-tracking + Expo symbol upload exist. |
| D18 | **Analytics: shared PostHog project** with an app label property (`app: driver \| dispatch`) to distinguish (closes OQ-13). | User decision 2026-07-25. |
| D19 | **Alerts get a web surface too** (closes OQ-14): web and mobile read the same `dispatchAlerts` Convex source, shipping in the same phase so dispatch stays in sync across surfaces. | User decision 2026-07-25. |

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

### 2.1 Convex codegen (fixes existing drift) — ✅ better than planned

Restructure-time discovery: the checked-in `mobile/convex/_generated` copy was imported by **nothing** — all 52 `_generated` import sites in the driver app already reached the repo-root `convex/_generated` via relative paths. The "drift" risk never had teeth; the dead copy is deleted. `packages/convex-client` now exists re-exporting the root codegen and is the import surface for `apps/dispatch` from day one; the driver app keeps its (root-targeting) relative imports unchanged.

**Phase 0 restructure — ✅ landed:** `mobile/` → `apps/driver`; root bun workspaces (`bunfig.toml` pins `linker = "hoisted"` — bun's isolated/symlinked layout breaks convex-test's `_generated` discovery and Metro resolution); fresh root `bun.lock` (convex `^1.35.1` → resolves 1.42.x, convex-test compatible); `package-lock.json` and `apps/driver/bun.lock` removed; `metro.config.js` monorepo root corrected to `../..`; all 52 codegen import paths bumped one level; root config refs updated (eslint/tsconfig/.gitignore/scripts). Validation: 737 backend tests green; driver `tsc` error count *dropped* 44 → 20 (all pre-existing debt categories; zero path/codegen errors). **Still required before release: an EAS device build of `apps/driver` from the new layout** — hoisting changes node_modules topology and only a real build proves the native side.

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
6. **Convex environment (same pattern, noted 2026-07-25):** the team runs `convex dev` — the dev deployment (`greedy-vole-262`) is the live backend for field users, mirroring the Clerk `pk_test` situation. When production infrastructure is stood up, a Convex **prod deployment** move (new URL in EAS env vars, env variables migrated, data migration plan, `convex deploy`-based release flow) belongs in this same workstream, sequenced with the Clerk migration.

---

## 4. Roles, capabilities, authorization

### 4.1 What exists (verified — this section is mostly adoption)

- **RBAC for WorkOS users is built:** 8 areas × view/edit/manage (`lib/team-rbac.ts` — `loads` "Create loads, assign drivers, work the board", `fleet`, `accounting` "Invoices, settlements, and pay", `team`…), policy in `convex/lib/permissions.ts` (admin bypass → legacy grandfathering → strict check), server guard `assertOrgPermission(ctx, orgId, slug)` in `convex/lib/auth.ts`.
- **Team invites are built** on web (`app/(app)/settings/team/`, `app/api/team/invites/*`). Dispatcher onboarding = existing invite flow with a dispatcher role.
- `userIdentityLinks.role ∈ {OWNER, ADMIN, MEMBER}` — used by the Clerk path only. **No DISPATCHER schema extension needed** (staff are WorkOS/RBAC-governed).

### 4.2 Capability mapping

| Capability | WorkOS caller (staff) | Clerk caller (owner-operator) |
|---|---|---|
| `canDispatch` | `loads:edit` (admin, dispatcher) | identity-link role **OWNER or ADMIN** |
| `canViewSettlements` | `accounting:view` (admin, accountant/billing — **not** dispatcher) | **OWNER or ADMIN** (all mobile Clerk users are the "Owner-operator" persona, D9) |
| `canManageDrivers` | `fleet:edit` (admin only — dispatchers get fleet *view*, per D9) | **OWNER or ADMIN** |

Role presets to configure in WorkOS (D9): **admin** (everything), **accountant/billing** (`accounting:view` + read-only elsewhere as needed), **dispatcher** (`loads:edit`, `fleet:view` — no fleet editing, no accounting). Mobile UI labels the Clerk persona **"Owner-operator"** regardless of underlying OWNER/ADMIN link role.

> **Parity rule (regression-critical):** production today grants owner mode to Clerk identity-link **OWNER or ADMIN** (`carrierMobile.ts:1010`). The Clerk path of every guard MUST accept both — and MUST include the phone-fallback match (H1/H2 findings). D9 confirms this is also the *permanent* rule (both keep settlements), so no post-cleanup tightening is needed on the Clerk path.

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

- WorkOS tokens with no permissions claim pass every check (grandfathering). **OQ-2b answered:** a default **member** role exists, so staff aren't role-less. One retained verification (cheap, Phase 0): confirm the WorkOS roles actually carry the seeded permission claims for every org — the grandfather clause keys on the *token's claims*, not on a role merely existing — then optionally strict-mode the settlements guard.
- Multi-dispatcher concurrency: assignment mutations return `alreadyAssigned` so clients show "Assigned to X by Y just now" (no silent last-write-wins).

---

## 5. Feature build plans

> Patterns per [Convex best practices](https://docs.convex.dev/understanding/best-practices/) (verified in-repo: 41 convex vitest files with `convex-test`; 28 cron jobs incl. 1-min/10-s cadences; `ctx.scheduler.runAfter` ~90×): thin public wrappers over model code, `internal*` cron targets, index-only queries, `usePaginatedQuery` for lists.

### 5.1 Ranked assignment suggestions (Phase 1)

- **Build:** `dispatchMobile.suggestDriversForLoad(loadId)` — proximity (haversine vs pickup), workload, equipment match, last-ping staleness → ranked candidates + structured `warns[]`; blocked candidates ranked-with-warning (design behavior).
- **HOS (per D11):** Phase 1 ships without the chip; a session-derived HOS *estimate* (driver shift sessions → hours-used approximation, labeled as estimate) lands Phase 2+, with an ELD integration as the eventual source of truth.
- **Capability data (per D12 — new work item):** add endorsement fields to the **driver** record (hazmat etc.) and lean on existing **truck** equipment fields; build the missing web UI to view/edit driver endorsements (today the driver record has no surface for them, so the data can't exist). Until populated, equipment scoring uses truck data + load `equipmentType`, and the endorsement chip degrades gracefully.
- **Back-test:** convex-test fixtures — determinism, tie-breaks, org-scoping, warns; authz matrix.

### 5.2 Notifications / exceptions engine (Phase 2)

- **Verified signals to reuse:** check-in/out mutations (+dwell), geofence arrival/departure timestamps (tested), POD-missing predicate (`lib/settlementShared.ts:368-373`), detour flow with reason codes, `driverLatestLocation` recency.
- **Build:** `dispatchAlerts` table (`by_org_status`, dedupe on open `{kind, loadId}`); 1-min detection cron (`internalMutation`, cursor + `runAfter(0,…)` continuation — the documented Convex batching pattern): missed check-in, missed appointment, tracking lost, POD missing, missed check-out. Event-driven kinds fire in-line (load cancelled; declined — via the now-guarded `declineOffer`, driver UI in Phase 3). Reactive `listOpen(orgId)` feed.
- **Web surface ships in the same phase (D19):** a web alerts view reading the same `dispatchAlerts` table/queries, so web and mobile dispatchers see identical state from one source.
- **Design change request (D10):** alert actions drop "Message driver" in favor of **Call driver**; the Notifications screen loses its Messages segment.
- **Back-test:** per-scenario convex-test; batch continuation >1 page; dedupe; lifecycle.

### 5.3 Chat — REMOVED (D10)

Dropped entirely per user decision: no in-app messaging in either app. Consequences applied throughout this plan: the driver Messages tab is deleted in the cleanup release (§6), the dispatch design drops thread screens and message actions (design change request), the push pipeline (§5.7) serves alerts only, and the voice agent's prerequisites shrink (§5.8). If messaging is ever revisited, it re-enters as a new plan, not a revival of this section.

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
- **Push (corrected scope — net-new; alerts-only after D10):** no user-facing sends exist today (`driverPushTokens` is write-only; `fcmWake` is Android-only FCM data wakes). Build the documented Expo pipeline: Convex action → `exp.host/--/api/v2/push/send` + receipt checking ([docs](https://docs.expo.dev/push-notifications/sending-notifications/)); Android needs per-app `google-services.json` + FCM V1 service-account credentials uploaded to Expo; iOS APNs via EAS ([setup](https://docs.expo.dev/push-notifications/push-notifications-setup/)). New `dispatchPushTokens` keyed to the org user (works for both identity types). Triggers: high-severity alerts only (chat removed). Benefits the Driver app too.
- **Back-test:** settlement golden tests incl. one **biweekly and one monthly** org fixture; push receipt handling (mock transport); token lifecycle.

### 5.8 Phase 3 (mini-plans at kickoff)

| Feature | Prereq | Verified starting point |
|---|---|---|
| Bundled runs + auto-plan | 5.1 at scale | `autoAssignment.ts` rule engine + hourly cron |
| Voice agent | 5.1, 5.2, 5.4 (chat removed from prereqs per D10) | STT: [`expo-speech-recognition`](https://github.com/jamsch/expo-speech-recognition) (maintained; streaming partials; New-Arch compatibility demonstrated in the field, not vendor-stated — validate in a spike). **Mic permission enters manifests here only.** |
| Driver accept/decline | Driver-app UI | `acceptOffer`/`declineOffer` exist (guarded by §0 hotfix), zero callers |
| Load-creation dictation | 5.6 + voice stack | — |
| Cross-app sign-in handoff | deferred (D5) | Clerk sign-in tokens verified feasible |

---

## 6. Driver app cleanup (owner-mode removal)

**Sequence (corrected timing):** Release N ships the owner-mode **feature-flag check + interstitial** (old builds don't consult any flag today — the flag only controls builds that contain the check, so the migration window starts at N, not before). Existing infra: `mobile/lib/feature-flags.ts` + Convex `featureFlags` table (verified). Release N+1/N+2 → flag off for all, then delete.

> **Release N code shipped (2026-07-26):** flag `owner_mode_in_driver_app` (default **true** — nothing changes until ops flips it). `featureFlags.getForOrg` extended additively: owner-only Clerk callers now resolve via their OWNER/ADMIN identity link (they previously got `{}` — the exact population this flag targets), and a global `'*'` scope row makes "off for all" a single flip (`npx convex run featureFlags:setFlagInternal '{"workosOrgId":"*","key":"owner_mode_in_driver_app","value":"false"}'`); driver-first resolution order keeps every previously-served caller unchanged (6 new convex-tests). Driver app: `useOwnerModeEnabled` (live query → cache → default-true), `DispatchMovedScreen` interstitial gating every owner-mode entry in `(app)/_layout.tsx` (role picker, more-tab switcher, owner-only auto-select), `dispatch_migration` PostHog funnel events. **Ship-blockers before flipping:** fill `DISPATCH_IOS_STORE_URL` in `lib/dispatch-moved-screen.tsx` once the App Store listing exists; release N must be a store build (`runtimeVersion` bump). Delete list below executes at N+1/N+2, not now.

Delete list (verified):
- `app/(app)/owner/**`, **`app/(app)/driver/**`** (`driver/[id].tsx`, `driver/edit.tsx` — reachable only from the owner drivers list; would otherwise survive as orphans), `role-switch.tsx`, role picker in `(driver-tabs)/more.tsx`
- Mode machinery in `useBootstrap` + `_layout.tsx` (contexts, gates, `@app_mode_selection`)
- Owner analytics events; all remaining `carrierMobile` imports
- Permissions: `NSMicrophoneUsageDescription` + `RECORD_AUDIO` + `requestMicrophonePermissionsAsync()` (unused-capability exposure)
- Dead dep `expo-auth-session`; `owner/feature-unavailable.tsx`; owner "Coming Soon" placeholders (Guideline 2.1 exposure)
- **The Messages tab, permanently (D10):** `(driver-tabs)/messages.tsx`, its tab-bar entry, and the `nav.messages` i18n keys — chat is dropped from the product, so the backendless inbox goes with the cleanup release

**Regression safeguards:** store build (not OTA) + `runtimeVersion` bump; device smoke of the driver critical path (sign-in → scan → shift → check-in/out incl. offline-queued replay → detour → POD → pay → end) plus offline-boot and gate-timeout paths; behavior freeze per §4.4.

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

**Hotfix — ✅ shipped:** §0 — the five unauthenticated `loadCarrierAssignments` mutations now carry parity-shaped guards (deploy promptly).

**Phase 0 — Foundations:** workspace restructure (byte-equivalent Driver build gates everything); **bun** workspace standardization with regenerated `bun.lock` (`convex ≥1.32`) + `package-lock.json` removal (D16); shared codegen package; **Clerk prod-instance migration workstream (§3.4)**; Clerk Native Applications + WorkOS redirect config; `dispatchMobile.getSession` + `requireCapability`; WorkOS role presets configured per D9; RBAC claims verification (§4.6).

**Phase 1 — Dispatch MVP (store submission):** dual-path auth (§3); `dispatchMobile.*` read wrappers (§4.5); board-lite; drivers list/detail; load detail; ranked assign (5.1) + driver-endorsement fields/UI (D12); live map (5.5); Pay gated with dynamic period copy (5.7); More/settings; first-run + brand-new-org empty states; PostHog error tracking + app-label analytics (D17/D18); store assets ("Otoqa Dispatch", D15); review accounts.

**Phase 2 — Operational core:** alerts engine **with web surface** (5.2, D19), window adjustment (5.4), mobile load creation (5.6), Expo push pipeline + dispatch tokens (5.7, alerts-only), session-derived HOS estimate (D11), board horizon buckets. **Driver cleanup releases N → N+2 in parallel (§6).**

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
| Legacy WorkOS tokens bypass RBAC | §4.6 claims verification in Phase 0; optional strict-mode on settlements |
| `_layout.tsx` gate regressions during cleanup | Subtractive-only diffs; gate-path smoke; rollback build |
| Alert noise/duplication | Dedupe key + tests before push wiring |
| Store rejection on OTP review access | OQ-1 resolved (prod test mode, window-scoped) + review-flag fallback |
| Restructure breaks Driver CI | Phase 0 byte-equivalence gate |
| Push pipeline is net-new | Phase 2 sized accordingly; receipts + token pruning day one |
| Two-app crash blindness | PostHog error tracking (D17) lands in Phase 1, before store launch |

## 11. Open questions — ALL RESOLVED except OQ-11

Answered 2026-07-25 (recorded as decisions D9–D19; details in the decisions log):

| OQ | Answer |
|---|---|
| ~~OQ-1~~ | Clerk prod test mode works, window-scoped (§7). |
| ~~OQ-2~~ | D9 — admin: everything; accountant/billing: settlements view; dispatcher: assign-only; Clerk users = "Owner-operator" persona, keep settlements. |
| ~~OQ-2b~~ | Default member role exists; §4.6 keeps a cheap claims-on-token verification in Phase 0. |
| ~~OQ-3~~ | D11 — session-derived estimate now, ELD later. |
| ~~OQ-4~~ | D12 — both driver + truck; driver-endorsement UI is net-new work; admins (or the owner-op) maintain it. |
| ~~OQ-5~~ | Pay periods are per-org WEEKLY/BIWEEKLY/MONTHLY (D7/§5.7). |
| ~~OQ-6~~ | D13 — share the web PDF. |
| ~~OQ-7~~ | D10 — chat dropped entirely; Messages tab deleted in cleanup. |
| ~~OQ-8~~ | D14 — per-tenant domains via WorkOS; dynamic sign-in copy. |
| ~~OQ-9~~ | D15 — "Otoqa Dispatch". |
| ~~OQ-10~~ | D16 — bun workspaces; regenerate `bun.lock`, drop `package-lock.json`. |
| **OQ-11** | **Still open (deliberately):** customer-notification channel for window changes — deferred feature, scope at Phase 2b. |
| ~~OQ-12~~ | D17 — PostHog error tracking (verified RN + native-crash + Expo symbol support). |
| ~~OQ-13~~ | D18 — shared PostHog project + app label. |
| ~~OQ-14~~ | D19 — alerts ship with a web surface from the same Convex source; chat parity moot (D10). |

---

## Verification log

- [x] **Pass 1 — codebase fact-check** (14 items, file:line evidence). Corrections applied: push scope (§5.7 — no sends exist), §5.2 signal reuse, §4 rewritten around existing RBAC/`assertOrgPermission`/team invites, workspace/lockfile state, runtimeVersion facts.
- [x] **Pass 2 — documentation cross-check** (13 external claims: 12 confirmed, 1 confirmed-with-wording-downgrade). OQ-1 resolved (Clerk prod test mode). Wording fixes applied: D6 (5.1.1(iii) grounding), §5.8 (STT New-Arch nuance), §5.7 (FCM V1 credential requirement confirmed).
- [x] **Pass 3 — adversarial review** (4 high, 5 medium, 8 low findings — all incorporated): §0 security hotfix (unauthenticated assignment mutations); §4.2 parity rule (OWNER+ADMIN + phone fallback); §3.4 Clerk-instance migration workstream; §4.5 staff read-path wrappers; §4.4 behavior freeze; §6 delete-list completion (`app/(app)/driver/**`) + flag-timing correction; D7/§5.7 dynamic pay-period copy; §7 Play org-account line; §9 offline states; OQ-12/13/14 added.
