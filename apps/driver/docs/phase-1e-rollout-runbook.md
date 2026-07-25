# Phase 1e — Activity Recognition + FCM Wake Rollout Runbook

**Status**: ready to execute after PRs #107–#110 merged to `main` (done) and an EAS build on `runtimeVersion: 1.5.0` is installed on canary devices.

This document is the operator-focused playbook for flipping the Phase 1 GPS wake-up path from "dark" (default) to "live" (real FGS restarts on AR transitions + server-initiated FCM wake pushes). It deliberately repeats some context from `gps-tracking-architecture.md` § Phase 1 so the runbook stands alone for someone who isn't deep in the design doc.

## Participants

| Role | Responsibility |
|---|---|
| **Rollout owner** | Runs every step in this doc. Owns the go/no-go calls at each checkpoint. Expected to be the mobile tracking-stack owner named in `gps-tracking-architecture.md` § 11 |
| **Canary driver(s)** | Christian — org `org_01KAEYJHZNV9KQCXF9FN9N3CCY` (per architecture doc § Pre-work). One physical device running the EAS preview build, active for ≥8 hours/day during shadow-mode observation |
| **Reviewer** | Someone other than the rollout owner who signs off before the live flip. Exists so one person can't flip a capability gate alone |

## Pre-flight (complete BEFORE any flag flip)

### Code on main
- [ ] PR #107 (Phase 1a) merged — verify `convex/pushTokens.ts` exists in `main`
- [ ] PR #108 (Phase 1b) merged — verify `convex/fcmWake.ts` exists
- [ ] PR #109 (Phase 1c) merged — verify `mobile/lib/fcm-handler.ts` exists
- [ ] PR #110 (Phase 1d) merged — verify `mobile/modules/otoqa-motion/` exists

All four verified via `git log origin/main` at runbook creation. See References section below for the commits.

### Convex env
- [ ] `FCM_SERVICE_ACCOUNT_JSON` set on dev deployment. Verify:
  ```bash
  npx convex env get FCM_SERVICE_ACCOUNT_JSON | head -c 50
  # → should start with '{"type":"service_account","project_id":"otoqa-95106"...
  ```
- [ ] `FCM_SERVICE_ACCOUNT_JSON` NOT set on prod deployment yet. Prod flip happens only after canary succeeds AND we have a separate service-account key scoped to a prod Firebase project (currently single shared dev project per arch doc § Pre-work).

### Mobile build
- [ ] EAS build on `runtimeVersion: 1.5.0`:
  - Android preview APK (profile `preview`) — installed on Christian's device
  - iOS TestFlight build (profile `testflight`) — submitted, awaiting TestFlight availability (iOS has no FCM wake path in Phase 1; this is a sanity build, not a flip target)
- [ ] On the canary device, confirm runtime version in Settings → About → Build — should read `1.5.0`
- [ ] Build URLs + install instructions in `#mobile-eas-builds` channel
- [ ] Canary driver has signed in at least once since installing (populates `driverSessions.pushToken` on shift start via `registerPushToken`)

### PostHog dashboards
- [ ] Saved view **"Phase 1 canary — shadow mode"** exists, pre-filtered to `org_01KAEYJHZNV9KQCXF9FN9N3CCY` on the following events:
  - `activity_recognition_transition` (with `shadow=true` filter)
  - `activity_recognition_fgs_restart`
  - `fcm_wake_received`
  - `fcm_wake_resume_success`
  - `fcm_wake_ignored`
  - `fcm_wake_session_inactive`
  - `push_token_registered` / `push_token_cleared` / `push_token_skipped`
  - `session_last_ping_patched` (server-side — surfaces via the Convex log drain if one is configured; otherwise skip)
  - `tracking_skewed_ping_rejected`
  - `location_queue_op_failed`, `location_queue_auto_reset`
- [ ] Saved view **"Phase 1 canary — baseline"** snapshotting the 7-day median of `skipped_backgrounded` + `location_queue_op_failed` + `location_queue_auto_reset` counts from the week immediately before the flip. This is the regression baseline that canary must stay below.

---

## Step 1 — Enable shadow mode on canary

**Goal**: fire `activity_recognition_transition` telemetry for ≥7 days WITHOUT starting any FGS restarts. Validates that AR's transition rate is sane and that our filters (debounce, rate limit) behave as expected.

**Exact commands** (copy-paste from a terminal in the repo root):

```bash
# 1. Enable motion-service (otherwise mode resolver short-circuits to `inert`).
#    ar_wake_enabled=true + ar_shadow_mode=true together = shadow mode.
npx convex run featureFlags:setFlagInternal '{"workosOrgId":"org_01KAEYJHZNV9KQCXF9FN9N3CCY","key":"ar_wake_enabled","value":"true"}'

npx convex run featureFlags:setFlagInternal '{"workosOrgId":"org_01KAEYJHZNV9KQCXF9FN9N3CCY","key":"ar_shadow_mode","value":"true"}'

# 2. Verify both rows exist and have the expected values.
npx convex run featureFlags:getForOrg '{}' --identity "workosOrgId:org_01KAEYJHZNV9KQCXF9FN9N3CCY"
# → should include { "ar_wake_enabled": "true", "ar_shadow_mode": "true" }
# (NOTE: this only works from an admin context; operator may need to inspect via Convex dashboard instead)
```

**Verification on device** (ask Christian to confirm):
- [ ] Open the app. Background it. Walk around for ~3 minutes. Foreground the app.
- [ ] Within ~5 min, PostHog should show at least 1 `activity_recognition_transition` event with `shadow=true` attributed to Christian's driver id.

**Go/no-go**:
- If ≥1 transition event fired within 10 minutes of the first walk test → **go** to Step 2 (observation window).
- If 0 events after 30 minutes of movement → **no-go**: check device logcat (`adb logcat -s MotionService`), verify `ACTIVITY_RECOGNITION` permission is granted in Settings → Apps → Otoqa → Permissions, verify the app is running on `runtimeVersion: 1.5.0`, verify Google Play Services is installed + up to date. File a bug, do not proceed.

## Step 2 — 7-day shadow-mode observation

**Duration**: minimum **7 calendar days** of active driving. If Christian takes days off, extend the window accordingly — we need ≥7 days of real driving signal, not 7 wall-clock days.

**What to monitor** (check daily, by end-of-day):

| Metric | Source | Threshold | What a breach looks like |
|---|---|---|---|
| Transition count per driving hour | `activity_recognition_transition` count / active driving hours | 1 ≤ n ≤ 20 | n=0: AR isn't firing at all (Play Services issue? permission revoked?). n>20: false-positive storm (phone jostling in holder, OEM-specific motion noise) |
| Debounce-hit rate | `activity_recognition_transition` with `debounced=true` / total | < 30% | > 30%: 30s debounce is masking real transitions. May indicate driver style (lots of short stops) — note for tuning before live flip |
| Phantom rate | `activity_recognition_transition ENTER IN_VEHICLE` fired while device reports `battery.isCharging=true` AND device stationary >30min | < 5/driver/day | ≥ 5: overnight-parked false positives — device picked up phantom "in vehicle" while charging at home. Likely requires additional gating (e.g., hour-of-day filter) |
| `activity_recognition_fgs_restart` | PostHog event count | **0** (shadow mode must not start FGS) | >0: motion-service is NOT gating on shadow mode correctly. STOP, roll back to Step 0, investigate |

**Also monitor** (no hard threshold, but note any delta):
- `skipped_backgrounded` rate (must not regress vs. baseline)
- `location_queue_op_failed` + `location_queue_auto_reset` (must stay ~0)
- Battery drain on canary device (informal — driver reports)

**Daily check-in** (rollout owner, in `#mobile-canary` channel or equivalent):
```
Day N of 7 — Phase 1 shadow
Transitions: X (rate Y/hr)
Debounced: Z%
Phantoms: W/day
FGS restarts (must be 0): 0
Regressions: none
```

**Extension criteria**: if any of the thresholds are flirting with their limits by day 7 (e.g., debounce-hit rate 27-29%), extend observation another 3-5 days before the flip.

## Step 3 — Go/no-go review for live flip

**Who**: rollout owner + reviewer (see Participants table).

**Gate**: all four metrics from Step 2 within thresholds AND no regression in `skipped_backgrounded` / queue-health events.

**If no-go**: file a ticket with the failing metric. Do NOT flip. Two options depending on failure mode:
- Tunable (e.g., debounce window was too short for our real-world drivers): ship a follow-up PR adjusting the constants in `mobile/lib/motion-service.ts`, re-enter Step 2 after the new build lands.
- Fundamental (e.g., AR just isn't useful for long-haul trucking): accept FCM-only as the wake path, document the decision, close Phase 1 with AR permanently in shadow mode or disabled.

**If go**: proceed to Step 4.

## Step 4 — Flip to live (AR wake) on canary

```bash
# Flip ar_shadow_mode from "true" to "false" while keeping ar_wake_enabled="true".
# motion-service resolves the combination to mode='live': telemetry + debounced FGS restart.
npx convex run featureFlags:setFlagInternal '{"workosOrgId":"org_01KAEYJHZNV9KQCXF9FN9N3CCY","key":"ar_shadow_mode","value":"false"}'

# Verify: at this point ar_wake_enabled="true" AND ar_shadow_mode="false".
# Next AR transition on the canary device will trigger resumeTracking() after the 30s debounce.
```

**Verification**:
- [ ] Canary driver: end their current shift (if any) to force-kill the FGS cleanly. Then start a new shift. Walk for 3+ min. Expect PostHog `activity_recognition_fgs_restart success=true` event.
- [ ] `skipped_backgrounded` rate should drop below 3 per driver-shift within 24h (§ Phase 1 exit criteria).

## Step 5 — Flip FCM wake on canary (parallel with Step 4, any order)

```bash
# Enable the server-side fcmWake.sweep for Christian's org. Every 1 min the
# cron will scan active sessions > 2 min stale, find Christian's session,
# and dispatch a high-priority FCM push (provided his session has a
# pushTokenPlatform='android' pushToken registered).
npx convex run featureFlags:setFlagInternal '{"workosOrgId":"org_01KAEYJHZNV9KQCXF9FN9N3CCY","key":"fcm_wake_enabled","value":"true"}'
```

**Verification**:
- [ ] Check Convex dashboard logs — the next `fcm-wake-sweep` cron should log `scanned=N scheduled=M` where M > 0 iff Christian has an active session + valid pushToken + stale lastPingAt.
- [ ] Ask Christian to force-kill the app (Settings → Apps → Otoqa → Force Stop) while in a stationary state. Wait up to 2 min. FCM should deliver a wake push; the app should relaunch FGS silently. PostHog `fcm_wake_received` + `fcm_wake_resume_success` events should fire within ~2 min of the force-stop.

## Step 6 — 48-hour canary bake-in

**Duration**: 48 hours with all flags live (`ar_wake_enabled=true`, `ar_shadow_mode=false`, `fcm_wake_enabled=true`).

**Exit gates** (all must be met before expanding to more orgs):
- [ ] Zero new app crashes attributable to the changes (check Expo error reporting with filter `app_version >= 1.4.0` — see § Phase 1 exit criteria). Translation for `runtimeVersion`: filter events from builds on `runtimeVersion: 1.5.0` or later.
- [ ] `location_queue_op_failed` count = 0 (canary scope)
- [ ] `location_queue_auto_reset` count = 0 (canary scope)
- [ ] No new error classes in `activity_recognition_fgs_restart success=false` beyond `permission_denied` / `service_already_running`
- [ ] `skipped_backgrounded` rate stays below 3 per driver-shift
- [ ] `activity_recognition_fgs_restart success=true` rate ≥ 90% of all attempts
- [ ] `fcm_wake_resume_success` rate ≥ 90% of dispatched pushes
- [ ] `recordedToCreatedLagMs` p99 < 60s (verify from the `ping_ingested` sampled emit)

**If all gates pass**: proceed to Step 7.

**If any gate fails**: flip back to inert + open an incident ticket.
```bash
# Emergency rollback — takes effect within seconds on every live client
# (reactive flag subscription, see mobile/lib/feature-flags.ts applyFlagSnapshot).
npx convex run featureFlags:setFlagInternal '{"workosOrgId":"org_01KAEYJHZNV9KQCXF9FN9N3CCY","key":"ar_wake_enabled","value":"false"}'
npx convex run featureFlags:setFlagInternal '{"workosOrgId":"org_01KAEYJHZNV9KQCXF9FN9N3CCY","key":"fcm_wake_enabled","value":"false"}'
```

## Step 7 — Expand to additional orgs

**Scope**: one org at a time. Each new org goes straight to live mode (we've already validated the shadow-mode metrics on canary; no need to repeat) but observes the 48h bake-in gates in Step 6 scoped to that org.

**Commands** (substitute the target org's `workosOrgId`):
```bash
npx convex run featureFlags:setFlagInternal '{"workosOrgId":"<ORG_ID>","key":"ar_wake_enabled","value":"true"}'
npx convex run featureFlags:setFlagInternal '{"workosOrgId":"<ORG_ID>","key":"ar_shadow_mode","value":"false"}'
npx convex run featureFlags:setFlagInternal '{"workosOrgId":"<ORG_ID>","key":"fcm_wake_enabled","value":"true"}'
```

**Cadence**: add 1 org every 48h until either all orgs are enabled or a regression surfaces. The 48h spacing gives the bake-in enough room to catch org-specific issues (OEM diversity, fleet size effects, different driver behavior).

## Emergency rollback

Applies at any step. The reactive flag subscription (PR #109) means flag flips take effect within seconds on every live client:

```bash
# Disable BOTH capabilities org-wide (per-org — repeat for every affected org).
npx convex run featureFlags:setFlagInternal '{"workosOrgId":"<ORG_ID>","key":"ar_wake_enabled","value":"false"}'
npx convex run featureFlags:setFlagInternal '{"workosOrgId":"<ORG_ID>","key":"fcm_wake_enabled","value":"false"}'
```

**What this does NOT do**:
- Does NOT clear stored `pushToken` fields (harmless — sweep short-circuits on the flag check before reading them)
- Does NOT stop the cron itself (cron runs every minute regardless; it just finds no candidates to dispatch)
- Does NOT stop foreground GPS tracking, geofence evaluation, or any other pre-Phase-1 capability

**If the reactive subscription isn't working** (unlikely — but the fallback):
- Force-kill the app on affected devices. Cold start reads the flag cache fresh.
- Last resort: disable `fcm-wake-sweep` cron entirely by commenting it out in `convex/crons.ts` and redeploying. Requires a PR.

## Known gaps (flagged for follow-up, NOT blocking Phase 1e)

- **Dead-app AR wake**: PR #110 implemented AR with a dynamic, lifecycle-bound receiver. AR events only fire while the JS runtime is alive. The "force-kill, start driving, AR restart within 30s" exit criterion is NOT met by this rollout. FCM wake (2-min latency) covers the dead-app case today. If canary data shows FCM's ~2 min is too slow, a follow-up adds a static manifest receiver + `HeadlessJsTaskService` — scoped as a future PR, does not block the canary flip.
- **iOS wake path**: Phase 1 is Android-only. Server sweep filters `pushTokenPlatform='android'` — iOS session tokens are registered but ignored by the dispatch. Phase 4 will resolve the Option A (Firebase iOS SDK) vs B (server-side APNs HTTP/2) question before iOS sessions become wake-eligible.
- **Proguard / R8 keep rules**: deferred to a config-plugin PR. The first release build on `runtimeVersion: 1.5.0` MUST run a smoke test to confirm AR transitions still fire; if R8 strips symbols the fix is a small plugin PR. Internal-distribution preview APKs (used for canary) are not affected — only release builds.

## References

- Architecture doc: [`gps-tracking-architecture.md`](./gps-tracking-architecture.md) § Phase 1 Appendix
- Shipped PRs:
  - [#107](https://github.com/fescolero/Otoqa/pull/107) (1a) — server foundation
  - [#108](https://github.com/fescolero/Otoqa/pull/108) (1b) — FCM server send path
  - [#109](https://github.com/fescolero/Otoqa/pull/109) (1c) — mobile push-token + FCM receive + reactive flags
  - [#110](https://github.com/fescolero/Otoqa/pull/110) (1d) — otoqa-motion native module + motion-service
- Canary org (Christian): `org_01KAEYJHZNV9KQCXF9FN9N3CCY`
- Firebase project: `otoqa-95106` (package `com.otoqa.driver`)
- Convex dev deployment env: `FCM_SERVICE_ACCOUNT_JSON`
