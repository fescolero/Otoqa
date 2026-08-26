# End-Shift Reminder — Yard Re-entry

Status: proposed. Implements frames **04c–04f** of the "Otoqa Driver" hi-fi
flow (`LockScreenReminder`, and `DashboardScreen` in the `active` / `muted` /
`ended` reminder states).

**The problem in one line:** drivers forget to end their shift, and nothing
notices for eighteen hours.

---

## What a forgotten shift costs today

Three paths close an abandoned session. All three are wrong, and two of them
are wrong in ways that reach payroll.

| Path | Where | What it costs |
|---|---|---|
| 18-hour auto-timeout sweep | `sweepStaleSessionsForAutoTimeout` ([driverSessions.ts:826](../convex/driverSessions.ts)) | An 18-hour session. `paySession` stamps `warningMessage` on the payable, which surfaces as the "Load pay" hard blocker — the statement parks in **Needs attention** until a human verifies hours ([sessionPay.ts:21](../convex/sessionPay.ts)). |
| Next morning's Start Shift closes it | `startSession` ([driverSessions.ts:236](../convex/driverSessions.ts)) | `endReason: 'next_session_opened'`, `endedAt = now` → yesterday's shift measures ~24 hours. This path carries **no warning message**, so the inflated hours are billed silently. Strictly worse than the sweep. |
| Dispatcher force-ends it | `adminEndSession` ([driverSessions.ts:754](../convex/driverSessions.ts)) | Manual. Someone has to notice first. |

Meanwhile the phone keeps tracking: background GPS runs all night against a
session nobody is working, burning battery and data and drawing a parked
truck on the dispatch map.

The only in-app nudge that was ever designed for this — the 10h/14h soft caps
— is **dead code on mobile.** `markSoftCapHit` exists
([driverSessions.ts:313](../convex/driverSessions.ts)), the web session
history renders the badges
([driver-sessions-history.tsx:207](../components/sessions/driver-sessions-history.tsx)),
and the driver app never calls the mutation. All that survives of it in the
app is an orphaned `softCapBanner` style key
([index.tsx:1187](<../apps/driver/app/(app)/(driver-tabs)/index.tsx>)).

---

## 1. What already exists

Most of this feature is already built and pointed the other way.

**Yard geofencing, server-side.** `evaluateYards`
([yardGeofence.ts:35](../convex/yardGeofence.ts)) checks each GPS batch's
newest ping per session against the org's `yardLocations` fences and appends
`ARRIVED` / `DEPARTED` rows to `sessionGeofenceEvents`. Scheduled from ping
ingest ([driverLocations.ts:638](../convex/driverLocations.ts)), gated on the
org having at least one yard. Entry ring defaults to 250 m
(`YARD_DEFAULT_RADIUS_METERS`, per-yard override 50–5000 m in Settings →
Yards), exit ring is 1.5× the entry ring, and pings worse than 100 m accuracy
are ignored. Detection is stateless: the last event per (session, yard) *is*
the state, and events must alternate.

That is precisely the trigger this feature needs. Nothing new has to be
detected — the rule is "an `ARRIVED` at the start yard that follows a
`DEPARTED`."

**A lock-screen shift surface.** `otoqa-shift-status` renders an Android
ongoing notification with a native chronometer and an iOS ActivityKit Live
Activity, and accepts status-line updates ("Stop 3 of 5 — checked in"). It is
deliberately silent: MIN importance, SECRET visibility, tap-to-open only, no
action buttons.

**A local-notification precedent.** `sync-stall-alert.ts` — lazily created
channel, fixed notification identifier so re-alerts replace rather than
stack, throttle key in MMKV, analytics event on fire. This spec copies its
shape.

**The end-shift UI.** `EndShiftSheet`
([more.tsx:670](<../apps/driver/app/(app)/(driver-tabs)/more.tsx>)) with elapsed
/ loads / miles / stops, and a passive "On duty" pill on the dashboard that
routes to the More tab
([index.tsx:321](<../apps/driver/app/(app)/(driver-tabs)/index.tsx>)).

### What is missing

1. Nothing reads `sessionGeofenceEvents` for any purpose but the dispatcher map.
2. The session does not record **where it started**.
3. The driver app has **no knowledge of yards at all** — no query, no cache,
   no client-side fence.
4. There is no driver-facing push path. `driverPushTokens` collects Expo
   tokens and nothing has ever sent to them; `push.ts` fans out only to
   `dispatchPushTokens`. `fcmWake` is data-only wakes and explicitly skips
   iOS ("APNs not wired", [fcmWake.ts:938](../convex/fcmWake.ts)).
5. The dashboard has no banner slot.

---

## 2. Decision: evaluate on the device

The trigger could be read off `sessionGeofenceEvents` server-side and pushed.
It should not be, for now.

| | Server push | **Device (chosen)** |
|---|---|---|
| iOS | Needs a driver-facing APNs/Expo send path built and proven from zero | Local notification, works today |
| Offline | Nothing fires until the pings sync | Fires on the fix, no network needed |
| Latency | Ping capture (≤2 min) + sync (≤2 min) + push | Ping capture only |
| New surface area | A send path, token hygiene, receipts, pruning | One read-only query + a cached fence list |

The background location task already runs on every fix for the whole shift.
Adding a distance check to it is cheap; standing up the repo's first
driver-facing push channel to deliver a reminder is not. Server push stays
available later as a backstop (§10).

The cost of this choice is that yard coordinates must reach the device, which
they never have.

---

## 3. The trigger  ✅ shipped

Mirror the server's state machine exactly, so the device and the dispatcher
timeline never disagree about whether a driver is in the yard.

Per accepted ping (i.e. one that clears the existing accuracy and
distance/time gates and gets queued), when a shift is active and a start yard
is known:

```
d = haversine(fix, startYard)
entry = startYard.radiusMeters > 0 ? startYard.radiusMeters : 250
exit  = round(entry * 1.5)

d < entry  → inside
d > exit   → outside
otherwise  → hysteresis band, no state change
```

Fire the reminder on a transition to `inside` **only when the previous state
is `outside`**. That single condition does all the work:

- A driver who starts their shift parked in the yard opens at `inside`, so
  the shift-start crossing cannot fire.
- A driver who runs an errand out of the yard mid-shift and returns *will*
  fire — correctly. They are back where they started and may well be done.
- GPS jitter cannot flap the state: the 125 m hysteresis band at the default
  radius is wider than a fix that passed the 50 m accuracy gate can reach.

**Mute for the rest of the visit.** When the reminder fires, set a flag. Clear
it on the next transition to `outside`. One nudge per yard visit, no timers,
no server state. "Still working" (frame 04e) sets that same flag without ever
showing the notification again this visit.

**Two traps to avoid when porting the math.**

- Compute the effective entry radius *first*, then multiply. Calling the
  server's `exitRadiusFor(undefined)` returns `DEPARTURE_RING_METERS` (1207 m
  — the load-stop departure ring), not 375 m. `yardGeofence.ts` avoids this
  by defaulting the radius before the call; the device must do the same.
- Use the server's accuracy gate semantics. Mobile already drops fixes over
  50 m (`MAX_ACCURACY_METERS`), which is stricter than the server's 100 m, so
  no extra filter is needed — but do not evaluate on the raw
  `watchPositionAsync` stream ahead of that gate.

**Timing.** Driving into the yard is motion, so the OS delivers fixes across
the crossing (Android's `smallestDisplacement` suppression only bites while
stationary). Expect the reminder within one capture interval — under two
minutes of the truck coming through the gate.

---

## 4. Data model

### `driverSessions` — one new optional field  ✅ shipped

```ts
startYardId: v.optional(v.id('yardLocations')),
```

Additive, no migration.

**Stamped server-side, by the yard evaluator.** `startSession` has no GPS fix
to work from, so the anchor is derived instead: `evaluateYards`
([yardGeofence.ts](../convex/yardGeofence.ts)) claims the slot on the first
`ARRIVED` whose ping lands within `START_YARD_WINDOW_MS` (5 min) of
`startedAt` — i.e. the driver was already parked in the fence when they
tapped Start Shift. Absent when the shift opened outside every fence (home,
customer facility, an org with no yards configured), or when no fix landed
inside the window.

The window is the whole discriminator between "the yard they started in" and
"a yard they drove to later," so it is deliberately tight: the first fix is
captured within seconds of Start Shift (the foreground watch has no previous
point to rate-limit against), and `recordedAt` is capture time rather than
sync time, so a yard with no signal still anchors correctly once the backlog
drains. Five minutes covers a cold GPS lock and nothing else.

At most one patch per session. The lookup runs on each `ARRIVED` of a session
that has no anchor yet — a handful of reads per shift, since crossing a yard
boundary is a rare event, not a per-ping one. This is the evaluator's only
write to `driverSessions`; keeping it one-shot is what stops it invalidating
dispatcher subscriptions on every GPS batch.

The device does not strictly need this field — its own copy lives in tracking
state — but it makes "started at Bay 4" available to the dispatcher's session
timeline, it survives a reinstall mid-shift, and it is what the self-heal
path in §5 recovers from.

### New query: `yardLocations.listForDriver`  ✅ shipped

`yardLocations.list` cannot be reused: it authorizes with
`requireCallerOrgId` ([lib/auth.ts:51](../convex/lib/auth.ts)), the WorkOS
org-claim path, and drivers authenticate by Clerk phone claim through
`resolveAuthenticatedDriver` ([driverMobile.ts:55](../convex/driverMobile.ts)).
A driver calling `list` gets "No organization claim on identity".

Fence-only projection — `_id`, `name`, `latitude`, `longitude`,
`radiusMeters`, `exitRadiusMeters`. Addresses, notes and audit fields stay on
the dispatcher side; a phone caching this for offline use needs the circle
and nothing else.

**Both radii are resolved server-side**, not just the entry radius as
originally drafted. The device never derives an exit ring, because deriving
one from an unset radius yields the load-stop departure ring (1207 m) rather
than 1.5× the yard default — a trap worth disarming once rather than
re-litigating in a second codebase. `effectiveRadiusMeters` in
[yardLocations.ts](../convex/yardLocations.ts) is now the single place the
250 m default is applied, shared by both projections.

The 100-row ceiling matches `evaluateYards` exactly. If an org ever exceeds
it, both sides must fall off the same edge — otherwise the device watches a
fence the server doesn't, or the reverse.

### Device state  ✅ shipped

One `storage` key, `end_shift_reminder_state`, alongside `TrackingState`:

```ts
sessionId: string;        // stamped, so last shift's state can't be reused
organizationId: string;
fence: YardFence | null;  // null = this shift has no anchor
zone: 'inside' | 'outside' | 'unknown';
remindedThisVisit: boolean;
```

`zone` is the last *settled* side. A fix in the hysteresis band is never
stored — it leaves the previous answer standing, which is what makes jitter
free. `unknown` precedes the first settling fix and can never fire: it means
we don't know whether the driver just arrived or was here all along.

Writes happen only on a change of side, not per fix — a truck parked in the
yard overnight produces one write, not one every two minutes.

---

## 5. Arming the reminder  ✅ shipped

At Start Shift ([start-shift.tsx](<../apps/driver/app/(app)/start-shift.tsx>)),
`refreshYardFences` pulls `yardLocations.listForDriver` into the device cache
— fire-and-forget, never awaited on a path the driver is watching, and a
failed refresh keeps the previous copy rather than emptying it: a stale fence
is worth far more than no fence.

**Arming itself happens on the first evaluated fix, not at Start Shift.**
Start Shift has no fix to hand — the GPS subscription has only just been
created — so plumbing one through the UI would mean waiting on a lock while
the driver watches a spinner. Instead the first fix that reaches
`evaluateShiftReminder` with no state for its session establishes the anchor:

1. Past `ARM_WINDOW_MS` (5 min) since tracking started → **tombstone**. The
   shift gets no anchor, recorded so the reminder stops re-reading the cache
   on every ping for the rest of the day.
2. Fence cache empty → **retry on the next fix**. The refresh above is
   fire-and-forget, so a fast GPS lock can beat it home; treating "not yet"
   as "this org has no yards" would silently disarm exactly the shifts that
   start well.
3. Otherwise **arm** on the enclosing fence, or on `null` when the shift
   genuinely opened outside every fence — a real answer, not a failure.

The window mirrors the server's `START_YARD_WINDOW_MS` exactly. Falling out
of this design for free: a driver whose app restarts a minute into the shift
re-arms itself with no recovery path at all, because the arming rule is a
property of the fix stream rather than of the Start Shift screen.

The device resolves its own anchor rather than reading back `startYardId`:
the server's copy only lands after the first ping syncs, and the device
already holds both the fix and the fence list. The two agree by construction
— same fences, same radius defaulting, same window, same first fix.

The list must be cached rather than fetched per evaluation: the background
task runs headless with no React context and, more importantly, must work
with no network. The cache carries an `organizationId` stamp, so a driver who
re-signs into a different org can never be evaluated against the previous
org's yards — cheaper and harder to get wrong than clearing it from every
path that can change orgs. It is also dropped outright on sign-out.

The geometry lives in [yard-fence-math.ts](<../apps/driver/lib/yard-fence-math.ts>),
which imports nothing from React Native or Convex so the rings, the
hysteresis band, and the overlapping-fence tiebreak are unit-testable in
node (a `driver` vitest project runs them). One deliberate difference from
the server: when fences overlap, the device picks the **nearest**, not the
first row scanned. The server's arbitrary-but-stable order is fine for an
append-only event log; the device's answer anchors a whole shift and must
survive a refresh reordering the list.

**Still open: the self-heal path.**
`reconcileTrackingStateWithActiveSession`
([location-tracking.ts:432](../apps/driver/lib/location-tracking.ts)) rescues
a driver who is mid-shift on a device where `startSessionTracking` never ran.
It patches the session id into tracking state but leaves `startedAt` at the
legacy tracking start, which is typically hours old — so the arm window is
already closed and that shift tombstones. Recovering it means reading
`startYardId` off the session (`getActiveSession` does not return it yet) and
looking the fence up in the cache. Deferred deliberately: the
`window_closed` telemetry from step 3 says how often this actually happens,
and that number should decide whether it is worth the extra query.

---

## 6. Delivery — frame 04c  ✅ shipped

A local notification on a new channel, following `sync-stall-alert.ts`:

- **Channel** `otoqa_shift_reminders`, `AndroidImportance.DEFAULT`, public
  visibility. Distinct from `otoqa_sync_alerts` (a different failure with
  different urgency) and emphatically distinct from the shift-status channel,
  which is MIN/SECRET by design and must stay silent — do not reuse it, and
  do not raise its importance.
- **Fixed identifier** so a re-fire replaces rather than stacks. With
  mute-per-visit a re-fire should be impossible; the fixed ID is the belt to
  that suspenders.
- **Actions** via `Notifications.setNotificationCategoryAsync` — "End shift"
  and "Still working" as buttons, supported on both platforms. The app has no
  notification categories today, so this is new ground; the response arrives
  through `addNotificationResponseReceivedListener`, which is already used in
  [notifications.tsx:74](<../apps/driver/app/(app)/notifications.tsx>).
- **Tap** (no action button) opens the More tab, where the shift controls
  live. It will land on the reminder banner (frame 04d) once §7 ships.
- The ongoing shift-status notification and the Live Activity stay exactly as
  they are. If a status line is wanted, `updateShiftStatus('Back at the yard
  — end shift?')` is a free, silent addition.

**Never audible.** The channel is silent on Android, `sound: false` covers
iOS, and the global foreground handler in `fcm-handler.ts` was given a
branch for this payload type. A driver may still be rolling through the yard
to the fuel island when it fires; a chime is the wrong way to say "you're
back".

**"End shift" opens the confirmation sheet — it does not end the shift.**
Decided rather than left open: `endSession` closes any ACTIVE legs, and the
sheet is where that gets surfaced along with elapsed / loads / miles / stops.
One extra tap is cheap next to a driver silently closing an open leg from a
lock screen they half-read. The notification deep-links to
`/(app)/(driver-tabs)/more?endShift=1`, which opens the existing sheet
directly; §7's extraction upgrades that to the shared component.

**"Still working" records the answer and dismisses.** It has nothing to mute:
firing already marked this yard visit as reminded, and it stays that way
until the driver leaves the fence. The branch exists so
`shift_reminder_action` can tell a deliberate dismissal from an ignored
notification.

Permission is **checked, never requested** at fire time — a request cannot be
answered from a background task, and asking for the first time at the end of
a long shift is the worst possible moment. A denied grant emits
`shift_reminder_suppressed` and the feature degrades to the in-app banner.
It never becomes a blocker.

---

## 7. In-app states — frames 04d, 04e, 04f  ✅ 04d / 04e shipped

The dashboard mirrors the same device reminder state, via
[useShiftReminder](<../apps/driver/lib/hooks/useShiftReminder.ts>). The state
is decided on the GPS path, so the hook refreshes two ways: an in-process
subscription for a fire while the app is open, and a re-read on foreground
for one that happened in the headless background task, whose runtime has no
listeners to notify.

- **04d `active`** ✅ — banner between the day tabs and the load list: back
  at the yard, shift elapsed, `End shift` / `Still working`. It replaces the
  orphaned `softCap*` styles that sat in the dashboard for a banner that was
  never built.
- **04e `muted`** ✅ — "Still working" stamps `acknowledgedAt` and the banner
  collapses to the existing On-duty pill. This needed a field of its own:
  `remindedThisVisit` only says we nudged, and the banner has to tell
  "nudged, unanswered" from "nudged and waved off". It expires when the
  driver leaves the fence, alongside `remindedThisVisit` — otherwise someone
  who waved us off at lunch would never see the banner again all day.
- **04f `ended`** — **not built.** Ending the shift already clears the
  session, so the banner and the On-duty pill both disappear and the
  dashboard returns to its ordinary off-duty state. Whether the design
  intends something more (a "shift ended · 7h 20m" confirmation strip?) can't
  be read from the frame name alone — see §11.

**`EndShiftSheet` was not extracted**, and does not need to be. The spec
assumed the dashboard would present its own copy of the sheet; instead the
banner reuses the `?endShift=1` deep link built for the notification, so all
three entry points — banner, notification, On-duty pill — land on the one
implementation in `more.tsx`. That is the outcome the extraction was for,
without refactoring a working 1400-line screen and its 1000-line style
factory. The cost is a tab transition instead of an in-place sheet, which is
already how the On-duty pill behaves.

**Copy is provisional.** `lib/end-shift-reminder.jsx` still hasn't arrived
(§11), so the banner's wording — "Back at {yard}" / "You're still on shift —
{elapsed} so far." — is a best reading of the frame names, not the design's
text. Swapping it is a string change in one component.

---

## 8. Flag and telemetry  ✅ shipped (the reminder half)

Flag `shift_end_reminder_enabled` in `feature-flags.ts`, defaulting **false**
until a pilot org confirms the fences are drawn where drivers actually park.
Read at arm time, so a shift under an org with the flag off stores no state
at all, **and** on every evaluation — flipping it off is then an immediate
kill switch rather than a next-shift one, matching how `ar_wake_enabled` and
`fcm_wake_enabled` are gated.

Events, in the `trackX` convention of `lib/analytics.ts`:

| Event | Fired when | |
|---|---|---|
| `shift_reminder_armed` | Once per shift, on the first fix that settles the anchor. Carries `armed`, a reason (`opened_inside_fence` / `outside_all_fences` / `window_closed`), the cached fence count, and how long after shift start the fix landed. | ✅ |
| `shift_reminder_fired` | `outside → inside` at the start yard; carries shift elapsed and distance from the pin. | ✅ |
| `shift_reminder_action` | `end` / `still_working` / `ignored`, and the surface (notification vs banner). | ships with the UI |
| `shift_reminder_suppressed` | Notification permission denied. | ships with the notification |
| `shift_reminder_suppressed` | Permission denied, or fired while the app had no notification grant |

The number that matters is the rate of `auto_timeout` and
`next_session_opened` end reasons before and after. Both are already on the
session doc, so the measurement needs no new instrumentation.

---

## 9. Non-regression analysis

- **Schema**: one optional field. No migration.
- **Server hot path**: unchanged. No new per-ping work — the device does the
  evaluation, and `evaluateYards` keeps running exactly as it does now.
- **New server reads**: one indexed query per shift start.
- **Battery**: no new location subscription, no new wake-ups, no change to
  any interval. The check is a haversine against a single cached point on
  fixes that were already being processed.
- **Existing notifications**: new channel, new category. The shift-status
  surface, the sync-stall alert, and the FCM wake path are untouched.
- **Shift lifecycle**: nothing ends a session automatically that did not end
  one before. The 18-hour sweep remains the only automatic close.
- **Orgs without yards**: `listForDriver` returns empty, `startYard` is null,
  and every code path short-circuits before the first distance calculation.

---

## 10. Accepted limitations

- **Yard-only coverage.** A driver whose org has no yards configured, or who
  finishes at home, at a terminal, or at a customer facility, gets no
  reminder. Deliberate for v1. The natural follow-ups, in order of appetite:
  revive the dormant 10h/14h soft caps as a real banner + notification
  (`markSoftCapHit` is already written and never called), or nudge on a long
  stationary stretch with no active load.
- **Fences must be accurate.** A 250 m default around a pin dropped on the
  office rather than the parking area will fire early or not at all. Worth
  auditing existing `yardLocations` rows before enabling the flag anywhere.
- **A shift that opens with no GPS lock gets no anchor.** Five minutes
  indoors or under a dock canopy and the window closes; the reminder is
  inert for that shift, exactly as if the driver had started outside every
  fence. Widening the window would let a yard visited later in the day claim
  the slot, which is the worse failure.
- **Device state is not durable across reinstall**, and the self-heal path
  does not re-arm (§5). A driver reinstalled or self-healed mid-shift
  tombstones for the rest of the day. The `window_closed` count in
  `shift_reminder_armed` measures exactly how often this bites.
- **No server backstop in v1.** If the app is killed and the OS stops
  delivering background fixes, no reminder fires. A server-side sweep over
  `sessionGeofenceEvents` — "session still active, last event is an `ARRIVED`
  at `startYardId` more than N minutes ago, device never reported acting on
  it" — is the obvious v2 once a driver-facing push path exists for iOS.
- **Multi-yard orgs**: only the *start* yard arms a reminder. Returning to a
  different yard fires nothing, which is right for the common case (dropping
  a trailer at another site mid-shift) and wrong for the driver who
  legitimately ends the day elsewhere.

---

## 11. Open questions

1. **Design source — still outstanding.** `lib/end-shift-reminder.jsx` and
   the reminder-aware `lib/dashboard-screen.jsx` were not in the handoff
   bundle; the index HTML references them but the `lib/` folder does not
   contain them. Two things are blocked on it: the banner's exact copy and
   button order (shipped with a provisional reading), and what frame 04f
   `ended` is actually meant to show beyond the ordinary off-duty dashboard.
2. ~~**Notification "End shift": inline or open the app?**~~ **Decided:**
   opens the app to the confirmation sheet. Ending a shift is irreversible
   and closes any ACTIVE legs; the sheet is where that is surfaced.
3. **Minimum shift duration before arming?** The `outside → inside` rule
   already suppresses the degenerate case. A driver who pulls out of the yard
   and comes right back after ten minutes would get a nudge. Probably fine —
   confirm.
4. **Should the reminder respect the truck being parked?** Firing while the
   driver is still rolling through the yard to the fuel island is
   technically correct but conversationally early. A "speed under N for one
   fix" condition would delay it a couple of minutes.

---

## Suggested order

1. ✅ `startYardId` on the schema, stamped by the yard evaluator from the
   first ARRIVED inside a 5-minute window. No client change; ships alone and
   inert, and starts populating immediately — which is also the cheapest
   read on whether drivers actually start inside the fences an org has
   drawn.
2. ✅ `yardLocations.listForDriver` + device cache. Also inert — the fences
   come down at shift start and nothing reads them yet.
3. ✅ Fence evaluation in the background task, behind the flag, **telemetry
   only** — no notification. Run it for a week on a pilot org and compare
   `shift_reminder_fired` against the org's actual `auto_timeout` /
   `next_session_opened` rate. This is the step that proves the fences are
   drawn correctly, and it is the step most likely to be skipped.
4. ✅ The notification (04c) + channel + categories, plus the response
   routing for its two actions and a plain tap.
5. ✅ The dashboard banner (04d/04e). The `EndShiftSheet` extraction turned
   out to be unnecessary — the banner reuses the notification's deep link,
   so there is still exactly one end-shift sheet. 04f is open pending the
   design source.
