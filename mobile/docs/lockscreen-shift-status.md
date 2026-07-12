# Lock-screen shift status — Live Activity (iOS) + chronometer notification (Android)

Drivers see their shift without unlocking the phone: elapsed shift time
plus a one-line trip/stop status ("Stop 3 of 5 — checked in").

## Why these two surfaces

- **iOS — Live Activity** (lock screen + Dynamic Island, iOS 16.2+).
  Apple's purpose-built surface for an ongoing session. The elapsed
  timer renders natively from the shift-start `Date` — zero updates
  needed for the clock to tick.
- **Android — ongoing silent notification with a chronometer.** True
  lock-screen widgets barely exist on Android (removed in 5.0, partial
  return on some 15/16 devices); the notification shade IS the Android
  lock-screen surface. `setUsesChronometer` ticks natively, same
  zero-update property as iOS.

Neither surface polls or wakes the app. Updates happen only on real
events: shift start/end, load attach/detach, check-in/check-out.

## Pieces

| Path | Role |
| --- | --- |
| `modules/otoqa-shift-status/` | Local Expo module. Kotlin: notification (channel `shift-status`, id 4207). Swift: ActivityKit start/update/end. JS: safe no-op wrappers via `requireOptionalNativeModule`. |
| `targets/shift-status-widget/` | WidgetKit extension (via `@bacons/apple-targets`) with the SwiftUI Live Activity UI. |
| `lib/location-tracking.ts` | start on `startSessionTracking`, re-assert on `resumeTracking`, update on load attach/detach, end in `stopLocationTracking` (covers End Shift + legacy stop + server-forced stop). |
| `lib/hooks/useCheckIn.ts` | `announceStopStatus` — stop-level status line on check-in/out (online and queued). |
| `app.json` | `NSSupportsLiveActivities: true`, `@bacons/apple-targets` plugin, `runtimeVersion: 1.6.0`. |

**Duplicated struct warning:** `ShiftStatusAttributes` exists twice by
design — in the module (`ios/ShiftStatusAttributes.swift`) and the widget
target (`targets/shift-status-widget/index.swift`). ActivityKit matches
app ↔ extension by type name + Codable shape. Change one → change both.

## Build & verify (native — cannot be exercised in CI/simulated here)

1. `npx expo prebuild -p ios --clean` — confirm the ShiftStatusWidget
   target is generated and the app builds (`eas build -p ios --profile
   development`). First prebuild with `@bacons/apple-targets` may prompt
   for an Apple team ID in the target config; extension signing follows
   the main app's credentials on EAS.
2. `eas build -p android --profile development` — module compiles via
   autolinking (`modules/` is picked up automatically like otoqa-motion).
3. On-device pass:
   - Start Shift → iOS: Live Activity appears with ticking timer;
     Android: silent "On shift" notification with running chronometer.
   - Check in/out at a stop → status line updates on both.
   - Force-kill the app mid-shift, relaunch → `resumeTracking` re-asserts
     the surface with the ORIGINAL start time (timer doesn't reset).
   - End Shift → both surfaces disappear.
   - iOS Settings → app → Live Activities OFF → start shift → app works
     normally, no card (module returns false).
   - Android 13+: deny notification permission → same graceful no-op.

## Update discipline (post-review hardening)

- **Idempotent start.** `startShiftStatus` is called from every resume
  path (foreground mounts, FCM wakes, motion-transition wakes). The JS
  wrapper no-ops when the same shift is already showing, and the Swift
  side leaves an existing same-start activity untouched — never
  end+re-request, which would flicker the card and LOSE it on background
  wakes (iOS only allows requesting a Live Activity in the foreground).
  Net effect: the granular "Stop 3 of 5" line survives app restarts and
  resumes.
- **Single owner per line.** useCheckIn owns the stop-level lines;
  `detachLoadFromSession` owns 'Trip complete — on shift'. No layer
  writes another's line, so there are no duplicate or racing updates.
- **Dedupe.** Identical consecutive status lines are dropped in the JS
  wrapper — protects the iOS Live Activity update budget.
- **Android base persistence.** The chronometer base is mirrored to
  SharedPreferences so an update landing right after process death (the
  notification survives; the process doesn't) still targets the correct
  start time.

## Behavior notes / v1 limits

- **Session mode only.** Legacy load-only tracking (no Start Shift)
  shows no surface — there's no shift start time to anchor the timer.
- Live Activities auto-end after ~8 h of no updates (system policy).
  Check-in/out events reset that window; an 8h+ fully-idle shift may see
  the iOS card end early. Android has no such limit.
- On process death the Android notification lingers until swiped or the
  next app launch reconciles; the chronometer keeps ticking correctly.
- Old binaries (runtime 1.5.0) that receive this JS via OTA no-op safely
  (`requireOptionalNativeModule` → null). The `runtimeVersion` bump to
  1.6.0 fences new-runtime updates from old binaries regardless.
- Android small icon is the app icon for v1; some OEM status bars render
  it muddy. Swap for a dedicated monochrome drawable when design has one.
- Status strings are hardcoded English, consistent with the trip screen
  today. When driver-facing i18n lands (lib/i18n.ts ships en+es), the
  status lines should come from the i18n layer and the native 'On shift'
  titles (Kotlin + widget Swift) become JS-supplied parameters.
- The 'Stop N of M' label falls back to a generic 'Stop' for detour
  stops (fractional sequence numbers) rather than showing 'Stop 3.01 of
  2'; a shared formatter with the trip screen's label is a follow-up.
