# GPS Tracking Architecture & Maintenance Plan

**Status**: active architecture document — update whenever behavior or ownership changes.
**Primary audience**: the mobile engineer owning `mobile/lib/location-*.ts` and `convex/fcmWake.ts`. Secondary: dispatch leads, support, product.
**Companion docs**: [`location-queue-mmkv.md`](./location-queue-mmkv.md) (storage-layer design, shipped in PR #105).
**Source-of-truth for OEM quirks**: https://dontkillmyapp.com (third-party, community-maintained).

---

## 1. Purpose of this document

GPS tracking on modern Android (12+) is not a solved problem — Google and OEMs (especially Samsung) change background-execution rules annually, and every change can silently break tracking. Our drivers depend on continuous capture for customer SLAs. If the engineer who built our tracking stack leaves, their successor needs enough context to **diagnose, extend, and defend** the code without rebuilding the knowledge from scratch by reading every commit.

This document is that knowledge transfer. It explains:

- **Why** we chose this architecture (not just what we built)
- **What platform constraints** forced our hand
- **How** to debug, extend, and test each layer
- **When** each part needs maintenance
- **Who** owns ongoing responsibility and what the escalation path is

If you are reading this and about to touch any file in `mobile/lib/location-*.ts`, `mobile/lib/motion-service.ts`, `mobile/lib/fcm-handler.ts`, `mobile/lib/oem-settings.ts`, `convex/fcmWake.ts`, or `convex/featureFlags.ts` — **read this end to end first**. The counterintuitive platform rules (documented in § 4) will catch you if you don't.

---

## 2. History & incident record

The incidents that shaped this architecture. Brief; enough context that future decisions can be grounded in precedent rather than guesswork.

| Date | Incident | Root cause | Fix | Commit / PR |
|---|---|---|---|---|
| 2026-04-11 | Driver GPS silently stopped on Samsung (Android 16) | JVM GC destroyed `expo-sqlite`'s `NativeDatabase` between ops; retries against the dead handle all threw NPE | Fresh-connection-per-op pattern in `location-db.ts` (shipped via OTA `30acc7a8`) | Fix #8 |
| 2026-04-16 | Fix #8 regressed | OTA shipped cached-handle pattern again during an unrelated rewrite | Reintroduced fresh-connection pattern | [`36867c5`](https://github.com/fescolero/Otoqa/commit/36867c5) |
| 2026-04-19 | Phase-1-6 rewrite regressed Fix #8 again + introduced schema-drift bug | A rewrite of `location-db.ts` added `sessionId` migration but reintroduced cached `db` handle AND had a no-op `CREATE TABLE IF NOT EXISTS` path that stamped `user_version = 3` on a v1-schema database | PR #104 added schema-drift guard (`PRAGMA table_info` probe) | [`a0236d9`](https://github.com/fescolero/Otoqa/commit/a0236d9) |
| 2026-04-22–23 | Christian Lozano's device silently stopped syncing GPS | Compound of two issues: (a) schema-drift bug corrupted his local DB, so all inserts failed with `no such column: sessionId`; (b) his AsyncStorage fallback was working but never synced | PR #104 (schema guard) + PR #105 (MMKV migration, moves off SQLite entirely) | PR #105 |
| 2026-04-24 | Same driver, backgrounded-FGS kill on Android 12+ | OS killed foreground service while app was backgrounded; `watchPositionAsync` briefly outlived it; my heartbeat tried to re-register FGS from background → `ForegroundServiceStartNotAllowedException` (Android 12+ restriction) | PR #105 patch: heartbeat no-ops when `AppState !== 'active'`. Capture-layer recovery requires activity recognition + FCM wake-up (Phase 1 of this plan) | [`9de17d3`](https://github.com/fescolero/Otoqa/commit/9de17d3) |

**Pattern across incidents**: the platform keeps changing rules, and every rewrite without the context of *why* the previous design existed regressed something. This document exists to prevent the next regression.

---

## 3. Scope

### In scope

- Mobile GPS capture, local persistence, sync to Convex, wake-up after OS kill.
- Android (primary target — 12, 13, 14, 15, 16) and iOS (secondary — 16+).
- Samsung-specific OEM quirks (dominant device class in US trucking).
- Observability to detect regressions early.

### Out of scope (see § 13 for rationale)

- WorkManager as a primary capture mechanism.
- Third-party paid libraries (Transistor, Onfleet SDK, etc.) — explicitly rejected for vendor-lock and cost reasons. See § 9.
- Driver-facing tracking UI (owned by design/mobile-UI team).
- Dispatcher-side display of tracks (owned by web team).
- Route reconstruction / map-matching (owned by `googleRoads.ts` action).

---

## 4. Platform constraints — the "why"

This section documents the counterintuitive rules that force our architecture. **Do not skip this if you plan to modify the capture layer.**

### 4.1 Android 12+ foreground service start restrictions

Per [Google's `restrictions-bg-start` docs](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start):

> Beginning with Android 12 (API level 31), apps are not allowed to start foreground services while the app is running in the background, with a few specific exemptions.

An already-running FGS can **continue** in the background indefinitely as long as its notification is visible. But if the OS kills the FGS (memory pressure, OEM aggressive management, etc.), the app cannot restart it until it's in the foreground again.

**Exemptions that permit FGS start from the background** (the ones our architecture relies on — Google's canonical list in [`foreground-service-restricting-background-starts`](https://developer.android.com/develop/background-work/services/foreground-service-restricting-background-starts#exemptions) is the source of truth; we list here only the ones we use):

1. App transitions from a user-visible state (user opens the app, notification tap, widget tap)
2. **Geofencing or activity recognition transition event received** ← Phase 1 primary wake path (AR) and Phase 2 stationary-geofence fallback
3. **High-priority FCM data message received** ← Phase 1 secondary wake path
4. **`BOOT_COMPLETED` / `LOCKED_BOOT_COMPLETED` broadcast** ← Phase 3 reboot persistence
5. User disabled battery optimization for the app (via `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) ← already wired in `battery-optimization.ts`

**Underlying mechanism (for debugging)**: exemptions #2, #3, and #4 are all delivered via `BroadcastReceiver`. When a broadcast runs, the process briefly enters `PROCESS_STATE_RECEIVER`, which is the proc-state that grants the FGS-start window. Google names these specific broadcasts as exemptions for policy clarity — so developers have a "safe harbor" list rather than having to reason about proc-states. If Google tightens the broadcast-receiver proc-state rules in a future release (plausible given the trend), any of #2–#4 could become less reliable; we'd detect this via the canary matrix in § 10.

**On the "while-in-use" restriction (Android 14+)**: disabling battery optimization (#5 above) does NOT override the stricter rule for location-type FGS. A location FGS still needs the app to either (a) be in user-visible state, (b) be processing one of the allowed broadcasts (#2–#4), or (c) hold a visible-activity stack. This caught us early; the battery-opt dialog alone is not sufficient.

Google's docs enumerate additional exemptions we don't use (e.g. `SYSTEM_ALERT_WINDOW` overlay permission, device-owner / profile-owner apps, certain Bluetooth events) — they're not relevant to our architecture, so we don't enumerate them here. Check the official docs if you're considering expanding.

### 4.2 Android 14+ "while-in-use" permission restriction

On Android 14 (API 34) and above, starting a location-type FGS requires the app to satisfy one of the exemptions in § 4.1 #1–4 (user-visible transition, AR/geofence transition, high-priority FCM, or `BOOT_COMPLETED`). Exemption #5 (battery-optimization disabled) does NOT override the while-in-use restriction for location-type FGS. This caught us early; the battery-opt dialog alone is not sufficient — that's why our architecture layers the broadcast-driven wake paths on top of it.

### 4.3 OEM-specific layers (Samsung, Xiaomi, etc.)

On top of stock Android's rules, several OEMs ship **additional** battery/background management that ignores the standard FGS protections:

- **Samsung "Sleeping Apps"**: any app not foregrounded for an OEM-defined window (3–7 days depending on OneUI version and user settings) gets force-stopped regardless of FGS state. Drivers who work a consistent shift cadence hit this on weekends.
- **Samsung "Auto-optimize daily"**: nightly sweep can kill running FGSes
- **Samsung "Restricted" background default**: certain Galaxy models default new apps to "Optimized" or "Restricted" battery usage, which kills FGS aggressively even with system exemption
- **Xiaomi MIUI "Autostart"**: similar deny-list
- **Huawei, Oppo, Vivo, OnePlus**: each has variants

**No developer-side code workaround exists** for these layers. Only user-settings changes (via our `oem-settings.ts` helper in Phase 3) can exempt our app.

Reference: https://dontkillmyapp.com maintains a catalog. Check quarterly.

### 4.4 iOS background constraints

iOS has a different model — no FGS, but strict background execution budgets.

- **`UIBackgroundModes: location`** (our `app.json`) grants continuous background location updates as long as the app subscribes to `CLLocationManager.startUpdatingLocation`.
- iOS will throttle location updates if the app abuses the privilege (background CPU > threshold).
- **Significant-change location API** and **region monitoring** are low-power alternatives that wake the app periodically.
- **Silent APNs pushes** (`content-available: 1`) are iOS's equivalent of FCM high-priority — the server-push wake path for iOS.

We use `expo-location` which wraps CLLocationManager; Phase 4 adds the significant-change + region monitoring + silent APNs for parity with Android's activity-recognition wake path.

### 4.5 Key takeaway for future modifiers

**You cannot "just retry" a dead FGS.** The OS blocks it. Every recovery path in our architecture goes through one of the exemptions in § 4.1. If a future Android version changes these rules, this doc and our code both need to be updated — that's what the quarterly maintenance cadence is for (§ 10).

---

## 5. System architecture

### 5.1 Layer overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      CAPTURE LAYER (mobile)                     │
│   Foreground service + watchPositionAsync + Activity Recognition │
│   Adaptive GPS rate based on motion state                        │
├─────────────────────────────────────────────────────────────────┤
│                    WAKE-UP LAYER (mobile + server)              │
│   Activity Recognition transitions (primary)                     │
│   FCM / APNs silent push (secondary)                             │
│   BOOT_COMPLETED receiver (reboot)                               │
│   Foreground return (user-initiated)                             │
├─────────────────────────────────────────────────────────────────┤
│                     STORAGE LAYER (mobile)                      │
│   MMKV queue with corruption auto-recovery (shipped)             │
│   Migration from legacy SQLite + AsyncStorage fallback           │
├─────────────────────────────────────────────────────────────────┤
│                      SYNC LAYER (server)                        │
│   Convex batchInsertLocations with dedup                         │
│   Retry budget (escape hatch for pathological pings)             │
├─────────────────────────────────────────────────────────────────┤
│                     OBSERVABILITY (cross-cut)                   │
│   PostHog event stream with queue_backend super-property         │
│   Dashboards + alerts on KPI drift                               │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 Dataflow (happy path)

1. Driver starts shift → `startSessionTracking` or `startLocationTracking`
2. Foreground service starts with `location` type, persistent notification
3. `Location.watchPositionAsync` subscribes; callback fires per GPS fix
4. Each fix → `insertLocation` → MMKV (via `location-storage` dispatcher)
5. Sync interval (2 min) + per-save inline sync → `syncUnsyncedToConvex`
6. `batchInsertLocations` mutation: dedup + insert into `driverLocations` table
7. Dispatcher web UI reactively updates via Convex query subscriptions

### 5.3 Dataflow (background-kill recovery)

1. App backgrounded; OS kills FGS (Samsung, Doze, low memory)
2. **Mobile-side wake path**: driver starts moving → `ActivityRecognitionClient` broadcasts `IN_VEHICLE` transition → `motion-service.ts` receives it via our registered `BroadcastReceiver` → AR transition exemption permits FGS start (§ 4.1 #2) → tracking resumes
3. **Server-side wake path (backup)**: Convex cron detects stale session (no ping for 2+ min) → sends FCM high-priority data message → mobile `fcm-handler.ts` receives → FCM high-priority exemption permits FGS start (§ 4.1 #3) → tracking resumes
4. Either path: captured ping written to MMKV → synced to Convex on next interval

### 5.4 Dataflow (reboot recovery)

1. Device reboots mid-shift
2. Android fires `BOOT_COMPLETED` broadcast
3. Our registered `BroadcastReceiver` runs → reads tracking state from MMKV → `BOOT_COMPLETED`-broadcast exemption permits FGS start (§ 4.1 #4) → tracking resumes
4. Any captured pings from before the reboot remain in MMKV (durable); sync catches up

---

## 6. Layer-by-layer design

### 6.1 Capture layer

**Primary file**: `mobile/lib/location-tracking.ts`
**Native module**: `mobile/modules/otoqa-motion` (Phase 1 addition — wraps Android ActivityRecognitionClient + iOS CMMotionActivityManager)

#### Foreground service / location configuration

**Android** (foreground service):
```
foregroundServiceType="location"
FOREGROUND_SERVICE_LOCATION permission
ACCESS_BACKGROUND_LOCATION permission (granted by driver via OS prompt)
POST_NOTIFICATIONS permission (Android 13+, runtime)
Notification channel: managed internally by expo-location (cannot override via public API; see Phase 1 Mobile Native)
LocationRequest.Priority: PRIORITY_HIGH_ACCURACY (IN_VEHICLE) | PRIORITY_BALANCED_POWER_ACCURACY (ON_FOOT) | PRIORITY_LOW_POWER (STILL)
```

**iOS** (CLLocationManager):
```
UIBackgroundModes: location (app.json)
activityType: CLActivityTypeOtherNavigation   // iOS-only; improves battery treatment, reduces throttling
pausesLocationUpdatesAutomatically: false     // iOS-only; without it, iOS pauses when stationary
desiredAccuracy: kCLLocationAccuracyBest (IN_VEHICLE) | kCLLocationAccuracyNearestTenMeters (ON_FOOT) | kCLLocationAccuracyHundredMeters (STILL)
```

**Why these settings**:
- `location` FGS type (Android): the only type that's exempted for continuous background access per § 4.1–4.2.
- `CLActivityTypeOtherNavigation` (iOS): tells iOS this is a nav use case. No Android equivalent exists — Android does not expose an activity-type hint on `LocationRequest`.
- `pausesLocationUpdatesAutomatically: false` (iOS): without it, iOS auto-pauses updates when stationary and only resumes on motion. We control pause/resume explicitly via activity recognition.
- Notification channel (Android 8+): declared and managed internally by `expo-location`. The public `foregroundService` option (`LocationTaskServiceOptions`) does not accept a `channelId` argument, so we don't override it. Drivers who mute the FGS notification would also mute any transactional notifications sharing whatever channel Expo chose — we accept this limitation unless field complaints warrant a native module.

#### Motion-state adaptive sampling (Phase 2)

GPS is the dominant battery consumer. Adaptive sampling cuts drain ~40–60% on a typical shift:

| Motion state | Accuracy | Time interval | Distance filter | Rationale |
|---|---|---|---|---|
| `IN_VEHICLE` | High | 30s | 250m | Reconstruct route at truck speeds |
| `ON_FOOT` / `ON_BICYCLE` | Balanced | 60s | 50m | Walking check-in context; accuracy less critical |
| `STILL` (<10 min) | Balanced | 60s | 50m | Short stops don't need full sampling |
| `STILL` (>10 min) | Lowest | 5 min | 100m | Parked/idle; maintain heartbeat only |
| `TILTING` / `UNKNOWN` | unchanged | unchanged | unchanged | Don't churn on noisy transitions |

**Implementation detail**: debounce transitions. Raw activity events are noisy (e.g., red light briefly shows STILL). Require 30-second persistence before reconfiguring GPS.

**Configurable per org** via `trackingTuning` Convex table — fleets in dense urban environments may want different thresholds than long-haul trucking.

#### Stationary geofence pattern (Phase 2)

When `IN_VEHICLE → STILL` held >10 min:
1. Drop a 100m geofence at current location via Google Play Services
2. Subscribe to geofence exit events
3. When driver starts moving again, geofence exit fires → geofencing transition exemption (§ 4.1 #2) permits FGS restart
4. Tear down geofence, restore IN_VEHICLE GPS config

This is a backup to activity recognition — redundant on paper but catches cases where AR misses a transition (e.g., vehicle briefly tilted but not enough to trip motion detection).

### 6.2 Wake-up layer

**Primary files**: `mobile/lib/motion-service.ts`, `mobile/lib/fcm-handler.ts`, `convex/fcmWake.ts`, Android `BOOT_COMPLETED` receiver

#### Activity Recognition (primary wake path)

**Why primary**: no server dependency, free (Google Play Services), works even during Convex/FCM outages.

**Mechanism**:
- `ActivityRecognitionClient.requestActivityTransitionUpdates` subscribes to `STILL ↔ IN_VEHICLE` transitions specifically in Phase 1; Phase 2 expands subscription to include `ON_FOOT` and `ON_BICYCLE` for adaptive sampling (§ 6.1 table). `TILTING` and `UNKNOWN` remain unsubscribed permanently — noise
- Android broadcasts the transition event with a `PendingIntent` we registered
- Our `BroadcastReceiver` wakes the app just long enough to process the event
- On `IN_VEHICLE` entry: start FGS via the AR-transition exemption (§ 4.1 #2)

**On confidence filtering**: verified against Google's Activity Recognition docs — `ActivityTransitionEvent` does NOT expose a confidence score. Confidence is only on `DetectedActivity` from the older periodic `requestActivityUpdates` API. Google's transition API performs its own ML filtering server-side and emits only "confident" transitions, so explicit app-side confidence gating is not available and not necessary. Our false-positive defenses instead are: (a) rate-limit FGS restart to at most once per 60s per session, (b) a 30-second transition debounce (same debounce used for adaptive sampling in Phase 2 — applied here too), (c) the phantom-rate monitoring in the shadow-mode gate.

**Per-OEM behavior**: some OEMs (notably Samsung on older OneUI) can throttle activity recognition broadcasts. Phase 5's device matrix should verify this works on each supported OEM.

#### FCM high-priority push (secondary wake path)

**Why secondary, not primary**: for long-haul trucking, motion transitions are rare (driver gets in truck once, drives 6 hours). AR alone would miss silent-FGS-kill events during continuous driving. FCM closes this gap by triggering server-side.

**Server cron design** (scales to 100K+ drivers — see § 7):

1. Maintain `driverSessions.lastPingAt` timestamp, updated by `batchInsertLocations` with 15-second debounce (write amplification controlled)
2. Cron every 60s: index query `by_active_lastping` for sessions where `status = 'active'` AND `lastPingAt < now - 120s`. Sweep does NOT filter on `fcmLastPushAt` — the 5-min cooldown lives inside the `sendWake` mutation to avoid read-then-write races across concurrent sweeps
3. For each stale session: schedule a parallel `sendWake` action
4. `sendWake` wraps an internal mutation that atomically re-reads `fcmLastPushAt` and `fcmBackoffUntil`, aborts if either blocks, and patches `fcmLastPushAt = now` before the action fires the HTTP POST
5. POST FCM HTTP v1 with `{ priority: 'high', data: { type: 'wake_tracking', sessionId } }`

**Why this design scales**: reads only stale sessions via the index, not all active sessions. At 10K drivers, steady-state the cron reads 10–200 rows/tick depending on how many are silent. See § 7 for the scaling rationale.

**Mobile handler**:
- `expo-notifications` receives the data message
- Handler runs in background priority slot (Android allows brief execution for high-priority pushes)
- Starts FGS via the high-priority FCM exemption (§ 4.1 #3)
- Captures one fresh GPS fix via `captureCurrentLocation`
- Fires `syncUnsyncedToConvex` immediately

**Throttle**: `fcmLastPushAt` cooldown prevents more than one FCM push per 5 min per session. Protects against wake-storm if a device consistently fails to resume (e.g., bricked device).

#### BOOT_COMPLETED receiver (reboot persistence — Phase 3)

**Why separate from main app init**: reboot happens while the app is not running. We need a native BroadcastReceiver that wakes the JS context.

**Implementation**:
- Declared in `AndroidManifest.xml` with `RECEIVE_BOOT_COMPLETED` permission (already present)
- Android 14+: receiver must be `exported=true` with explicit intent filter
- Receiver reads tracking state via native MMKV (not JS — JS isn't running yet)
- If `state.isActive`: uses the `BOOT_COMPLETED` broadcast exemption (§ 4.1 #4) to start FGS
- Logs event for telemetry (fires once the JS context catches up)

#### Foreground-return recovery (already shipped)

When the driver opens the app after a silent window:
1. `AppState 'active'` event fires
2. `restartForegroundServices` runs:
   - Force-cycles the BG task (stops + restarts to reconnect stale JS callback)
   - Runs one-shot `syncUnsyncedToConvex` if queue has buffered pings
3. Tracking resumes, any buffered data flushes

This is the always-reliable last-resort path; every other wake mechanism falls back to this when the driver eventually opens the app.

### 6.3 Storage layer — see [`location-queue-mmkv.md`](./location-queue-mmkv.md)

Already shipped in PR #105. Brief recap:
- MMKV-backed queue (mmap, no native DB handle to lose)
- Corruption auto-recovery (2 consecutive op failures → clearAll)
- Atomic-or-restart migration from legacy SQLite + AsyncStorage fallback
- Feature-flag gated rollout via Convex `featureFlags` table
- Dispatcher at `mobile/lib/location-storage.ts` routes between SQLite/MMKV during canary; deleted in Phase 5 cleanup

### 6.4 Sync layer

**Primary files**: `convex/driverLocations.ts` (server), `mobile/lib/location-tracking.ts:syncUnsyncedToConvex` (client)

#### Client-side retry with escape hatch

On sync failure:
- Row stays in MMKV queue (durable)
- `syncAttempts` field increments
- Escape hatch: after 20 attempts OR 48h age, ping is purged (`purgeStaleUnsynced`) — prevents infinite loops on permanently-rejected pings

#### Server-side dedup

`batchInsertLocations` mutation dedups on `(sessionId, recordedAt)` for session-mode pings and `(loadId, recordedAt)` for legacy load-mode. Prevents duplicate rows if the mobile retries a batch that partially succeeded.

**Known limitation** (previously documented): the "clean boundary" shortcut skips per-ping dedup when there's no overlap with the stored range. If mobile sends a batch with duplicates within it, they all get inserted. This was intentional to save reads; consider revising if duplicate volume is meaningful.

### 6.5 Observability layer

**Primary file**: `mobile/lib/analytics.ts`

All tracking events emit a `queue_backend` super-property (`mmkv` | `sqlite_legacy`) so PostHog can slice by backend during the canary.

Event catalog (complete — every event referenced elsewhere in this doc must appear here):

- **Foreground GPS lifecycle** (shipped):
  - `watch_location_received` / `watch_location_filtered` / `watch_location_saved` / `watch_location_error`
- **Background task lifecycle** (shipped):
  - `bg_task_fired` / `bg_task_result` / `bg_task_error` / `bg_task_reregistered`
  - `skipped_backgrounded` — heartbeat no-op when `AppState !== 'active'` (FGS-from-background restriction guard)
- **MMKV queue health** (shipped):
  - `location_queue_op_failed` / `location_queue_auto_reset` / `location_queue_evicted` / `location_queue_migrated`
- **Phase 0 additions**:
  - `tracking_skewed_ping_rejected` — server-side clock-skew guard fired
  - `location_queue_encryption_migrated` — MMKV plaintext → encrypted migration completed
  - `location_queue_internal_dup_observed` — server saw duplicates inside a single client batch (validates the § 6.4 clean-boundary shortcut assumption)
- **Phase 1 additions**:
  - `activity_recognition_transition` with `{ from, to, confidence, shadow }`
  - `activity_recognition_fgs_restart` with `{ success, error }`
  - `fcm_wake_received` with `{ type, sessionId }`
  - `fcm_wake_resume_success` with `{ pingCaptured }`
  - `fcm_wake_session_inactive` — push arrived but session had ended in the meantime (no FGS start)
  - `fcm_dispatched` — server emitted a wake push (success/failure/error bucket)
  - `session_last_ping_patched` — 15s-debounced `lastPingAt` write
  - `push_token_registered` with `{ platform, rotated }` / `push_token_cleared` with `{ reason }`
- **Phase 3 additions**:
  - `boot_completed_restart` with `{ success, delayMs }` — BOOT_COMPLETED-triggered FGS start
  - `oem_settings_opened` with `{ manufacturer, successful }`
- **Phase 4 additions (iOS)**:
  - `ios_region_transition` with `{ direction: 'enter' | 'exit' }` — region-monitoring transition fired
  - `ios_significant_location_wake` — `startMonitoringSignificantLocationChanges` woke the app
  - `apns_wake_received` — silent APNs `content-available` push arrived (mirror of `fcm_wake_received` on Android)
- **Cross-cut KPI computation**:
  - `ping_ingested` with `{ recordedToCreatedLagMs }` — computed server-side as `Date.now() - recordedAt`. **Sampled at 1%** (configurable via `featureFlags.ping_ingested_sample_rate`) to keep PostHog event volume bounded at scale — a raw per-ping event at 100K drivers would flood the event pipeline. Sole source of the `recordedToCreatedLagMs` metric referenced in § 10.4 and § 12. Sampling is statistically sound for p50/p99 aggregates; raise the rate temporarily during incident investigation

**Dashboards** (PostHog saved views — set up in Phase 5):
1. **Capture gap rate per OEM per day** (Android-only — `skipped_backgrounded` has no iOS equivalent): `skipped_backgrounded` count / `watch_location_received` count
2. **Activity recognition wake success** (Android-only; iOS equivalent is `CMMotionActivityManager` wake): % of `activity_recognition_fgs_restart` with `success=true`
3. **Wake delivery rate** (cross-platform via FCM HTTP v1 → APNs): % of sent pushes that result in `fcm_wake_received` within 2 min
4. **Queue health** (cross-platform): `location_queue_op_failed` and `location_queue_auto_reset` counts (must stay ~0)
5. **Sync lag** (cross-platform, from sampled `ping_ingested`): `recordedToCreatedLagMs` p50 and p99, split by platform + OEM
6. **Reboot recovery** (Android-only — no iOS equivalent): count of `boot_completed_restart` events

---

## 7. Scalability design

The design scales to 100K+ drivers without changes to the architecture. The two load-bearing decisions are:

1. **Indexed sweep** — the FCM wake cron reads only stale sessions via `by_active_lastping`, not all active sessions. Steady-state read count is proportional to the number of silent sessions, not total fleet size.
2. **Debounced session patches** — `lastPingAt` is updated at most once per 15s per session, bounding write amplification per driver. At 100K drivers this keeps session-table churn at ~20M writes/day, which is within Convex's documented throughput envelope.

Platform dependencies (FCM, APNs, Google Play Services, Firebase Test Lab free tier) carry no per-driver cost.

Engineering capacity, not infrastructure spend, is the real line item — documented in § 9 (dependencies) and § 11 (ownership).

---

## 8. Resilience posture

Critical during outages — multi-national fleets can't afford cascading failures.

### Dependency map (every line is a potential single-point-of-failure)

| Dependency | Purpose | What happens if down | Mitigation |
|---|---|---|---|
| Google Play Services (Activity Recognition) | Primary wake path | Motion transitions don't fire | FCM fallback still works when Convex + Firebase are up |
| Firebase FCM | Secondary wake path for Android | Can't remotely wake backgrounded apps | AR still wakes on motion transitions; drivers opening app still works |
| Apple APNs | Secondary wake path for iOS | Can't remotely wake iOS apps | iOS CMMotionActivityManager still fires; user foreground-return works |
| Google Play / App Store | Native app distribution | Can't ship new native builds | expo-updates OTA covers JS changes; deferred native fixes |
| Convex (our backend) | Sync target, feature flags, cron | No new pings land; flag fetch returns stale | **Local MMKV queue buffers up to 10K pings (oldest-first eviction at cap) OR 48h age (then `purgeStaleUnsynced` drops them).** In typical mixed driving 10K pings = ~40h; during a long STILL period it can stretch to weeks. Either ceiling triggers bounded loss, not a crash. |
| Network cellular | All sync + wake | Everything remote stops | Same — local buffer carries through. Note: Doze mode defers our 2-min sync to the OS maintenance window (~every 15 min on idle devices). Data isn't lost, just batched. |

**Critical property**: no dependency's failure cascades. Every layer degrades gracefully. Worst case is "can't auto-wake from server," which is bounded by driver-opens-app fallback.

### Stress-test scenarios we've designed against

- 48h offline (MMKV queue preserves up to ~10K pings then starts evicting oldest)
- FCM outage combined with active driver in continuous motion (AR wake still works)
- OS-version-change surprise (quarterly test matrix catches regressions)
- Samsung ships a new "optimization" feature (OEM settings helper in Phase 3 directs drivers to fix)
- Mobile process killed + device rebooted (BOOT_COMPLETED handler in Phase 3 recovers)

### Scenarios we can't fully defend against (explicit)

- Driver's phone dies or has no data for >48h: pings older than 48h are purged by `purgeStaleUnsynced` (configurable; current limit protects MMKV from unbounded growth)
- Driver uninstalls and reinstalls mid-shift: all local state gone; tracking starts fresh
- Convex outage >48h combined with continuous shift: queue fills up, oldest pings evicted with `location_queue_evicted` telemetry

These are documented as acceptable trade-offs; no additional engineering is planned.

---

## 9. Dependencies & vendor strategy

### Principle: minimize paid third-party dependencies

Rationale (from product direction, 2026-04-24):
- **Multi-national ambition** means per-driver licensing scales unfavorably at fleet size
- **Resilience concerns** — recent AWS/SaaS outages have impacted tracking-dependent apps
- **Engineering staff available** to own the code long-term

### What we DO depend on

| Dependency | Type | Free? | Lock-in risk | Alternative if needed |
|---|---|---|---|---|
| Google Play Services | Platform API | Yes | Very low (Google-maintained, stable for 10+ years) | None — required on every Android device |
| Firebase Cloud Messaging | Platform service (free) | Yes | Very low | Apple APNs directly for iOS; no realistic Android alt |
| Apple APNs | Platform service (free, w/ developer program) | Yes (after $99/yr fee) | Very low | None for iOS |
| Convex | Backend-as-a-service | Paid (our existing costs) | Medium (code tied to their API) | Self-hosted Postgres + custom backend (~3 months to migrate if required) |
| MMKV (react-native-mmkv) | Open-source NPM package | Yes | Low (open source, active maintenance) | SQLite (what we came from); JSON+AsyncStorage as last resort |
| expo-location, expo-task-manager | Open-source NPM packages | Yes | Low (Expo-maintained) | Native CoreLocation / Android LocationManager directly |

### What we explicitly DO NOT depend on

- **Transistor react-native-background-geolocation**: evaluated; rejected due to $400/year licensing + vendor-lock. Would save ~6 weeks of initial engineering but costs more over 5-year TCO.
- **HyperTrack, Samsara SDK, similar commercial fleet SDKs**: same reasons.
- **Sentry** as primary observability: currently on PostHog; can evaluate later but not in scope for Phase 1–5.
- **AWS services directly**: Convex abstracts hosting; we don't have AWS SDK dependencies in mobile or server code.

### Adding a new dependency — checklist

Before any new NPM or native dependency is added to `mobile/package.json` or `convex/package.json`:

1. Is it actively maintained? (commits in last 3 months, open issues responded to)
2. Is there a license cost now or at scale?
3. What's the vendor-outage blast radius?
4. Is there a simpler alternative (roll our own, use existing deps)?
5. Will it survive an Android or iOS major version bump without our intervention?

---

## 10. Maintenance plan

This is not a build-it-and-forget system. Platform changes annually, OEMs ship new quirks, and telemetry drifts. Documented maintenance cadence:

### 10.1 Quarterly cadence (Jan / Apr / Jul / Oct, first week)

**Owner**: mobile lead (see § 11)

Checklist (see Appendix A for the full details — this is a summary):
- Run full device-matrix test suite against latest build
- Review Android Developer release notes since last quarter
- Review Apple iOS release notes since last quarter
- Check https://dontkillmyapp.com for new OEM quirks added
- Verify OEM settings helper intents still work on newest Samsung OneUI / Xiaomi MIUI
- Review PostHog dashboards for metric drift
- Update this document if new learnings emerge

### 10.2 Event-driven triggers

| Trigger | Action | Owner |
|---|---|---|
| Android/iOS developer preview announced (March, June) | Read release notes for background/location/FGS changes, test on preview, queue work | Mobile lead |
| Android/iOS public release | Dedicated compatibility sprint (1–2 weeks), bump targetSdkVersion / deployment target | Mobile team |
| New Samsung / Pixel / OEM flagship launches | Add to device lab, run regression, verify OEM settings helper | Mobile lead |
| PostHog alert fires (see § 10.4) | Investigate, incident triage, hotfix if needed | On-call rotation |
| New hire on mobile team | Walk through this doc + codebase; pair on one quarterly cycle before solo ownership | Mobile lead |

### 10.3 Tools & infrastructure

| Tool | Purpose | Cost |
|---|---|---|
| **Firebase Test Lab** | Automated device-matrix tests on real hardware (CI integration) | Free tier covers our scale |
| **Physical device lab** (in-house) | Manual testing on problematic OEMs (Samsung dominant) | ~$2K one-time for 3–4 devices; replace every 2–3 years |
| **Maestro** | Declarative mobile E2E test framework (selected over Detox for simplicity) | Free (open source) |
| **GitHub Actions** | CI pipeline | Included in GitHub plan |
| **Expo error reporting** (or **Sentry** free tier) | Native crash reports | $0 at our scale |
| **dontkillmyapp.com** | OEM quirk reference (third-party catalog) | Free |

### 10.4 Alerts & on-call

Alerts flow from PostHog → Slack/email to the on-call engineer. Thresholds:

| Alert | Threshold | Severity | Response |
|---|---|---|---|
| `skipped_backgrounded` event rate | >10% of shifts on any OEM for 24h sustained | P1 | Investigate within 4 business hours |
| `location_queue_op_failed` count | >0 on any device in 24h | P0 | Immediate investigation |
| `location_queue_auto_reset` count | >0 on any device in 24h | P1 | Investigate within 4 business hours |
| Activity recognition wake success rate | <80% for >2h | P1 | Investigate within 4 business hours |
| `bg_task_reregistered success=false` rate spike | 3× the 7-day baseline | P2 | Review next business day |
| New OS version crash signature in Expo errors | Any | P0 | Immediate investigation |

### 10.5 Runbook references

Common issue → runbook procedure. The runbooks themselves live in Notion/wiki (out of scope for this repo doc), but the categories are:

1. **Driver reports GPS stopped** → runbook `rb-tracking-stale`
2. **PostHog alert for capture gap** → runbook `rb-capture-regression`
3. **New Android/iOS version about to ship** → runbook `rb-os-compat-sprint`
4. **New OEM model support request** → runbook `rb-oem-onboard`
5. **FCM delivery failures spike** → runbook `rb-push-delivery`

---

## 11. Ownership & escalation

### Named roles

- **Mobile tracking-stack owner** (1 senior engineer, named in CODEOWNERS): primary decision-maker for changes to `mobile/lib/location-*.ts`, `mobile/lib/motion-service.ts`, `mobile/lib/fcm-handler.ts`, `mobile/lib/oem-settings.ts`, `convex/fcmWake.ts`. Leads quarterly maintenance cycle.
- **On-call rotation** (2–3 engineers): first-line response to PostHog alerts. Rotating weekly.
- **Mobile lead / EM**: escalation for cross-team conflicts, prioritization disputes, incident postmortems.
- **Product / Dispatch liaison**: quarterly review on real-world field issues reported by drivers or dispatchers.

### CODEOWNERS entry

Add to `.github/CODEOWNERS` (or equivalent):
```
mobile/lib/location-*.ts      @tracking-stack-owner
mobile/lib/motion-service.ts  @tracking-stack-owner
mobile/lib/fcm-handler.ts     @tracking-stack-owner
mobile/lib/oem-settings.ts    @tracking-stack-owner
mobile/modules/otoqa-motion/  @tracking-stack-owner
convex/fcmWake.ts             @tracking-stack-owner
convex/featureFlags.ts        @tracking-stack-owner
mobile/docs/gps-tracking-architecture.md  @tracking-stack-owner
mobile/docs/location-queue-mmkv.md        @tracking-stack-owner
```

### Knowledge transfer on handover

When the current owner departs or transitions:
1. 2-week pair rotation with the new owner
2. New owner shadows one full quarterly maintenance cycle
3. New owner runs at least one P1 or P2 incident response solo before being marked primary
4. CODEOWNERS entry updated

---

## 12. Success metrics (KPIs)

**P0 — blocking for any release to production**

- `skipped_backgrounded` events per driver-shift < 3
- `location_queue_op_failed` rate = 0

**P1 — tracked weekly, investigated on drift**

- `watch_location_received` gaps > 10 min per driver-shift < 1
- `recordedToCreatedLagMs` p99 < 60 seconds

**P2 — tracked monthly**

- Activity recognition FGS-restart success rate ≥ 95%
- FCM wake delivery rate ≥ 98% (within 2 min of dispatch)
- Battery drain per 8-hour shift ≤ 40% on reference Samsung Galaxy S24

**P3 — tracked quarterly, adjusted per operating reality**

- Time from Android/iOS release → verified compatibility ≤ 4 weeks
- Support tickets per 100 drivers per month related to tracking < 2
- Zero tracking-related P0 incidents per quarter in steady state

---

## 13. Explicitly out-of-scope approaches (with rationale)

Future contributors may be tempted to implement these. This section documents why we chose not to:

| Approach | Why we rejected |
|---|---|
| **WorkManager as primary capture** | 15-minute minimum periodic interval. Can't catch short motion events reliably. Use as last-resort fallback only, not primary. |
| **Always-on PARTIAL_WAKE_LOCK** | A location-type FGS with its persistent notification already places us in the OS-permitted wake state we need. Holding `PARTIAL_WAKE_LOCK` on top of that is redundant, bypasses Doze/App Standby optimizations, and risks a Play Store review question about necessity even though no specific Play policy names it. Don't add it. |
| **HTTP polling from mobile** | Massive battery drain. Doesn't actually keep FGS alive in background. |
| **Subscribing to all activity transitions** | Noise. Phase 1 starts with `STILL ↔ IN_VEHICLE` only. Phase 2 expands to `ON_FOOT` and `ON_BICYCLE` to support adaptive sampling (§ 6.1 table). `TILTING` and `UNKNOWN` remain unsubscribed permanently — they're noise, not signal. |
| **Geofence every stop on a load (as the sole justification for a persistent Location FGS)** | Google is steering developers away from using geofencing to justify a persistent Location FGS on Android 14+. Their [foreground service types docs](https://developer.android.com/develop/background-work/services/fgs-types#location) now explicitly say: *"If your app needs to be triggered when the user reaches specific locations, consider using the geofence API instead."* Play Store reviewers scrutinize the `location` FGS declaration and may reject apps whose only FGS justification is geofence transitions — the expectation is to use the Geofencing API standalone (which wakes the app via broadcast without a persistent FGS). We're fine because our FGS justification is **continuous high-frequency tracking during driving**, not geofencing; our stationary-geofence pattern (Phase 2) is a *recovery mechanism*, not the primary use case. Do not expand geofence usage beyond that without a Play Store review conversation. |
| **Third-party paid fleet SDK** (Transistor, etc.) | Vendor-lock, per-driver cost at scale, resilience concerns (vendor outages). See § 9. |
| **Restart FGS via fire-and-forget retry loop** | Android 12+ blocks it. Only the specific exemptions in § 4.1 work. |
| **`START_STICKY` service type** | Incompatible with `foregroundServiceType: location`. The OS manages FGS restart via different mechanisms. |
| **Direct native SQLite (avoiding expo-sqlite)** | Reinventing the wheel. MMKV is strictly simpler for our append-only queue use case. |

---

## 14. Glossary

- **FGS**: Foreground Service — Android's mechanism for long-running tasks with a persistent notification. Required for background GPS.
- **AR**: Activity Recognition — Google Play Services API that detects motion states (STILL, IN_VEHICLE, ON_FOOT, etc.).
- **FCM**: Firebase Cloud Messaging — Google's push notification service for Android. Only path for server-triggered wake on Android.
- **APNs**: Apple Push Notification service — iOS equivalent of FCM.
- **MMKV**: Tencent's mmap-backed key-value store. Our local GPS ping queue backend.
- **OTA**: Over-the-Air update — JS-bundle updates via `expo-updates` without requiring an app store release.
- **Runtime version**: Expo's versioning for native/JS compatibility. Bumping prevents old native apps from receiving incompatible JS bundles.
- **Exemption** (FGS-start): one of the specific events enumerated in Google's [`foreground-service-restricting-background-starts#exemptions`](https://developer.android.com/develop/background-work/services/foreground-service-restricting-background-starts#exemptions) docs that Android permits as a source for starting a foreground service from the background (§ 4.1).
- **While-in-use permission**: Android 14+ category that includes location, camera, microphone. Subject to stricter FGS-start rules (§ 4.2).
- **Doze mode**: Android's idle-battery-saving mode. Suspends most background work but permits FGS with notification.
- **App Standby Buckets**: Android's classification of apps by usage frequency. Less-used apps get more aggressive background restrictions.
- **Sleeping Apps**: Samsung-specific additional layer on top of stock Android's battery management. Force-stops apps after an OEM-defined window of no foreground use — varies from ~3 to ~7 days depending on OneUI version and user settings (§ 4.3).

---

## 15. References

### Official platform docs

- [Android: Restrictions on starting a foreground service from the background](https://developer.android.com/develop/background-work/services/foreground-service-restricting-background-starts)
- [Android: Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)
- [Android: Doze and App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby)
- [Google Play: Foreground service declarations](https://support.google.com/googleplay/android-developer/answer/13392821)
- [Google: Activity Recognition API](https://developers.google.com/location-context/activity-recognition)
- [Apple: Background modes for iOS apps](https://developer.apple.com/documentation/xcode/configuring-background-execution-modes)
- [Apple: CMMotionActivityManager](https://developer.apple.com/documentation/coremotion/cmmotionactivitymanager)

### Third-party references

- [dontkillmyapp.com](https://dontkillmyapp.com) — community catalog of OEM-specific quirks
- [Expo: BackgroundTask](https://docs.expo.dev/versions/latest/sdk/background-task/)
- [Expo: Location](https://docs.expo.dev/versions/latest/sdk/location/)
- [Expo: TaskManager](https://docs.expo.dev/versions/latest/sdk/task-manager/)

### Internal

- [`mobile/docs/location-queue-mmkv.md`](./location-queue-mmkv.md) — storage-layer design
- [`mobile/docs/gps-ping-attribution.md`](./gps-ping-attribution.md) — if created during Phase 1
- PR [#104](https://github.com/fescolero/Otoqa/pull/104) — schema-drift guard
- PR [#105](https://github.com/fescolero/Otoqa/pull/105) — MMKV migration + battery-opt + heartbeat
- PR [#106](https://github.com/fescolero/Otoqa/pull/106) — Phase 0 storage hardening (encryption + boot-state + clock-skew guard + typed flag accessors)
- PR [#107](https://github.com/fescolero/Otoqa/pull/107) — Phase 1a GPS wake-up server foundation (schema + ingest debounce + pushTokens API)

---

## Appendix A — Implementation checklist

The actionable todo list. Use this as a work-tracking checklist; the narrative above is the "why" for each item.

### A.0 Verification state (as of 2026-04-23 against main)

This checklist has been verified against the current codebase. The following is confirmed true today — no implementer needs to re-verify these unless significant time has passed:

- Convex crons use `crons.interval(...)` or `crons.cron(...)` — see [`convex/crons.ts:7`](../../../convex/crons.ts)
- `batchInsertLocations` is at [`convex/driverLocations.ts:361`](../../../convex/driverLocations.ts) with args `{ locations, organizationId }`; does NOT currently patch `driverSessions`
- `driverSessions.status` literal values are `'active' | 'completed'` — see [`convex/schema.ts:2087`](../../../convex/schema.ts)
- `featureFlags.value` is `v.string()` — all flag values serialize to strings; only key in use today is `gps_queue_backend`
- `resolveAuthenticatedDriver` returns a `Doc<'drivers'>` including `organizationId` — see [`convex/driverMobile.ts:66`](../../../convex/driverMobile.ts)
- `api.driverSessions.getActiveSession` is auth-gated via `resolveAuthenticatedDriver` — see [`convex/driverSessions.ts:310`](../../../convex/driverSessions.ts)
- `syncUnsyncedToConvex` is at [`mobile/lib/location-tracking.ts:1739`](../lib/location-tracking.ts), calls `api.driverLocations.batchInsertLocations`
- MMKV ping queue uses `createMMKV({ id: 'otoqa-location-queue' })` — see [`mobile/lib/location-queue.ts:42`](../lib/location-queue.ts); no encryption today
- iOS location options `activityType: OtherNavigation` and `pausesUpdatesAutomatically: false` are set at all 5 call-sites in `location-tracking.ts`
- `@react-native-firebase/messaging` is NOT installed; only `expo-notifications@0.32.16` — decision required per Phase 1 Mobile Native
- `mobile/modules/` directory does not exist; `otoqa-motion` is the first local Expo module in this project
- `signOut()` fires from 4 call-sites; no centralized `logout()` helper exists yet
- Existing `app.json` permissions already include `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `RECEIVE_BOOT_COMPLETED`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. NEW additions: `ACTIVITY_RECOGNITION` (both variants), `POST_NOTIFICATIONS`
- Analytics emit pattern: typed helpers like `trackWatchLocationReceived(...)` wrapping `capture(event, props)` — see [`mobile/lib/analytics.ts:20,287`](../lib/analytics.ts)
- `queue_backend` super-property is already registered via `registerQueueBackend` — no need to add
- Feature-flags client has retry-on-token-refresh already — see [`mobile/lib/feature-flags.ts:108-125`](../lib/feature-flags.ts); real-time Convex subscription is net-new work

External platform / library API facts verified against primary docs:
- **Google Activity Recognition** ([`developers.google.com/location-context/activity-recognition`](https://developers.google.com/location-context/activity-recognition)): `ActivityTransitionEvent` does NOT expose a confidence score. Confidence is only on `DetectedActivity` from the periodic `requestActivityUpdates` API (which we do not use). Our false-positive defense is debounce + rate-limit + shadow-mode phantom monitoring — not confidence gating. Any PR that tries to add a confidence gate on transitions is based on a misunderstanding — see § 6.2
- **Expo Location `foregroundService` object** ([`docs.expo.dev/versions/latest/sdk/location`](https://docs.expo.dev/versions/latest/sdk/location/)): accepts only `notificationTitle`, `notificationBody`, `notificationColor`, `killServiceOnDestroy`. Does NOT accept a `channelId`. The FGS notification channel is managed internally by `expo-location`; overriding it would require a native module
- **Google Play policy on `PARTIAL_WAKE_LOCK`**: the Device & Network Abuse policy does not contain a specific prohibition. Don't state "Play policy prohibits" in code comments or commit messages; the correct reason to avoid always-on `PARTIAL_WAKE_LOCK` is that the location FGS already puts us in the required OS wake state — anything extra is redundant and works against Doze/App Standby

If you are implementing this plan more than 30 days after the date above, re-run the verification pass before trusting this section.


### Pre-work (unblocks everything)

- [ ] Named mobile tracking-stack owner — 1 senior engineer; CODEOWNERS entries added per § 11
- [ ] Firebase service account created with FCM send scope; JSON stored as Convex env var `FCM_SERVICE_ACCOUNT_JSON`. **Single shared Firebase project for dev today.** If prod traffic volume or quota isolation requires it later, split into separate projects and rotate per-environment env vars; not needed for initial rollout
- [ ] Firebase project: upload APNs auth key so the SERVER-side FCM HTTP v1 can route to iOS tokens (the key lives in Firebase console, not on the device)
- [ ] Add `google-services.json` (Android) to `mobile/` and wire into `app.json`. **Under Path B**, `GoogleService-Info.plist` is NOT required on iOS because we are not adding Firebase iOS SDK — APNs is handled natively by Apple + `expo-notifications`
- [ ] **Canary convention** (applies to every feature flag in this plan): "canary" = any org that has a row in the `featureFlags` table for the flag in question. Default absent = disabled. To canary a new capability on a specific driver's org, insert the flag row for that org id. To expand, insert rows for more orgs. No dedicated "is_canary" boolean — presence of the flag row IS the enrollment signal. Current canary org for ongoing rollouts: Christian's org (`org_01KAEYJHZNV9KQCXF9FN9N3CCY`)
- [ ] Device lab decision finalized — default recommendation: Firebase Test Lab (automated CI) + 3 physical Samsung Galaxy devices for manual testing
- [ ] **Runtime version discipline** — every PR that touches `mobile/modules/otoqa-motion/`, `mobile/android/`, `mobile/ios/`, or adds/removes a native dependency MUST bump `expo.runtimeVersion` in `app.json`. Add a CI check that fails the PR if native files changed without a version bump. Repeated past incident: OTA shipped to older native clients that lacked the new module → crash loop

### Phase 0 — Storage hardening (before layering new capability)

Small follow-ups on the already-shipped MMKV queue. Keep scope tight — do not fold in unrelated cleanup.

- [ ] Feature flag schema additions (write keys to the existing `featureFlags` table, do not invent a new table). **Verified**: `featureFlags.value` is `v.string()` at [`convex/schema.ts:2854`](../../../convex/schema.ts); `getForOrg` returns `Record<string, string>` at [`convex/featureFlags.ts:37`](../../../convex/featureFlags.ts). All flag values are **serialized as strings** — the mobile client parses them. New keys:
  - [ ] `queue_encryption_enabled` — stored as `"true"` / `"false"`, default absent = false
  - [ ] `location_retention_days` — stored as `"90"`, default absent = 90
  - [ ] `ping_ingested_sample_rate` — stored as `"0.01"`, default absent = 0.01
  - [ ] Mobile-side parse helpers in `mobile/lib/feature-flags.ts` — add typed accessors (`asBool`, `asNumber`) so every caller doesn't re-implement parsing
- [ ] MMKV encryption-at-rest **only for the ping queue instance**:
  - [ ] Generate a per-install random key on first launch, persist via `expo-secure-store` (backed by Keystore / Keychain)
  - [ ] Pass `encryptionKey` to `createMMKV({ id: 'otoqa-location-queue' })` — the ping queue only
  - [ ] **Do NOT encrypt** the boot-state MMKV instance introduced next; native BroadcastReceivers cannot read Keystore-backed secrets before user unlock, so encrypting boot state would break Phase 3 reboot recovery
  - [ ] **Atomic migration** — mirror the Phase-1→MMKV pattern already shipped:
    - Write marker `encryption_state='migrating'` into the plaintext store before draining
    - Drain plaintext pings into the encrypted instance
    - Flip marker to `encryption_state='encrypted'` only after the drain completes
    - Delete plaintext files only after the marker flip
    - On boot: if marker says `migrating`, re-run the migration (resume-safe, idempotent)
  - [ ] Feature-flag `queue_encryption_enabled` for safe rollout — default off, flip after canary
  - [ ] Emit `location_queue_encryption_migrated` telemetry with `{ pingsDrained, durationMs }`
- [ ] Separate unencrypted boot-state MMKV instance (prerequisite for Phase 3 reboot recovery):
  - [ ] `createMMKV({ id: 'otoqa-boot-state' })` — no encryption
  - [ ] Stores only: `{ isActive: boolean, sessionId: string | null, driverId: string | null, lastWriteAt: number }`
  - [ ] Contains zero PII / no location data — only tracking-state flag
  - [ ] Written on every `start/stopLocationTracking` call
  - [ ] Read from the native `BroadcastReceiver` on `BOOT_COMPLETED` (Phase 3)
- [ ] Clock-skew guard in `batchInsertLocations` (server):
  - [ ] Reject pings with `recordedAt > serverNow + 5min` OR `recordedAt < serverNow - 48h`
  - [ ] Emit `tracking_skewed_ping_rejected({ driverId, skewMs, direction })` telemetry
  - [ ] Return the rejected ping ids in the mutation response so the client can act on them
  - [ ] Client reaction: add a `permanentlyFailed: boolean` field to the MMKV ping record. Set it when the server returns a rejection. `getUnsyncedLocations` excludes rows where `permanentlyFailed=true` so they never retry. They're still counted for queue-size purposes and purged by the 48h age escape hatch
- [ ] Data retention job:
  - [ ] `convex/crons.ts` daily scheduled mutation: delete `driverLocations` rows with `recordedAt < now - retentionMs` (retention window read from `featureFlags.location_retention_days`, default 90)
  - [ ] Batched delete (500 rows/tick) to stay under Convex mutation limits
- [ ] Multi-device same-driver dedup note: add a comment in `driverLocations.ts` documenting current `(sessionId, recordedAt)` dedup assumes one active device per session; revisit if telemetry shows duplicate-pair collisions
- [ ] Clean up stale SQLite verbiage in `syncUnsyncedToConvex` log strings — [`mobile/lib/location-tracking.ts:1802`](../lib/location-tracking.ts) ("(SQLite data safe)") and `:1810` ("retained in SQLite for later") still reference the old backend. Replace with backend-agnostic phrasing. Grep the file for other `SQLite` mentions while you're in there
- [ ] Batch-internal dedup observability (validates § 6.4 shortcut):
  - [ ] In `batchInsertLocations`, detect duplicates within the incoming batch (same `recordedAt` twice) and emit `location_queue_internal_dup_observed({ count, sessionId })`
  - [ ] Decision point: if count > 0.1% of inserts over 7 days, add per-ping dedup

**Exit criteria — Phase 0**:

- [ ] Encryption migration verified: fresh install + migrated-from-plaintext install both read/write correctly
- [ ] Interrupted-migration resume: force-kill the app mid-drain, relaunch, verify migration completes and no pings lost
- [ ] Boot-state MMKV is unencrypted and readable before user unlock (manually verified by locked-device ADB read)
- [ ] Force-skew device clock +1h, verify server rejects pings with `tracking_skewed_ping_rejected` telemetry AND the client marks them `permanentlyFailed` so they don't retry
- [ ] Retention job: seed rows at `recordedAt = now - 120d`, run cron, assert they are deleted; rows at `now - 80d` remain
- [ ] No regression against the **pre-Phase-0 baseline** for `skipped_backgrounded` count and `location_queue_op_failed` count (rates must be ≤ the 7-day median before Phase 0 shipped)

### Phase 1 — Activity Recognition + FCM wake-up

**Sub-phase slicing** (shipping as 5 sequential PRs instead of one bundle — keeps each reviewable, isolates the first runtime-version bump to PR 1d, and lets server changes bake before native touches the client):

- **1a — Server foundation** (PR [#107](https://github.com/fescolero/Otoqa/pull/107), merged / in review): schema + indexes, `batchInsertLocations` lastPingAt debounce + sampled `ping_ingested` emit, Phase 1 feature-flag keys, `pushTokens.ts` register/clear mutations. Dark (no callers yet).
- **1b — FCM server send path**: `fcmWake.sweep` cron + `sendWake` action with atomic cooldown mutation, FCM HTTP v1 POST + error-code handling (backoff, token clear), cron registration, `FCM_SERVICE_ACCOUNT_JSON` env wiring. Still dark until 1c arrives.
- **1c — Mobile push-token + FCM receive**: `mobile/lib/push-token.ts` + `mobile/lib/fcm-handler.ts` (Path B: `expo-notifications` only), `mobile/lib/logout.ts` centralization refactor, session-active guard, real-time flag subscription, Android `POST_NOTIFICATIONS` permission, Proguard rules. Flip `fcm_wake_enabled` on canary → end-to-end FCM wake works without AR.
- **1d — `otoqa-motion` native module**: first Expo local module, Kotlin AR wrapper, broadcast receiver, JS bridge, runtime `ACTIVITY_RECOGNITION` permission, dev-mock `fakeTransition`, `motion-service.ts` with debounce + rate-limit. Ships behind `ar_shadow_mode=true` only. **First native module → bumps `expo.runtimeVersion`.**
- **1e — Shadow→live flip**: after ≥7 days shadow-mode on canary with § Phase-1 thresholds met (1–20 transitions/hr, debounce-hit < 30%, phantoms < 5/driver/day), flip `ar_shadow_mode=false` + `ar_wake_enabled=true`. PR contents: exit-criteria evidence doc + flag flips.

**Pre-work done as of PR 1a**: `FCM_SERVICE_ACCOUNT_JSON` Convex env var set (dev); `google-services.json` Firebase config downloaded (package `com.otoqa.driver`, project `otoqa-95106`) — awaiting placement + `app.json` wire-up in PR 1c. APNs key upload deferred to Phase 4 prep (requires Option A-vs-B decision — see PR 1a review thread for the spec inconsistency noted there).

**Server (Convex)**:

- [x] Verify prerequisites exist in the current codebase before starting (should already be true — confirm by grep):
  - [x] `resolveAuthenticatedDriver` exported from [`convex/driverMobile.ts`](../../../convex/driverMobile.ts) — auth helper for Clerk mobile JWTs (phone claim → driver row)
  - [x] `api.driverSessions.getActiveSession` query exists (already consumed by [`mobile/app/(app)/_layout.tsx`](../app/(app)/_layout.tsx))
- [x] Schema: add `driverSessions.lastPingAt: v.optional(v.number())` *(PR 1a)*
- [x] Schema: add `driverSessions.fcmLastPushAt: v.optional(v.number())` *(PR 1a)*
- [x] Schema: add `driverSessions.fcmBackoffUntil: v.optional(v.number())` — unix ms; `sendWake` skips while `now < fcmBackoffUntil`. Reset to undefined on first successful send *(PR 1a)*
- [x] Schema: add `driverSessions.fcmConsecutiveFailures: v.optional(v.number())` — counter, used to compute backoff (e.g. `1min << min(failures, 6)` caps at ~64 min) *(PR 1a)*
- [x] Schema: add `driverSessions.pushToken: v.optional(v.string())` + `pushTokenPlatform: v.optional(v.union(v.literal('ios'), v.literal('android')))` + `pushTokenUpdatedAt: v.optional(v.number())` *(PR 1a)*
- [x] Schema: add index `by_active_lastping` on `['status', 'lastPingAt']`. **Verified**: `driverSessions.status` is `v.union(v.literal('active'), v.literal('completed'))` at [`convex/schema.ts:2087`](../../../convex/schema.ts). Sweep filter selects `status === 'active'`. The existing `by_status_started` index does not collide with the new one *(PR 1a)*. Also added `by_push_token` on `['pushToken']` to make `clearPushToken` O(1) instead of scanning active sessions
- [x] Patch `batchInsertLocations` in `convex/driverLocations.ts`: *(PR 1a)*
  - [x] Compute max `recordedAt` per session group after inserts
  - [x] Debounce — only patch session if `maxRecordedAt > session.lastPingAt + 15000`
  - [x] When patching, emit `session_last_ping_patched({ sessionId, newLastPingAt })` for observability
  - [x] Write the patch in the same mutation
  - [x] Per-ping **sampled** emit `ping_ingested({ recordedToCreatedLagMs })` = `Date.now() - recordedAt`. Gate on `Math.random() < ping_ingested_sample_rate` (default 0.01 from Phase 0 flag). Sole source of the `recordedToCreatedLagMs` KPI in § 10.4 / § 12
- [x] Per-capability feature flags in `convex/featureFlags.ts` — add keys: `ar_wake_enabled`, `fcm_wake_enabled`, `ar_shadow_mode` (fire telemetry without starting FGS) *(PR 1a — mobile constants in `mobile/lib/feature-flags.ts`; Convex-side the "registration" is just inserting flag rows, no schema change required)*
- [x] Create `convex/pushTokens.ts`: *(PR 1a)*
  - [x] `registerPushToken({ token, platform })` mutation — auth-gated via `resolveAuthenticatedDriver`; stores on active session. **Spec clarification**: the original text said "or driver row if no active session", but the schema additions only added push-token fields to `driverSessions`. PR 1a takes the simpler interpretation — no-op + telemetry (`no_active_session` reason) when no active session, and the mobile client re-registers on the next tracking-start. A driver-row fallback would require a schema addition not otherwise motivated
  - [x] `clearPushToken({ token })` internal mutation — called on FCM `UNREGISTERED` / `INVALID_ARGUMENT` response *(caller not wired until PR 1b)*
- [ ] Create `convex/fcmWake.ts`:
  - [ ] `internal.fcmWake.sweep` cron handler — scan `by_active_lastping`, take(500), schedule sends; gate on `fcm_wake_enabled` flag per org. **Do NOT check the 5-min cooldown in sweep** — defer to the mutation inside `sendWake` to avoid read-then-write races across concurrent sweeps
  - [ ] `internal.fcmWake.sendWake({ sessionId, driverId })` action — wraps an internal mutation that atomically re-reads `fcmLastPushAt` AND `fcmBackoffUntil`, aborts if either blocks, and patches `fcmLastPushAt=now` before the action fires the HTTP POST. This is the only writer to `fcmLastPushAt`
  - [ ] POST FCM HTTP v1; emit `fcm_dispatched({ sessionId, outcome: 'success' | 'failure', error? })` — the "outcome" field is the `success/failure/error bucket` referenced in § 6.5
  - [ ] Payload must stay under FCM's 4KB limit — keep it to `{ type, sessionId }` only, do not add fleet/load metadata here
  - [ ] Handle FCM error codes:
    - On `UNREGISTERED` / `INVALID_ARGUMENT` / `SENDER_ID_MISMATCH`: call `clearPushToken`, reset `fcmConsecutiveFailures=0`
    - On `QUOTA_EXCEEDED` / `UNAVAILABLE` / `INTERNAL`: increment `fcmConsecutiveFailures`, set `fcmBackoffUntil = now + (60_000 << Math.min(fcmConsecutiveFailures, 6))` (1min → 64min ceiling)
    - On success: reset `fcmConsecutiveFailures=0`, clear `fcmBackoffUntil`
- [ ] Register cron in [`convex/crons.ts`](../../../convex/crons.ts) — use `crons.interval('fcm-wake-sweep', { minutes: 1 }, internal.fcmWake.sweep, {})` (matches the shipped pattern at `crons.ts:7,11,41`). Either `crons.interval` or `crons.cron` with a crontab string works; `interval` is more idiomatic for fixed cadence
- [x] Store `FCM_SERVICE_ACCOUNT_JSON` as Convex env var (one-time, see Pre-work) *(dev deployment, 2026-04-24; prod still pending until the live flip)*

**Checkpoint — server standalone** (do not proceed to native until green):

- [ ] Unit test: `batchInsertLocations` patches `lastPingAt` when debounce threshold exceeded; does NOT patch when under
- [ ] Integration test: insert a backdated session row with `lastPingAt > 120s ago`, run `fcmWake.sweep`, assert `sendWake` scheduled exactly once
- [ ] Manual Convex dashboard check: `by_active_lastping` index exists and has correct field order
- [ ] Manually invoke `sendWake` with a real dev FCM token; confirm FCM Console shows delivery success
- [ ] Verify `fcmLastPushAt` cooldown — invoke sweep twice in <5 min, assert only one dispatch
- [ ] Feature-flag gating: set `fcm_wake_enabled=false` for test org, run sweep, assert zero dispatches
- [ ] Invalid-token path: call `sendWake` with a junk token, assert `clearPushToken` fires and session row `pushToken` is cleared
- [ ] `registerPushToken` auth check: unauthenticated caller rejected

**Mobile native (Kotlin)**:

> **Starting state verified**: `mobile/modules/` directory does NOT exist today — `otoqa-motion` will be the first local Expo module in the project. `expo-modules-core@3.0.29` is already a transitive dep (available via [`mobile/package-lock.json`](../package-lock.json)), but local-module config must be added to `app.json` as part of this phase. `@react-native-firebase/messaging` is NOT installed; the project uses `expo-notifications@0.32.16` only.

- [ ] Create new local Expo module scaffold `mobile/modules/otoqa-motion/` and register it in `app.json` under the appropriate plugin config (first module in the project — set up the convention now)
- [ ] Wrap `ActivityRecognitionClient.requestActivityTransitionUpdates` (Google Play Services)
- [ ] Register `BroadcastReceiver` for transition events
- [ ] Bridge transitions to JS via `Event` emitter
- [ ] Permissions in `app.json` — verified current state in [`mobile/app.json:43-53`](../app.json); these are already present: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `RECEIVE_BOOT_COMPLETED`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. **NEW additions needed**:
  - [ ] `com.google.android.gms.permission.ACTIVITY_RECOGNITION` (legacy; Android ≤ 9)
  - [ ] `android.permission.ACTIVITY_RECOGNITION` (Android 10+, runtime)
  - [ ] `android.permission.POST_NOTIFICATIONS` (Android 13+, runtime — required for the FGS notification to render)
- [ ] Runtime permission request flow for `ACTIVITY_RECOGNITION` (Android 10+) and `POST_NOTIFICATIONS` (Android 13+); handle denial with a non-blocking rationale banner
- [ ] FGS notification channel — verified against [Expo docs](https://docs.expo.dev/versions/latest/sdk/location/): `Location.startLocationUpdatesAsync`'s `foregroundService` object supports only `notificationTitle`, `notificationBody`, `notificationColor`, `killServiceOnDestroy`. **It does NOT accept a `channelId` option**, so we cannot direct the FGS to a custom channel through the public API. Implication: `expo-location` manages its own notification channel internally; we accept the default. A future enhancement to give drivers a separate mute toggle for the FGS notification would require a native Expo module wrapping `LocationManager` directly — out of scope for Phase 1. No code change needed here; this line exists only to record why we didn't add a channel
- [ ] **Push notification library — Path B locked** (use `expo-notifications` alone; no new native dep, no runtime-version bump):
  - [ ] Use `Notifications.getDevicePushTokenAsync()` to retrieve the FCM token (Android) / APNs token (iOS). Expo's `DevicePushToken.type` field identifies the platform — use it to set `pushTokenPlatform` on the server
  - [ ] Register the background data-message handler via `Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK_NAME, ...)` + `TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK_NAME, ...)` — this is the iOS/Android-unified hook for server-side wake data messages
  - [ ] On app foreground, refresh the token via `getDevicePushTokenAsync()` and compare against the secure-store cache (Path B has no `onTokenRefresh` callback — we compensate with an on-foreground diff-check)
  - [ ] Path B constraint: if field data later shows the on-foreground refresh misses token rotations (rare but possible), upgrade to Path A (`@react-native-firebase/messaging`) in a dedicated follow-up PR — that upgrade bumps `expo.runtimeVersion` and requires a full EAS rebuild
- [ ] Proguard / R8 keep rules in `android/app/proguard-rules.pro`:
  - [ ] `-keep class expo.modules.otoqamotion.** { *; }`
  - [ ] `-keep class com.google.android.gms.location.** { *; }`
- [ ] Verify release-build smoke test still fires AR transitions (R8 strip regression guard)

**Checkpoint — native bridge alone**:

- [ ] Dev build succeeds (`eas build --profile development --platform android`)
- [ ] Manual log-test: subscribe, walk with phone, confirm transition events log in Logcat
- [ ] Permission denial path: reject `android.permission.ACTIVITY_RECOGNITION` in OS dialog, confirm app does not crash and logs a clear error
- [ ] Verify no new crashes in Expo error reporting across a 1-hour background soak

**Mobile JS**:

- [ ] Create `mobile/lib/push-token.ts` (Path B implementation — uses `expo-notifications` APIs only):
  - [ ] Persist the last-registered token in `expo-secure-store` under key `otoqa.pushToken.lastRegistered` (so we can compare against fresh token on app open and skip re-registering when unchanged — saves writes)
  - [ ] On tracking start: call `Notifications.getDevicePushTokenAsync()` → returns `{ type: 'fcm' | 'apns', data: string }`. Call `registerPushToken({ token: data, platform: type === 'fcm' ? 'android' : 'ios' })` mutation if the token differs from the secure-store cache
  - [ ] On app foreground (via `AppState 'active'` listener): re-fetch via `getDevicePushTokenAsync()` and diff-check against the cache — this is Path B's stand-in for `onTokenRefresh`. If changed, re-register and update the cache
  - [ ] Hook into the Clerk sign-out flow. **Verified**: there is no single `logout()` helper today; `signOut()` is called from 4 sites:
    - [`mobile/app/(app)/role-switch.tsx:172`](../app/(app)/role-switch.tsx)
    - [`mobile/app/(app)/(driver-tabs)/more.tsx:157`](../app/(app)/(driver-tabs)/more.tsx)
    - [`mobile/app/(app)/_layout.tsx:427`](../app/(app)/_layout.tsx)
    - [`mobile/app/(app)/owner/(tabs)/profile.tsx:31`](../app/(app)/owner/(tabs)/profile.tsx)
  - [ ] Preferred: introduce a `mobile/lib/logout.ts` helper that (1) clears the push-token secure-store entry, (2) calls `resetLocationQueue`, (3) calls Clerk `signOut()`. Refactor all 4 sites to use it. Locking this in now prevents future sign-out additions from forgetting the cleanup
- [ ] Create `mobile/lib/motion-service.ts`:
  - [ ] Register AR transitions on tracking start — subscribe to `STILL ↔ IN_VEHICLE` **only** (other activity types are noise for trucking, per § 6.2)
  - [ ] **No confidence gate** — `ActivityTransitionEvent` does not expose confidence per Google's docs (see § 6.2). False-positive defense is rate + debounce instead, below
  - [ ] 30-second debounce: if a `STILL → IN_VEHICLE` transition is followed by `IN_VEHICLE → STILL` within 30s, treat it as noise and do NOT start FGS
  - [ ] Rate limit: at most one FGS restart per 60s per session. If another transition fires inside the window, log an `activity_recognition_transition` with a `rateLimited=true` flag and ignore
  - [ ] Gate behavior on `ar_wake_enabled` flag; if `ar_shadow_mode` is true, fire telemetry only and do NOT start FGS
  - [ ] `STILL → IN_VEHICLE` listener: verify FGS registered, start if not (via AR-transition exemption § 4.1 #2)
  - [ ] `IN_VEHICLE → STILL` listener: record timestamp (for stationary geofence in Phase 2 + for the debounce check)
  - [ ] Unregister on `stopLocationTracking`
- [ ] Create `mobile/lib/fcm-handler.ts` (despite the name, uses `expo-notifications` APIs — Path B):
  - [ ] Foreground listener: `Notifications.addNotificationReceivedListener((notification) => ...)` — reads `notification.request.content.data.type === 'wake_tracking'`
  - [ ] Background listener: `Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK_NAME)` paired with `TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK_NAME, ({ data, error }) => ...)` — same payload inspection
  - [ ] Gate on `fcm_wake_enabled` flag (locally cached, same pattern as queue backend flag)
  - [ ] **Session-active guard**: before starting FGS, call `api.driverSessions.getActiveSession` via `ConvexHttpClient` (same pattern used by feature-flags.ts). Verify the result is non-null AND `_id` matches the `sessionId` on the wake payload. If the driver clocked out between cron dispatch and push delivery, emit `fcm_wake_session_inactive` and return without touching FGS
  - [ ] On valid `wake_tracking`: start FGS if needed, capture fresh fix, trigger sync
- [ ] Emulator / simulator dev-mock path:
  - [ ] Detect `__DEV__ && isEmulator()` at boot
  - [ ] Expose a dev-only `fakeTransition(to: 'IN_VEHICLE' | 'STILL')` on the module so Maestro and manual devs can drive the state machine
  - [ ] Gate behind `EXPO_PUBLIC_MOTION_MOCK=1` env to prevent accidental use in release
- [ ] Verify per-platform location config (§ 6.1) is actually applied in `location-tracking.ts`:
  - [ ] iOS: `activityType: Location.ActivityType.OtherNavigation` and `pausesUpdatesAutomatically: false` on `Location.startLocationUpdatesAsync` options. These are iOS-only (no Android equivalent exists)
  - [ ] Android: correct `LocationRequest` priority per motion state (per § 6.1 Android table)
  - [ ] Regression assertion (runtime log or test) so a future refactor can't silently drop these
- [ ] Real-time kill-switch path for feature flags:
  - [ ] Extend `mobile/lib/feature-flags.ts` to subscribe to `featureFlags.getForOrg` as a Convex reactive query during active tracking (not just cold-start cache refresh)
  - [ ] On flag change observed, update the in-memory cache and re-evaluate gates in `motion-service` and `fcm-handler` (unregister AR / drop FCM handler if newly disabled)
  - [ ] This makes P0 kill-switches effective within seconds instead of the next cold start
- [ ] Wire all three into `mobile/app/_layout.tsx` root init (push-token → motion-service → fcm-handler)
- [ ] Add analytics events:
  - [ ] `activity_recognition_transition` with `{ from, to, shadow, debounced?, rateLimited? }` — no `confidence` field (API doesn't provide one)
  - [ ] `activity_recognition_fgs_restart` with `{ success, error }`
  - [ ] `fcm_wake_received` with `{ type, sessionId }`
  - [ ] `fcm_wake_resume_success` with `{ pingCaptured }`
  - [ ] `push_token_registered` with `{ platform, rotated }`
  - [ ] `push_token_cleared` with `{ reason }`

**Shadow-mode rollout (required intermediate step)**:

Before flipping `ar_wake_enabled=true`, run the system in shadow mode for ≥7 days on the canary org:

- [ ] `ar_shadow_mode=true` and `ar_wake_enabled=false` — AR fires `activity_recognition_transition` telemetry but does NOT start FGS
- [ ] Review PostHog after ≥7 days, gate on concrete thresholds:
  - [ ] Transition event count per driving hour is between 1 and 20 (sanity: drivers shouldn't see zero, and a flood >20/hr indicates false positives)
  - [ ] Debounce-hit rate (`debounced=true`) < 30% of raw transitions — indicates the 30s debounce is doing useful work but isn't masking everything
  - [ ] "Phantom" rate: `STILL → IN_VEHICLE` transitions fired while the device reports `battery.isCharging=true` AND stationary >30 min must be < 5 per driver per day (empirically this is the overnight-parked false-positive signature)
- [ ] Only then: flip `ar_shadow_mode=false`, `ar_wake_enabled=true`

**Exit criteria** (all must pass before tagging Phase 1 done):

- [ ] Samsung Galaxy test: force-kill FGS, start driving, verify AR-triggered restart within 30s
- [ ] Pixel (stock Android) test: same procedure, verify AR-triggered restart within 30s
- [ ] FCM path test: force-kill FGS stationary, verify FCM arrives within 2 min and triggers restart
- [ ] AR disabled test: disable Google Play Services AR (dev settings), verify FCM path alone still recovers tracking
- [ ] FCM down test: simulate FCM failure (network block), verify AR path alone still recovers
- [ ] Push-token rotation test: force token refresh (clear app data / reinstall), verify new token registers within 60s of next app open
- [ ] Invalid-token cleanup: verify a cleared token on the server does not retry repeatedly (no FCM wake-storm)
- [ ] Kill-switch test: flip `fcm_wake_enabled=false`, confirm no further dispatches within 2 minutes
- [ ] Real-time flag refresh test: with tracking active, flip `ar_wake_enabled=false` server-side; verify mobile unsubscribes from AR within 30s without a cold start
- [ ] Session-active guard test: dispatch a wake, immediately end the session on mobile before the push arrives; confirm `fcm_wake_session_inactive` fires and FGS does NOT start
- [ ] Concurrent-sweep race test: trigger `fcmWake.sweep` twice in the same tick on a stale session; confirm exactly one `fcm_dispatched` (mutation cooldown holds atomically)
- [ ] `recordedToCreatedLagMs` metric appears in PostHog and p99 < 60s during canary
- [ ] Debounce test: inject a rapid `STILL → IN_VEHICLE → STILL` sequence in dev-mock (two transitions <30s apart); assert FGS does NOT start, but `activity_recognition_transition debounced=true` fires
- [ ] Rate-limit test: inject two `STILL → IN_VEHICLE` transitions 20s apart; assert exactly one FGS restart attempt, and the second emits `activity_recognition_transition rateLimited=true`
- [ ] Shadow-mode observation complete (≥7 days on canary, no phantom transitions)
- [ ] Canary 48h bake-in on 1 driver with flags flipped live; expansion requires ALL of:
  - [ ] Zero new app crashes attributable to the changes (check Expo error reporting with filter `app_version >= 1.4.0`)
  - [ ] `location_queue_op_failed` count = 0
  - [ ] `location_queue_auto_reset` count = 0
  - [ ] No new error classes in PostHog's `activity_recognition_fgs_restart` with `success=false` reasons beyond `permission_denied` and `service_already_running`
- [ ] PostHog: `skipped_backgrounded` rate drops below 3 per driver-shift on canary
- [ ] PostHog: `activity_recognition_fgs_restart success=true` rate ≥ 90%
- [ ] PostHog: `fcm_wake_resume_success` rate ≥ 90% of dispatched pushes
- [ ] No new `location_queue_op_failed` events introduced

### Phase 2 — Battery-adaptive capture

- [ ] Add feature flag `adaptive_sampling_enabled` — default off at launch; flip per org after canary
- [ ] **Expand AR subscription** — Phase 1 only subscribed to `STILL ↔ IN_VEHICLE` transitions. Phase 2 adds `ON_FOOT` and `ON_BICYCLE` (full § 6.1 motion-state table). `TILTING` and `UNKNOWN` stay unsubscribed (noise, per § 6.1). Update the native module's `ActivityTransitionRequest` to include the new states
- [ ] Implement motion-state → GPS config mapping (§ 6.1) in `motion-service.ts`, gated on `adaptive_sampling_enabled`
- [ ] Reconfigure FGS on transition via `Location.startLocationUpdatesAsync`
- [ ] 30-second debounce before acting on a transition

**Checkpoint — adaptive sampling alone** (before adding geofences):

- [ ] Driving test: confirm sample rate matches `IN_VEHICLE` config (30s interval) in real driving
- [ ] Walking test: confirm sample rate matches `ON_FOOT` config
- [ ] Debounce test: red-light STILL blip (<30s) does NOT reconfigure GPS
- [ ] 10-min idle test: sample rate degrades to `STILL (>10min)` config
- [ ] Battery baseline captured on reference Samsung S24 (for post-geofence comparison)

- [ ] Implement stationary geofence pattern:
  - [ ] On `IN_VEHICLE → STILL` held >10 min: create 100m geofence at current location
  - [ ] Register exit listener
  - [ ] Tear down on `STILL → IN_VEHICLE`
- [ ] Create Convex `trackingTuning` table for per-org tuning:
  - [ ] Schema fields: `motionStillMinutes`, `vehicleAccuracy`, `vehicleIntervalSec`, etc.
  - [ ] `trackingTuning.getForOrg` query — cached by mobile like feature flags
  - [ ] Defaults fall back to in-code values

**Exit criteria** (all must pass before tagging Phase 2 done):

- [ ] Baseline battery measurement (pre-Phase 2) on reference Samsung S24 — full shift
- [ ] Post-Phase 2 measurement — target 40–60% reduction
- [ ] Geofence exit recovery test: park, wait 15 min, drive away — verify tracking resumes via geofence exit event
- [ ] PostHog `activity_recognition_transition` event rate per canary driver is between 1 and 20 per driving hour (same threshold as Phase 1 shadow-mode gate)
- [ ] No regression in Phase 1 exit criteria metrics
- [ ] `trackingTuning` fallback path works — delete the row and verify defaults apply
- [ ] 72h canary bake-in with 2+ drivers before flipping to full org

### Phase 3 — Reboot persistence + OEM settings helper

**Reboot persistence**:

- [ ] Add `ACTION_BOOT_COMPLETED` `BroadcastReceiver` (native file in Expo module)
- [ ] Declare in `AndroidManifest.xml` with `RECEIVE_BOOT_COMPLETED` (already present)
- [ ] Android 14+: set `exported=true`, add explicit intent filter
- [ ] Receiver reads tracking state via native MMKV access
- [ ] If `isActive`: start FGS via the `BOOT_COMPLETED` broadcast exemption (§ 4.1 #4)
- [ ] Emit `boot_completed_restart({ success, delayMs })` telemetry once the JS context catches up (measures boot → FGS-live latency)

**Checkpoint — reboot persistence alone**:

- [ ] Test: reboot device mid-shift, verify auto-resume with no app open, within 60s of boot
- [ ] Test: reboot when tracking NOT active — verify FGS does NOT start
- [ ] Test: Android 14+ device — verify `exported=true` intent filter works; no manifest errors
- [ ] Logcat check: receiver fires on `ACTION_BOOT_COMPLETED` broadcast (not just `QUICKBOOT_POWERON`)
- [ ] PostHog: `BOOT_COMPLETED`-triggered restart event fires with correct telemetry

**OEM settings helper**:

> **Caveat**: every intent in the table below is a *starting point*, not a verified-current. OEMs rename/move these activities between major versions of their skin (OneUI 6 → 7, MIUI 13 → 14, ColorOS 13 → 14, etc.) without notice. Treat the table as a set of default guesses and rely on the "verified on at least one real device or logged as unverified" checklist item below to keep it honest. When an intent fails, the handler must fall back to `Settings.ACTION_APPLICATION_DETAILS_SETTINGS`, never crash.

- [ ] Create `mobile/lib/oem-settings.ts` with per-OEM intent table:
  - [ ] Samsung: `com.samsung.android.lool/.battery.BatteryActivity`
  - [ ] Xiaomi: `com.miui.securitycenter/.permcenter.autostart.AutoStartManagementActivity`
  - [ ] Huawei: `com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity`
  - [ ] Oppo/Realme: `com.coloros.safecenter/.startupapp.StartupAppListActivity`
  - [ ] Vivo: `com.vivo.permissionmanager/.activity.BgStartUpManagerActivity`
  - [ ] OnePlus: `com.oneplus.security/.chainlaunch.view.ChainLaunchAppListActivity`
  - [ ] Fallback: `Settings.ACTION_APPLICATION_DETAILS_SETTINGS`
- [ ] OEM detection via `Build.MANUFACTURER`
- [ ] Surface in App Settings → Troubleshooting: "Improve background tracking reliability" button
- [ ] Show rationale sheet before firing intent
- [ ] Analytics event: `oem_settings_opened` with `{ manufacturer, successful }`
- [ ] **Intent discovery documentation** — comment block in `oem-settings.ts` explaining source of each intent with links

**Exit criteria — Phase 3**:

- [ ] Samsung physical device: tap "Improve background tracking reliability" → correct settings screen opens (Battery → Unrestricted)
- [ ] Xiaomi physical device (or emulator): intent opens Autostart settings
- [ ] Unknown OEM fallback: intent opens generic app details settings, does not crash
- [ ] Each OEM in intent table has been verified on at least one real device or logged as "unverified" in `oem-settings.ts`
- [ ] Reboot recovery on both Samsung and Pixel: FGS is live AND the first fresh GPS fix is captured within 60s of device unlock (verified via `boot_completed_restart delayMs` + first `watch_location_saved` timestamp)
- [ ] 72h canary bake-in — no `oem_settings_opened successful=false` crashes

### Phase 4 — iOS parity

- [ ] Add `CMMotionActivityManager` native bridge in iOS module
- [ ] Request `NSMotionUsageDescription` in Info.plist
- [ ] Bridge to same JS `motion-service.ts` interface
- [ ] iOS 17+ two-step "Always" permission flow: iOS 17 changed the dialog sequence — the app first requests "While Using," then iOS shows a separate prompt offering "Always" after the user has used location in background. Must not assume a single-dialog grant of Always; build the UX to handle the intermediate "While Using" state and re-prompt after first background capture. Shown once by iOS then only changeable in Settings, so the app must deep-link to Settings if the driver later wants to upgrade
- [ ] Silent APNs handler:
  - [ ] Register for remote notifications in app init
  - [ ] Handle `{ content-available: 1, type: 'wake_tracking' }`
  - [ ] Server: FCM HTTP v1 routes transparently to APNs for iOS tokens
- [ ] `CLLocationManager.startMonitoringSignificantLocationChanges` for low-power wake
- [ ] Region monitoring for geofence equivalent
- [ ] Verify `app.json` background modes still include `location`, `fetch`, `remote-notification`

**Exit criteria — Phase 4**:

- [ ] Physical iPhone: force-quit, walk around, verify significant-location wake within 2 min
- [ ] Physical iPhone: send silent APNs, verify handler runs and captures a fresh fix within 30s
- [ ] Region monitoring: enter + exit a geofenced area, verify both transitions fire (add `ios_region_transition({ direction: 'enter' | 'exit' })` event to the Phase 4 event catalog and assert both land in PostHog)
- [ ] Backgrounded 8h test: iPhone in pocket during a driving shift, PostHog `skipped_backgrounded` < 3
- [ ] Permission denial: user denies `NSMotionUsageDescription` — app falls back to GPS-only tracking without crash
- [ ] TestFlight distribution to 1 internal iOS driver for 72h canary before widening

### Phase 5 — Test + maintenance infrastructure

**Device lab**:

- [ ] Firebase Test Lab project linked to GitHub Actions CI
- [ ] Acquire physical devices: 3 Samsung Galaxy (S22, S24, A-series budget), 1 iPhone
- [ ] Document lab access for on-call rotation

**Automated testing**:

- [ ] Choose framework (recommendation: **Maestro**)
- [ ] Write core test flows:
  - [ ] Start shift → drive 10 min → pings appear in Convex
  - [ ] Force-kill mid-shift → AR wake → tracking resumes
  - [ ] Go offline 10 min → tracking continues locally → reconnect → pings flush
  - [ ] Toggle battery saver → verify FGS survives
  - [ ] Reboot device mid-shift → auto-resume
  - [ ] **Feature-flag refresh regression** (the Clerk-race bug we shipped): cold-launch app with flag set server-side, assert flag applies on first tracking operation (not after a second cold start). Protects against a future auth-ordering refactor reintroducing the race
  - [ ] **Per-OEM AR throttling** (called out in § 6.2): on each OEM device in the matrix, run a 60-minute background soak with scripted motion, assert `activity_recognition_transition` event count is within 30% of the Pixel reference baseline. Large deviation flags OEM-specific throttling needing investigation

**CI pipeline**:

- [ ] GitHub Actions workflow for PRs touching `mobile/**` or `convex/**`
- [ ] Steps: TS check → unit tests → Maestro on Firebase Test Lab (min 2 Android) → iOS sim tests
- [ ] CI Maestro job builds with `EXPO_PUBLIC_MOTION_MOCK=1` so the `fakeTransition` entry point is available — the "force-kill mid-shift → AR wake" flow depends on this
- [ ] CI job needs a seeded Clerk test driver + seeded `driverSessions` row + seeded Convex feature-flag row for the canary org — document the seed script in the repo
- [ ] Runtime-version CI check (pre-work item): fail the PR if any file under `mobile/modules/**`, `mobile/android/**`, `mobile/ios/**` changed without a bump to `expo.runtimeVersion` in `app.json`
- [ ] Merges blocked on any failure
- [ ] Required status checks in GitHub branch protection for `main`

**Observability**:

- [ ] PostHog saved dashboards per § 6.5
- [ ] Alerts per § 10.4

**Exit criteria — Phase 5**:

- [ ] All 5 Maestro test flows pass on Firebase Test Lab against 2+ Android devices
- [ ] CI pipeline blocks a PR that regresses any of the test flows (verified with a deliberately-broken PR)
- [ ] Each PostHog dashboard opens without errors and returns non-empty data for the preceding 7 days (zero rows indicates a broken event pipeline, not "expected empty state")
- [ ] Each alert threshold has been fired at least once in staging (manual trigger) to confirm routing to on-call
- [ ] Runbooks (§ 10.5) exist in Notion/wiki and are linked from dashboards
- [ ] On-call rotation documented, first rotation has shadowed at least one P2 investigation

### Maintenance cadence

**Quarterly (first week of Jan/Apr/Jul/Oct)**:

- [ ] Run full device-matrix test suite
- [ ] Review Android Developer release notes for API level N+1
- [ ] Review Apple iOS release notes
- [ ] Check dontkillmyapp.com for new OEM quirks
- [ ] Update `oem-settings.ts` intent table if new models shipped
- [ ] Review PostHog dashboards; open tickets on drift
- [ ] Update this document if learnings emerged

**On each Android/iOS major version release**:

- [ ] Read changelogs for background/location/FGS/notification policy changes
- [ ] Bump `targetSdkVersion` / iOS deployment target in test branch
- [ ] Run full test matrix on new OS
- [ ] Ship compatibility build within 4 weeks of public release

**On each new OEM flagship launch**:

- [ ] Add to device lab inventory
- [ ] Run regression suite
- [ ] Update `oem-settings.ts` if battery management changed

**On PostHog alert**:

- [ ] Open incident ticket
- [ ] Investigate root cause (OEM / OS / our regression)
- [ ] Ship hotfix — OTA if JS-only, new build if native
- [ ] Add to runbook for future recurrence

**On new mobile hire**:

- [ ] Walk through this doc + codebase
- [ ] Pair on one full quarterly cycle before solo ownership
- [ ] CODEOWNERS entry updated

### Success metrics — targets

- [ ] P0: `skipped_backgrounded` < 3 per driver-shift
- [ ] P0: `location_queue_op_failed` rate = 0
- [ ] P1: `watch_location_received` gaps > 10 min < 1 per driver-shift
- [ ] P1: `recordedToCreatedLagMs` p99 < 60 seconds
- [ ] P2: AR FGS-restart success rate ≥ 95%
- [ ] P2: FCM wake delivery rate ≥ 98% within 2 min
- [ ] P2: Battery drain per 8h shift ≤ 40% on reference Samsung S24
- [ ] P3: OS-release-to-verified-compat ≤ 4 weeks
- [ ] P3: Tracking-related support tickets per 100 drivers per month < 2
- [ ] P3: Zero P0 incidents per quarter in steady state

---

## Appendix B — Non-code follow-ups (regulations, UI, docs)

Deferred until Phases 0–5 backend work is green. None of these require shipping code, but each is ship-blocking for general availability.

### Permission & onboarding UX

- [ ] Staged permission-prompt flow (avoid prompting all at first launch — tanks grant rates). Order: `WHEN_IN_USE` location → `ALWAYS` / background → `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` → `android.permission.ACTIVITY_RECOGNITION` → `POST_NOTIFICATIONS` (Android 13+) → `NSMotionUsageDescription` (iOS)
- [ ] Denial-recovery UX — when a driver denies background location mid-shift, show a non-blocking banner with a "re-grant in Settings" CTA
- [ ] First-time tracking disclosure screen shown before any permission prompt
- [ ] Copy for each OS permission rationale string in `app.json` reviewed by product (current strings are placeholder)

### Play Store / App Store compliance

- [ ] Play Store "prominent disclosure" screen for background location — required by Google; app rejected without it
- [ ] Play Store background-location declaration form (justify use case in reviewer notes + include video of tracking UI)
- [ ] App Store reviewer notes template — explain always-on location in terms of fleet dispatch SLAs; include a demo account
- [ ] Privacy labels (App Store) / data safety form (Play Store) updated to reflect location + motion + push-token collection

### Privacy, retention, compliance

- [ ] Data retention policy written: how long `driverLocations` is kept in Convex (recommend 90 days hot + archive or delete), MMKV queue eviction policy (10K cap already set, document the rationale). Retention *job* is a code item in Phase 0; only the *policy document* is pending here
- [ ] Driver consent record — add `driver.trackingConsentAcceptedAt` field and a one-time consent screen; required for GDPR jurisdictions
- [ ] GDPR considerations for EU expansion: works-council agreement templates (Germany), lawful basis documentation (Art. 6(1)(f) legitimate interest for fleet ops), data subject access request runbook
- [ ] CCPA disclosures for California drivers: right-to-delete path, "sale" declaration (we do not sell)
- [ ] Data export path for driver subject access requests
- [ ] DPIA (Data Protection Impact Assessment) drafted for worker-surveillance use case

### Driver-facing content

- [ ] Help Center article: "Why is my GPS not working?" covering OEM settings, battery optimization, permission re-grant
- [ ] In-app troubleshooting screen linking to `oem-settings.ts` helper (Phase 3)
- [ ] Dispatcher-facing playbook: when to tell a driver to reset phone vs re-install vs open OEM settings

### Ops & secrets

- [ ] Firebase / GCP project ownership documented (which org account, billing alerts, IAM roles)
- [ ] `FCM_SERVICE_ACCOUNT_JSON` key rotation policy — annual rotation + runbook for the rotation procedure
- [ ] Per-environment secrets (dev / staging / prod) — confirm no key reuse across envs
- [ ] Billing alerts on Firebase, Convex, PostHog with thresholds

### Documentation gaps

- [ ] Runbooks referenced in § 10.5 (`rb-tracking-stale`, `rb-capture-regression`, `rb-os-compat-sprint`, `rb-oem-onboard`, `rb-push-delivery`) — create in Notion/wiki, link from dashboards
- [ ] Onboarding doc for new mobile team hires (checklist + pair-programming agenda for first quarterly cycle)
