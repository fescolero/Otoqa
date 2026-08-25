# R12 — Driver Availability

Status: proposed. Follows the auto-assignment work in
[auto-assignment-scheduling-spec.md](./auto-assignment-scheduling-spec.md),
which deliberately left this out of scope.

**The problem in one line:** a driver out sick keeps getting loads.

The system already has a *name* for this failure — `DRIVER_UNAVAILABLE` is a
carrier-assignment cancellation reason
([schema.ts:460](../convex/schema.ts)). It records the outcome after a load
has already fallen through. There is nothing that prevents it.

---

## What availability means today

Three axes exist. The one dispatch actually needs is missing.

| Axis | Question | Where | State |
|---|---|---|---|
| Real-time state | "What is this driver doing right now?" | `driverStatus()` ([dispatchMobile.ts:793](../convex/dispatchMobile.ts)) — moving / idle / late / offline | **Works.** Derived from legs + GPS, never guessed. |
| Employment | "Do they work here?" | `employmentStatus` ([schema.ts:736](../convex/schema.ts)) — Active / Inactive / On Leave | **Blunt.** No dates, indefinite, and an HR field nobody flips for a two-day flu. |
| Qualification | "Are they legally allowed to drive?" | `licenseExpiration`, `medicalExpiration`, `twicExpiration` | **Stored and displayed, never enforced** — see §5. |
| **Planned absence** | **"Are they here on the 14th?"** | — | **Missing. This spec.** |

Every assignment path gates on exactly one thing:
`!driver || driver.isDeleted || driver.employmentStatus !== 'Active'`
([dispatchLegs.ts:353](../convex/dispatchLegs.ts),
[:556](../convex/dispatchLegs.ts),
[autoAssignment.ts:185](../convex/autoAssignment.ts),
[:599](../convex/autoAssignment.ts)).

So today's only levers are: set `employmentStatus` to `On Leave` (blocks
everything, indefinitely, until someone remembers to flip it back), or
deactivate the route (blocks the route, for everyone).

Per-route `activeDays` does **not** help and should not be stretched to: it
encodes a *recurring pattern* ("this route runs Mon/Wed/Fri"), not an
*exception* ("Dave is out next week"). Conflating them means editing a
route's permanent schedule to record a temporary absence, and forgetting to
undo it.

---

## 1. Schema

```ts
driverTimeOff: defineTable({
  workosOrgId: v.string(),
  driverId: v.id('drivers'),

  // Business-local YYYY-MM-DD, both INCLUSIVE. Same calendar space as
  // loadInformation.firstStopDate and routeAssignments.activeDays — see §3.
  startDate: v.string(),
  endDate: v.string(),

  reason: v.union(
    v.literal('SICK'),
    v.literal('VACATION'),
    v.literal('PERSONAL'),
    v.literal('TRAINING'),
    v.literal('SUSPENDED'),
    v.literal('OTHER'),
  ),
  notes: v.optional(v.string()),

  // Soft-cancel: a driver coming back early is a fact worth keeping, and
  // deleting the row loses "why was this load reassigned in March".
  canceledAt: v.optional(v.number()),
  canceledBy: v.optional(v.string()),

  createdBy: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_driver_start', ['driverId', 'startDate'])
  .index('by_org_start', ['workosOrgId', 'startDate']),
```

Plus one denormalized field on `loadInformation`:

```ts
lastStopDate: v.optional(v.string()), // YYYY-MM-DD, mirror of the last stop
```

`syncFirstStopDate` ([loads.ts:531](../convex/loads.ts)) already computes
`lastDelivery` ([:547](../convex/loads.ts)) — it just doesn't persist a
date from it. Needed for §4's span check, and it costs one line in a
function that already runs on every stop mutation.

## 2. The query shape

`by_driver_start` answers "is this driver off on date D" with a range scan:
`startDate <= D`, then filter `endDate >= D` in JS. Open-ended absences are
not modeled — an indefinite absence is what `employmentStatus: 'On Leave'`
is for, and giving it two representations invites disagreement.

Bound the scan by only looking at rows whose `startDate` is within a
lookback window (say 400 days) rather than scanning from the beginning of
time.

## 3. Dates, not timestamps — and no timezone

`startDate`/`endDate` are whole business-local days, matching
`firstStopDate` and feature A. The reasoning from that spec applies
unchanged: `firstStopDate` is sliced off an offset-carrying
`windowBeginDate`, so it is already local to the pickup facility, and a
bare-string date comparison gives the day a dispatcher would name. No
`Intl`, no timezone column, no DST.

**Half-days are deliberately out of scope for v1.** A partial-day absence
has to intersect a leg's actual time range rather than a calendar date,
which pulls in the facility timezone and the whole `getLegTimeRange`
machinery. It is a real need (a morning doctor's appointment) but it is a
different feature; §8 sketches the extension.

## 4. One availability check, not four

Every caller currently repeats the same `employmentStatus` condition inline.
Adding two more conditions to four copies is how this ships inconsistently —
the same mistake the route matcher already had. Extract one function:

```ts
// convex/lib/driverAvailability.ts
export type UnavailableReason =
  | 'DELETED' | 'NOT_EMPLOYED'
  | 'TIME_OFF' | 'LICENSE_EXPIRED' | 'MEDICAL_EXPIRED';

export type Availability =
  | { available: true }
  | { available: false; reason: UnavailableReason; detail: string };

export async function driverAvailability(
  ctx: QueryCtx | MutationCtx,
  driverId: Id<'drivers'>,
  /** Service date(s) the load occupies. Omit to check "today". */
  span?: { from: string; to: string },
): Promise<Availability>;
```

**Check the whole span, not just the pickup date.** A driver on vacation
Wednesday should not be delivering Wednesday, even if pickup was Monday.
`from = firstStopDate`, `to = lastStopDate ?? firstStopDate` — which is why
§1 denormalizes the second one. Absence overlaps the load when
`startDate <= to && endDate >= from`, the same interval test
`doTimeRangesOverlap` uses on timestamps.

Then replace the four inline conditions with a call to it.

## 5. Qualification expiry — the adjacent gap, arguably worse

`licenseExpiration` and `medicalExpiration` are stored
([schema.ts:728](../convex/schema.ts)), projected to the driver detail
screen ([dispatchMobile.ts:2009](../convex/dispatchMobile.ts)), rendered
with an expiring/expired chip via `getExpirationStatus`
([dateUtils.ts:82](../convex/_helpers/dateUtils.ts)) — **and never checked
when assigning a load.** A driver whose medical card expired last month is
not legally available, and nothing stops the system from dispatching them.

That is a DOT compliance exposure, not a convenience gap, and it is the same
shape as time off: a date-bounded reason this driver cannot take this load.
It belongs in the same function, checked against the same span. **Ship it in
the same change** — it is a few lines once `driverAvailability` exists, and
splitting it means writing the plumbing twice.

Recommend hard-blocking expiry on **both** paths (manual included), unlike
time off in §6. "The dispatcher knows better" is a legitimate argument about
whether someone will be back from vacation early. It is not a legitimate
argument about a lapsed medical certificate.

## 6. Where it is enforced: decline for the robot, warn for the human

Mirror the split R9 established for schedule overlaps
([dispatchLegs.ts:545](../convex/dispatchLegs.ts)) — that pattern is now the
house style for "the system found a problem with an assignment":

- **Auto-assignment declines.** New `AutoAssignResult` action
  `DRIVER_UNAVAILABLE`, load stays `Open`.
- **Manual assignment warns and proceeds.** A dispatcher may know the driver
  is cutting a trip short. Return the conflicting absence alongside the
  success, exactly as `overlaps` is returned today.
- **Expiry blocks both** (§5).

Implementation: extend `assignDriverInternal`'s existing
`blockOnOverlap` flag, or generalize it to `blockOnConflict`. Do not add a
second boolean — two independent flags produce four states, three of which
nobody wants.

## 7. Fall-through: the part that makes this worth building

A route rule pointing at an unavailable driver should be **passed over so
the next candidate can match**, not treated as "no route exists" — the same
behavior day restrictions already have
([routeMatch.ts:85](../convex/lib/routeMatch.ts) and §A.5 of the
auto-assignment spec).

That is the actual payoff: mark Dana out sick for a week, and her routes
flow to the backup carrier rule automatically for exactly that week, then
flow back. Without fall-through this feature only stops bad assignments;
with it, the system covers for the absence.

It does mean `matchRouteAssignment` gains a driver read per candidate.
Per-(org, HCR) row counts are small — the same reasoning that justified
collecting and sorting in JS — but it moves the matcher from pure-
`routeAssignments` to cross-table, so measure before assuming.

## 8. Reporting reuses R9

`DRIVER_UNAVAILABLE` needs to appear in three places that already exist:

1. The `byAction` breakdown on the sweep, surfaced by the settings page's
   last-run panel. Add a label to `ACTION_LABELS`.
2. `noteDecline` ([autoAssignment.ts:473](../convex/autoAssignment.ts)) —
   an actionable decline, so it earns an `auto_assign_skipped` audit row on
   the load.
3. The skipped/error bucket split — it is a **skip**, not an error.

## 9. The operational half everyone forgets

Creating time off must surface **loads already assigned to that driver in
the window.** Nobody calls in sick before the loads are assigned; the flow
is "Dana just called, she's out Thursday" and there are already three loads
on her board.

So the create-time-off mutation returns the conflicting assignments, and the
UI lists them with an action to unassign. This is the single most useful
thing in the feature and it is easy to leave out, because the happy path
(booking vacation a month ahead) never exercises it.

Note `unassignResource` sets `autoAssignOptOut`, so a load pulled off a sick
driver stays off. That is correct here — a human decides where it goes — but
it means the fall-through in §7 covers *future* loads, not ones already
assigned.

## 10. Surfaces

- **Driver detail** — a time-off list with add/cancel. The natural home.
- **Dispatch board driver list** — `driverStatus()` gains an `off` state,
  ahead of `idle`. A driver who is off is not "genuinely available", which
  is what `idle` currently claims ([dispatchMobile.ts:793](../convex/dispatchMobile.ts)).
- **AutoAssignModal** — warn when the selected driver has upcoming time off.
  Cheap, and catches the "why isn't this route firing" question before it
  gets asked.
- **Driver mobile** — read-only view of their own time off in v1. Self-service
  requests with an approval flow are a separate feature; do not let it creep
  in here.

## 11. Open questions

1. **Half-days** (§3). Extension path: add optional `startTime`/`endTime`,
   and when present intersect against `getLegTimeRange` instead of dates.
   Needs the facility timezone; do not start here.
2. **Should `SUSPENDED` hard-block manual assignment?** It is not a judgment
   call the way vacation is. Leaning yes, which would make §6 reason-
   dependent rather than uniform.
3. **Recurring unavailability** ("never Sundays"). That is a route-level
   pattern and `activeDays` already expresses it. Resist adding a second
   mechanism.
4. **Does time off imply the truck is free?** `currentTruckId` stays bound to
   the driver. Probably out of scope, but worth confirming nobody expects
   equipment to be released.

## Suggested order

1. `driverAvailability` + the four inline `employmentStatus` checks replaced
   by it. No behavior change — pure consolidation, ships and verifies alone.
2. Expiry enforcement (§5) inside that function. Small, high value, and
   independent of the new table.
3. `driverTimeOff` table, CRUD, and the §9 conflicting-loads response.
4. Enforcement (§6) + fall-through (§7) + reporting (§8).
5. Surfaces (§10).
