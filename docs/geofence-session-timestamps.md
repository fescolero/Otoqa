# Geofence Stop Timestamps on Driver Sessions (Phase 3)

## Problem

Phases 1–2 built the driver-session system and a geofence evaluator that fires
one-shot `APPROACHING` / `ARRIVED` events into `geofenceEvents` as GPS pings
stream in. But today:

1. **`geofenceEvents` has zero readers.** Events are logged and never surfaced
   anywhere — no dispatcher view, no timeline, no dwell numbers.
2. **There is no departure detection.** The most valuable timestamp pair in
   freight visibility — facility arrival → facility departure — is half
   missing, so detention/dwell time can only be derived from manual
   check-in/check-out taps, which measure paperwork, not time on site.
3. **Stop-1/stop-2 event gap.** The frontier was initialized *at* the stop the
   driver just checked into, so stop 1 got a degenerate ARRIVED (fired while
   already parked there) and stop 2 never got approach/arrival events at all
   (the frontier only advanced past it on the *next* check-in).
4. **`loadTrackingState.ts`'s five `internalMutation`s were dead code** —
   `checkInAtStop`, `checkOutFromStop`, and `handoffLoad` each re-implemented
   the same frontier logic inline.

## What this feature adds

Automatic, immutable, geofence-derived **arrival and departure timestamps per
stop**, attached to the driver's session, with **dwell minutes** computed and
surfaced on the dispatcher's driver-detail Sessions tab.

### Industry grounding (why these numbers)

Design follows what freight-visibility platforms (Samsara, Motive, project44,
FourKites) converged on:

- **Server-side evaluation** of the existing ping stream (not OS geofencing):
  we already stream background GPS to Convex; server-side gives unlimited
  fences, tunable logic without app releases, and a full audit trail. iOS
  caps monitored regions at 20 and Android throttles background callbacks.
- **Hysteresis**: exit ring larger than the entry ring (ours: 1207 m exit vs
  804 m arrival, ×1.5) so yard loops and GPS jitter can't flap the state.
- **Consecutive-ping confirmation** for exit (2 qualifying pings outside),
  with the *first* outside ping's timestamp recorded as the departure time —
  the confirmation delay must not shave minutes off a detention clock.
- **Accuracy gating**: pings with horizontal accuracy worse than 100 m are
  ignored for departure decisions (mobile already filters at 50 m; this is
  server-side defense in depth for the new logic).
- **Immutable event log**: geofence timestamps are append-only evidence.
  Manual check-in/check-out stamps live separately on `loadStops`; the
  timeline shows both side by side ("detected" vs "reported"), which is
  exactly the dispute-resolution record detention claims need.
- **Detention highlight at 120 min**: the industry-standard 2 hours of free
  time before detention billing starts.

## Data model changes (all additive / widening — no migration)

### `geofenceEvents`
- `eventType` gains `'DEPARTED'`.
- New optional `accuracy` (m) — recorded on new events for auditability.
- New index `by_session` (`['sessionId', 'triggeredAt']`) powering the
  session timeline query.

### `loadTrackingState`
- `currentStopSequenceNumber/Lat/Lng` become **optional**: after check-in at
  the final stop there is no next arrival target. Existing rows stay valid.
- New **`departureWatch`** — a single optional object (partial states are
  unrepresentable) holding the fence being watched for exit:
  - `stopSequenceNumber/lat/lng` — set on check-in, cleared when DEPARTED
    fires (and on handoff — see below).
  - `armedAt` — the check-in time; pings recorded at/before it are
    offline-backlog en-route fixes and never drive exit decisions.
  - `candidateAt` — timestamp of the first qualifying outside ping; a
    second, strictly newer outside ping confirms the departure. Only a
    newer inside ping can reset it (a stale one proves nothing).
- `loadCompleted` — set on last-stop checkout when a departure watch is still
  pending; the row is kept alive (instead of deleted) purely to resolve the
  final departure, then deleted by the evaluator. Cleared again if a
  post-completion re-check-in revives the row.
- New index `by_session` for post-completion scheduling and session-end
  cleanup. (`dispatchLegs` also gains `by_session` for the timeline query.)

## Behavior changes

### Check-in (`driverMobile.checkInAtStop`)
One unified path (was two divergent branches) via shared helpers in
`convex/loadTrackingState.ts`:
- **Arrival watch** advances to the next upcoming non-detour, non-canceled
  stop *after* the checked-in stop (fixes the stop-1/stop-2 gap; the old code
  pointed the frontier at the stop being checked into on stop 1).
- **Departure watch** is set on the checked-in stop (when it has coordinates).
- `sessionId`/`driverId` are re-stamped on every check-in, so post-handoff
  events attribute to the relay driver's session (previously they stuck to
  the original session forever).

### Checkout (`driverMobile.checkOutFromStop`)
- Non-final stops: unchanged.
- Final stop: if a departure watch is pending, the tracking row is kept with
  `loadCompleted: true` so the driver's actual facility exit still gets
  timestamped; otherwise deleted as before.

### Evaluator (`convex/geofenceEvaluator.ts`)
- APPROACHING/ARRIVED logic unchanged, except events are **deduped** against
  the `by_load_stop_event` index before insert (flag resets / handoffs can no
  longer double-fire an event type for a stop).
- New departure state machine per ping (accuracy-gated, `armedAt`-gated):
  `inside → candidate (first ping > 1207 m) → confirmed (second, newer ping
  outside)`. `DEPARTED.triggeredAt` = the candidate ping's `recordedAt`.
  Timestamp granularity is the mobile sync cadence — the recorded exit time
  is the first post-exit *synced* fix, not the physical boundary crossing.
- Events attribute to the **session of the triggering ping** (falling back
  to the row's sessionId for legacy loadId-only pings), so post-handoff and
  post-rollover events land on the shift whose GPS produced them.
- After the final stop's DEPARTED fires on a `loadCompleted` row, the row is
  deleted.

### Ping ingestion (`convex/driverLocations.ts`)
- Evaluator targets are keyed per (session, load) pair — a batch spanning a
  session rollover still evaluates both sessions' latest pings — and are the
  union of (a) the existing loadId + ACTIVE-leg path and (b) any
  `loadTrackingState` rows found via `by_session` for sessions in the batch.
  Path (b) is what lets a departure resolve *after* last-stop checkout, when
  pings have reverted to `SESSION_ROUTE` (no `loadId`, leg COMPLETED); it
  only runs for batches that actually contain session-route pings, and skips
  rows whose driverId no longer matches the session (handed-off loads).
- Pings now carry `accuracy` and their `sessionId` into the evaluator.

### Handoff (`dispatchLegs.handoffLoad`)
- The frontier transfers to the relay driver **and their active session**
  (when they have one), and the departure watch is cleared — it tracked the
  from-driver's physical presence; the relay's own check-in re-arms it.

### Session end (`driverSessions.endSessionInternal` / `startSession`)
- Terminal ends delete any `loadCompleted` tracking rows for the session
  (the driver is done pinging — the timeline falls back to the manual
  checkout time). Mid-load rows are left alone, exactly as before.
- Same-driver rollover (`next_session_opened`) instead **re-binds** those
  rows to the new session, so the still-inbound pings resolve the final
  DEPARTED. Last-stop checkout likewise re-binds the kept row to the
  driver's current session when check-in happened under an earlier one.

### Timeline query (`driverSessions.getSessionStopTimeline`)
Dispatcher-authed query joining `geofenceEvents` (`by_session`) with the
session's legs (`by_session`) → loads → stops. Returns one row per stop:
`approachingAt / arrivedAt / departedAt` (geofence, ms), `checkedInAt /
checkedOutAt` (manual, ISO→ms — only when they fall inside the session's
time window, so shared stops don't leak another shift's taps), and
`dwellMinutes` computed as
`(departedAt ?? checkedOutAt) − (arrivedAt ?? checkedInAt)`.

### UI (`components/sessions/driver-sessions-history.tsx`)
Session rows expand to show the per-stop timeline: geofence-detected times
alongside manual taps, dwell badge, detention (>120 min) highlighted with the
warning variant. shadcn primitives + lucide icons + semantic color tokens,
matching the existing table.

## Non-regression analysis

- **Schema**: only optional fields, a widened union, and new indexes.
- **Mobile app**: untouched — everything is server-side.
- **Hot path cost**: +1 indexed read per session per ingest batch (the
  `by_session` watch lookup, ~0–2 rows) and, only when an event actually
  fires, one dedup read. Frontier writes stay at ≤ a handful per stop.
- **Reactive-query hygiene preserved**: no new per-ping writes to
  `driverSessions` or other dashboard-subscribed tables; all ping-rate state
  stays on `loadTrackingState` (the table designed for it).
- **Existing events**: APPROACHING/ARRIVED semantics unchanged for stops ≥ 2;
  the degenerate stop-1 self-arrival events (write-only, never read by
  anything) no longer fire — the frontier now correctly watches the *next*
  stop.
- **Handoff**: unchanged flow; frontier fallback for the relay start stop now
  also considers the departure-watch stop when there is no arrival target
  (post-final-check-in handoffs).

## Known limitations (accepted, documented)

- **Closely spaced stops** (< ~1.2 km apart): checking in at the next stop
  re-targets the departure watch before the previous stop's exit could
  confirm; that stop's departure falls back to its manual checkout time.
- **Stop 1 arrival** is still anchored to check-in: pre-check-in pings carry
  no `loadId` and no tracking row exists yet, so true pickup-approach
  detection would need PENDING-leg evaluation — a candidate Phase 4 along
  with org-configurable radii and a detention push alert at the 2-hour mark.
- Radii are constants in `convex/lib/geo.ts` (`INNER_RING_METERS` 804,
  `DEPARTURE_RING_METERS` 1207, `OUTER_RING_METERS` 8047), chosen inside the
  industry-typical band; per-org/per-facility overrides are deliberately
  deferred until someone needs them.
