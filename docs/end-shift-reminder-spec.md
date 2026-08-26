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

## 3. The trigger

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

### New query: `yardLocations.listForDriver`

`yardLocations.list` cannot be reused: it authorizes with
`requireCallerOrgId` ([lib/auth.ts:51](../convex/lib/auth.ts)), the WorkOS
org-claim path, and drivers authenticate by Clerk phone claim through
`resolveAuthenticatedDriver` ([driverMobile.ts:55](../convex/driverMobile.ts)).

```ts
// Driver-authed, fence-only projection: no notes, no address, no audit
// fields. Called once per shift start and cached on the device.
export const listForDriver = query({
  args: {},
  returns: v.array(v.object({
    _id: v.id('yardLocations'),
    name: v.string(),
    latitude: v.float64(),
    longitude: v.float64(),
    radiusMeters: v.float64(),   // effective radius, defaulted server-side
  })),
  // resolveAuthenticatedDriver(ctx) → driver.organizationId → by_org index
});
```

Defaulting `radiusMeters` server-side means the 250 m constant lives in one
place and the device cannot drift from it.

### Device state (MMKV, alongside `TrackingState`)

```ts
startYard: { id, name, latitude, longitude, entryRadius, exitRadius } | null;
fenceState: 'inside' | 'outside' | 'unknown';
remindedThisVisit: boolean;
```

`unknown` is the state before the first accepted fix. It transitions to
`inside` or `outside` without firing — only an explicit `outside → inside`
edge fires.

---

## 5. Arming the reminder

At Start Shift ([start-shift.tsx](<../apps/driver/app/(app)/start-shift.tsx>)),
after `startSession` and alongside the existing `startSessionTracking` call:

1. Fetch `yardLocations.listForDriver` (cache in MMKV; the list is small and
   changes rarely).
2. Take the first fix and find the enclosing fence.
3. Persist it as `startYard` with `fenceState: 'inside'`.
4. No enclosing fence → `startYard: null`, and the whole feature is inert for
   this shift.

The device resolves its own anchor rather than waiting to read back
`startYardId`: the server's copy only lands after the first ping syncs, and
the device already holds both the fix and the fence list. The two agree by
construction — same fences, same radius defaulting, same first fix. Where
they can disagree is a shift that opens with no GPS lock: the device has no
anchor to store, and the server may still stamp one from a fix minutes later.
The server's copy is the durable one, so the recovery path below prefers it.

The list must be cached rather than fetched per evaluation: the background
task runs headless with no React context and, more importantly, must work
with no network.

Also arm from `reconcileTrackingStateWithActiveSession`
([location-tracking.ts:432](../apps/driver/lib/location-tracking.ts)), the
self-heal path for a driver who is mid-shift on a device where
`startSessionTracking` never ran. Without a stored `startYard` that shift
silently gets no reminder. The fence is recovered by reading `startYardId`
off the session and looking it up in the cached fence list.

---

## 6. Delivery — frame 04c

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
- **Tap** (no action button) deep-links into the app with the reminder banner
  showing, i.e. frame 04d.
- The ongoing shift-status notification and the Live Activity stay exactly as
  they are. If a status line is wanted, `updateShiftStatus('Back at the yard
  — end shift?')` is a free, silent addition.

**Open behavioral question — see §11:** whether "End shift" from the
notification ends the shift outright, or opens the app to the confirmation
sheet. The sheet is the current UX and carries the elapsed/loads/miles/stops
summary; ending from the lock screen is faster but skips the active-load
warning path.

If notification permission is denied, the feature degrades to the in-app
banner only. It never becomes a blocker.

---

## 7. In-app states — frames 04d, 04e, 04f

The dashboard reads the same device reminder state.

- **04d `active`** — banner above the load list: back at the yard, shift
  elapsed, `End shift` / `Still working`.
- **04e `muted`** — "Still working" sets `remindedThisVisit` and the banner
  collapses to the existing On-duty pill. Nothing else changes.
- **04f `ended`** — the post-end off-duty state.

`EndShiftSheet` has to be lifted out of `more.tsx` into a shared component so
the dashboard, the More tab, and the notification deep-link all present the
same sheet with the same active-load handling. That refactor is the bulk of
the UI work; the banner itself is small.

Exact copy and button order to follow `lib/end-shift-reminder.jsx` from the
design bundle **(not yet received — see §11)**.

---

## 8. Flag and telemetry

Flag `shift_end_reminder_enabled` in `feature-flags.ts`, defaulting **false**
until a pilot org confirms the fences are drawn where drivers actually park.

Events, in the `trackX` convention of `lib/analytics.ts`:

| Event | Fired when |
|---|---|
| `shift_reminder_armed` | Start yard resolved at shift start (and when it is not — with a reason: no yards, outside all fences, no fix) |
| `shift_reminder_fired` | `outside → inside` at the start yard; carries shift elapsed and distance |
| `shift_reminder_action` | `end` / `still_working` / `ignored`, and the surface (notification vs banner) |
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
- **Device state is not durable across reinstall.** Recovered via
  `startYardId` on the session (§5), but a reinstall mid-shift before that
  field ships loses the arm.
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

1. **Design source.** `lib/end-shift-reminder.jsx` and the reminder-aware
   `lib/dashboard-screen.jsx` were not in the handoff bundle — the index HTML
   references them but the `lib/` folder does not contain them. Needed for
   exact copy, button order, and the muted-state treatment.
2. **Notification "End shift": inline or open the app?** Inline is one tap
   from the lock screen. Opening the app shows the shift summary and the
   active-load warning. If inline, decide what happens when the driver still
   has an ACTIVE leg — `endSession` does not block, it just closes the legs.
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
2. `yardLocations.listForDriver` + device cache. Also inert.
3. Fence evaluation in the background task, behind the flag, **telemetry
   only** — no notification. Run it for a week on a pilot org and compare
   `shift_reminder_fired` against the org's actual `auto_timeout` /
   `next_session_opened` rate. This is the step that proves the fences are
   drawn correctly, and it is the step most likely to be skipped.
4. The notification (04c) + channel + categories.
5. `EndShiftSheet` extraction, then the dashboard banner (04d/04e/04f).
