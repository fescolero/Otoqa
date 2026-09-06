# Load status — one source of truth

**Why this exists.** On 2026-09-05 load 121536139 read four different ways
at once: the web load page said *In transit · 50% complete*, its Stops table
said *Delivered* on all four stops, the dispatch Schedule bar was green
*Completed*, and the driver app would have said something else again. Each
surface computed status from a different field, and nothing reconciled
them. This document is the contract that replaced that.

## The rule

A load's status, its percent complete, and each stop's state are derived in
**one place on the server**, `convex/_helpers/loadProgress.ts`
(`deriveLoadProgress`). Every query that projects a load carries the result
as `progress`, and every client renders from it:

| Surface | Query | Reads |
|---|---|---|
| Web load page | `loads.getLoad` | `progress` (full) |
| Web Schedule bar + drawer | `dispatchLegs.getOrgSchedule`, `loads.getLoadStops` | `displayStatus`, `load.progress`, per-stop `progress` |
| Driver app trip screen | `driverMobile.getLoadWithStops` | `progress` (full), overlaid with the phone's unsynced taps |
| Driver app dashboard | `driverMobile.getMyAssignedLoads` | `progress` (compact) |
| Dispatcher app board / history / load | `dispatchMobile.listActiveAssignments`, `listDriverHistory`, `getLoadDetail` | `progress`, `statusLabel` |

No client may recompute status or percent from `status`, `trackingStatus`,
`checkedInAt`, `checkedOutAt`, or a dispatch leg's `status`. If a screen
needs something `progress` does not carry, add it to the helper.

## What `progress` says

- `status` — `open | assigned | in_transit | delivered | canceled | expired`.
  Derived from the load row *and* the stops: a load whose counted stops are
  all closed reads `delivered` even if the row still says Assigned, and
  `recordedStatus` exposes the row so the lag is visible, never hidden.
- `percent` — closed counted stops over counted stops. Counted = not a
  detour, not canceled. Closed = departed by any source. The web used to
  count check-ins over all stops and the driver app check-outs over
  non-detours; they now agree by construction.
- `stops[]` — per stop: `phase` (`pending | arrived | departed | canceled`),
  an `arrival` and `departure` event with **provenance**, a display `label`,
  and `supported` (every closed event is backed by a driver tap).
- `evidence` / `evidenceLabel` / `closedBy` — the load-level roll-up of that
  provenance.
- `completionSource` — who completed the load row (below).

## Provenance: supported vs. assumed

The driver's tap is the primary record. Everything else is a fallback, and
the derivation says which one closed each event:

| `source` | Meaning | Data |
|---|---|---|
| `manual` | Tap reached the server before the geofence fallback fired | `checkedInAt` / `checkedOutAt`, no `auto*At` |
| `manual_late_sync` | Tap was made in time but reached the server late (offline queue, timeout replay) | tap + `auto*At`, tap time < detection + grace |
| `manual_late_tap` | Driver tapped after the fallback had already fired | tap + `auto*At`, tap time ≥ detection + grace |
| `gps` | No tap ever arrived; the geofence closed the event | `auto*At` only |
| `reported` | Status set with no timestamped evidence (`updateStopStatus`, dispatcher edit, legacy row) | `status` only |

Two fields make the first three distinguishable:

- `loadStops.checkedInSync` / `checkedOutSync` — written with every tap:
  `receivedAt` (server time), and for replays from the driver app's offline
  queue, `replayed`, `queuedAt`, `retryCount`. `syncLagMs` on the event is
  `receivedAt − tap time`.
- When a tap lands on a stop the fence already closed, the server logs an
  info `geofence.late_checkin_synced` / `late_checkout_synced` event next to
  the earlier `geofence.missed_checkin` coaching item, so the console can
  pair the accusation with its correction.

Chips render the suffix: *Delivered*, *Delivered · GPS*, *Delivered ·
synced late*, *Delivered · tapped late*, *Delivered · reported*. Unsupported
closures get the attention tint on the web and a `· GPS` note on mobile.

## Completing the load

Only the driver's final check-out used to complete a load. Now
`convex/lib/loadCompletion.ts` (`reconcileLoadCompletion`) runs from every
path that can close a stop or a leg without that tap, and completes the load
through the same status helper the tap uses, stamping
`loadInformation.completionSource`:

| Path | `completionSource` |
|---|---|
| Driver's final check-out tap | `driver_checkout` |
| Geofence grace check closes the last open stop | `geofence` |
| Shift end closes the leg and every stop is already closed | `session_end` |
| Dispatcher status picker | `dispatcher` |
| Carrier marketplace `completeLoad` | `carrier` |
| Hourly `loads:reconcileStuckLoads` sweep (safety net for rows stranded before this existed) | `reconcile` |

A shift end with stops still open leaves the load Assigned. That is the
honest state, and the Schedule renders the leg as *Ended · load open* rather
than *Completed*. A driver tap that replays after an inferred completion
upgrades `completionSource` to `driver_checkout` and keeps the original
`deliveredAt`.

## Adding a new surface

1. Call `loadProgressForLoad(ctx, load, stops?)` (or `deriveLoadProgress`)
   in the query and return it, whole or compacted.
2. Render `progress.label` / `progress.percent` / `stops[].label`; show the
   provenance suffix wherever a closed stop is shown.
3. Add a case to `convex/_helpers/loadProgress.test.ts` if you need a rule
   the helper does not have. Do not add the rule in the client.
