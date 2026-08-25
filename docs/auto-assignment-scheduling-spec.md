# Auto-Assignment Day Scheduling — Spec + Review

Status: in progress. Covers two independent features that both answer "which
days does auto-assignment run?" — they mean different things and only one of
them is safe to ship alone.

**Done:** R11, the matcher extraction, feature A, R9, and R5. Remaining loose
ends: R3/R4 (settings-form mechanics), R12/R13 (driver availability,
`employmentStatus` union).

Also shipped, not in the original review:

- Two rules may share an HCR + Trip when their service days are disjoint.
  The pre-calendar "one rule per HCR + Trip" guard rejected exactly the
  configuration feature A exists to express.
- **The third matching tier was removed.** "Any active route on this HCR"
  let a rule scoped to Trip 1 claim loads on Trip 821 — see R14.

Today neither exists. `autoAssignmentSettings` has `enabled`,
`triggerOnCreate`, `scheduledEnabled`, `scheduleIntervalMinutes`
([schema.ts:1220](../convex/schema.ts)); `routeAssignments` has `hcr`,
`tripNumber`, target, `priority`, `isActive`
([schema.ts:1113](../convex/schema.ts)). No calendar on either.

---

## Two different questions wearing one name

| | A — Per-route service days | B — Org-level run window |
|---|---|---|
| Means | "Driver runs 917DK on Mon/Wed/Fri" | "The robot only works business hours" |
| Anchored to | the **load's service date** (`firstStopDate`) | the **wall clock** (`Date.now()`) |
| Effect on a non-matching load | no match → stays Open for a human | deferred → **expires unseen** (R1) |
| Needs a timezone | **No** (see A.3) | Yes |
| Verdict | **Build it** | **Rejected** — see B |

**A is the feature.** It is what dispatch means by "which days does this
route run," it is timezone-free, and it cannot lose a load. B was
investigated and cut: it duplicates a control that already exists, cannot
deliver what it appears to promise, and destroys loads. The real need it
gestured at is R9.

---

# A — Per-route service days

## A.1 Schema

```ts
// routeAssignments — additive, both optional
activeDays: v.optional(v.array(v.number())),   // 0=Sun … 6=Sat; ABSENT = every day
excludeFederalHolidays: v.optional(v.boolean()),
customExclusions: v.optional(v.array(v.string())), // ["2026-12-25"]
```

Mirrors `recurringLoadTemplates` ([schema.ts:1189](../convex/schema.ts))
deliberately — same field names, same 0=Sun convention, same
`YYYY-MM-DD` exclusion format. The two now describe the same calendar from
opposite ends (one generates loads, one assigns them), and the shared shape
lets `route-assignments-table.tsx` render both rows through one column.

**Absent = every day.** Every existing row keeps today's behavior with no
backfill. `[]` is rejected at the mutation, not treated as "all" — see R6.

No index change. `activeDays` is an array; Convex cannot express
"array contains" in `.filter()` or an index, so the day test happens in JS
after `.collect()` — see A.4.

## A.2 Semantics

A route matches a load when **all** hold:

1. `isActive === true`
2. HCR (and trip, for the exact tier) match — unchanged
3. `activeDays` is absent, **or** contains the load's service weekday
4. `excludeFederalHolidays` is off, **or** the service date is not a federal holiday
5. the service date is not in `customExclusions`

Service date = `load.firstStopDate` (`YYYY-MM-DD`, denormalized from
`loadStops[seq=1].windowBeginDate` by `syncFirstStopDate`,
[loads.ts:531](../convex/loads.ts)).

## A.3 Timezone: not needed, on purpose

`firstStopDate` is already a **business-local calendar date** — it is
sliced off the stop's `windowBeginDate`, which FourKites and the create form
both write in the facility's own local time (the stop even carries its own
IANA `timeZone`, [schema.ts:1686](../convex/schema.ts)).

So the weekday is a pure string operation:

```ts
const dow = new Date(`${firstStopDate}T00:00:00.000Z`).getUTCDay();
```

This is exactly what `generateLoadsForOrg` already does on the pickup date
([recurringLoads.ts:593](../convex/recurringLoads.ts)). No `Intl`, no DST,
no config. **A route's "Monday" is Monday at the pickup facility**, which is
what a dispatcher means. Do not add a timezone field to `routeAssignments`.

Verified, not assumed: FourKites appointments arrive as ISO strings carrying
a local offset, and the importer takes `.split("T")[0]`
([fourKitesUtils.ts:229](../convex/fourKitesUtils.ts),
[:288](../convex/fourKitesUtils.ts)) — which preserves the **local** calendar
date and deliberately differs from the UTC date for evening appointments.
A test pins the behavior: `'2026-07-25T03:45:00-07:00'` → `'2026-07-25'`
([fourKitesUtils.stops.test.ts:175](../convex/fourKitesUtils.stops.test.ts)).

## A.4 Where the rule goes — and the refactor it forces

Route matching is currently **duplicated across four places**, three of which
drift:

| Location | Tiers | Live? |
|---|---|---|
| `autoAssignLoad` [autoAssignment.ts:168](../convex/autoAssignment.ts) | exact → HCR-only → any-active | yes (sweep) |
| `triggerAutoAssignmentForLoad` [autoAssignment.ts:509](../convex/autoAssignment.ts) | exact → HCR-only → any-active | yes (on create) |
| `findRouteAssignment` [autoAssignment.ts:63](../convex/autoAssignment.ts) | exact → HCR-only → any-active | **dead — no callers** |
| `getByRoute` [routeAssignments.ts:155](../convex/routeAssignments.ts) | exact → HCR-only **only** | yes (UI preview) |

Adding the day rule to two of four is how this ships broken. **Extract one
matcher first**, as a plain exported function (not a Convex query — it must
be callable from both a query and a mutation ctx):

```ts
// convex/lib/routeMatch.ts
export async function matchRouteAssignment(
  ctx: QueryCtx | MutationCtx,
  a: { workosOrgId: string; hcr: string; trip?: string; serviceDate?: string },
): Promise<{ route: Doc<'routeAssignments'> | null; reason?: SkipReason }>
```

Each tier becomes collect → filter → sort → take-first:

```ts
const candidates = (await ctx.db
  .query('routeAssignments')
  .withIndex('by_org_hcr', q => q.eq('workosOrgId', orgId).eq('hcr', hcr))
  .collect())
  .filter(r => r.isActive)
  .filter(r => tierPredicate(r))
  .filter(r => servesDate(r, serviceDate))
  .sort((a, b) => a.priority - b.priority);
return candidates[0] ?? null;
```

Row counts per (org, HCR) are small — a handful — so the collect is cheap.
Then delete `findRouteAssignment` and point `getByRoute` at the shared
matcher so the UI preview stops disagreeing with the engine.

This refactor also fixes a real bug for free. **`priority` is dead today.**
The word appears exactly once in `autoAssignment.ts` — in a comment,
"Fall back to any active route for this HCR (highest priority first)"
([:97](../convex/autoAssignment.ts)) — and that comment sits inside the dead
`findRouteAssignment`. Every live matcher uses `.first()`, which returns
**index order**, not priority order. The field is stored, validated, edited
in the UI, and sorted in `list` ([routeAssignments.ts:92](../convex/routeAssignments.ts)),
but the assignment engine has never read it. The explicit `.sort()` above is
the first time `priority` decides anything.

## A.5 Fall-through, not short-circuit

A day-blocked route must be **skipped so the next candidate can match**, not
treated as "no route exists." Concretely: HCR 917DK with a Mon–Fri driver
route (priority 1) and an all-days carrier route (priority 2) should assign
to the carrier on Saturday. This falls out of the filter-then-sort shape
above; a naive `if (!servesDay) return NO_MATCH` after picking a winner
would get it wrong.

## A.6 Loads with no service date

`firstStopDate` is `undefined` when stops are TBD or the date is malformed
(`syncFirstStopDate` rejects anything not `^\d{4}-\d{2}-\d{2}$`,
[loads.ts:555](../convex/loads.ts)).

Policy: **if a candidate route has any calendar restriction and the load has
no service date, that route does not match.** Assigning a Mon/Wed/Fri driver
to a load whose date is unknown is a guess; leaving it Open puts it in front
of a dispatcher. Routes with no restriction still match — unrestricted
behavior is unchanged.

New result action `NO_SERVICE_DATE` on `AutoAssignResult`
([autoAssignment.ts:14](../convex/autoAssignment.ts)) so this is
distinguishable from a genuine `NO_MATCH` in the sweep counters. Note the
sweep's counter buckets ([autoAssignment.ts:371](../convex/autoAssignment.ts))
switch on `NO_MATCH | ALREADY_ASSIGNED` → `skipped`, everything else →
`errors`; new codes must be added there or they inflate the error count.

## A.7 API + UI

- `routeAssignments.create` / `.update`: accept the three new fields; reject
  `activeDays: []` with `ConvexError('Select at least one day')`.
- `list` / `get` / `getByRoute` return validators: add the fields (Convex
  validates returns — omitting them drops the data silently in the UI).
- `create-route-assignment-modal.tsx` / `edit-route-assignment-modal.tsx`:
  reuse `components/web/create-form/controls/days.tsx` (`DaysControl`), which
  already produces a sorted `number[]` in this exact shape. Gate it behind a
  "Runs only on specific days" switch; off writes `undefined`.
- `route-assignments-table.tsx`: it already renders `activeDays` for the
  recurring-template rows ([:68](../components/route-assignments/route-assignments-table.tsx));
  make the route-assignment rows use the same column.

---

# B — Org-level run window: rejected

Originally spec'd as `runDays` + `runWindowStart/End` + `timezone` on
`autoAssignmentSettings`, gating both the sweep and the create trigger on
the wall clock. **Do not build it.** Recorded here so the idea doesn't get
re-proposed.

Every motive for it fails on inspection:

| Motive | Why it fails |
|---|---|
| "Nobody's on duty overnight to catch a bad assignment" | Nothing is reported to catch, at any hour — see R9. A window shrinks the unreviewed span; it doesn't create a reviewer. |
| "Don't wake drivers with 3am assignments" | Assignment sends no notification. `internal.push` is wired only to `dispatchAlerts` ([dispatchAlerts.ts:55](../convex/dispatchAlerts.ts)); drivers see loads via the mobile app's reactive query. |
| "Rate / cost control on the sweep" | `scheduleIntervalMinutes` + `shouldRunInterval` ([cronUtils.ts:5](../convex/_helpers/cronUtils.ts)) already do this. |
| "Shut down for a holiday" | A's per-route `customExclusions` does it correctly — the route declines, the load stays `Open` for a human. B blocks *and* lets the load expire (R1). |

Plus R1: it destroys loads on exactly the days someone would enable it for.

The instinct behind B is sound — *auto-assign can make a call nobody
reviews.* The fix is R9, not a clock.

---

# Review — what's wrong, what's missing

## R1 — an `Open` load has a 6h fuse (kills B; constrains A)

`autoExpireStaleLoads` ([loads.ts:2962](../convex/loads.ts), hourly via
[crons.ts:205](../convex/crons.ts)) flips loads to `Expired` once they are
**≥6h past scheduled pickup with `trackingStatus === 'Pending'`**
([loads.ts:3071](../convex/loads.ts)). `Assigned` loads get a warning sweep
and a 20h grace first. `Open` loads do not — the code comment is explicit:
*Open (unassigned) loads still expire immediately*
([loads.ts:3036](../convex/loads.ts)).

That precondition holds for the loads in question: `trackingStatus` is
seeded `'Pending'` on manual creation ([loads.ts:1586](../convex/loads.ts))
and on recurring generation ([recurringLoads.ts:430](../convex/recurringLoads.ts)),
and `mapTrackingStatus` defaults to `'Pending'` for FourKites imports
([fourKitesUtils.ts:37](../convex/fourKitesUtils.ts)). An unassigned load is
Pending unless FourKites reports it already moving.

The auto-assign sweep reads `by_status` with `status: 'Open'`
([autoAssignment.ts:431](../convex/autoAssignment.ts)). Expired loads are
invisible to it, permanently.

So a weekend blackout does not produce "a Monday backlog." A Saturday-pickup
load is unassigned at 06:00, expired by ~14:00, and Monday's sweep finds
nothing. The feature silently destroys exactly the loads it claimed to
defer — and because auto-assign is the thing that would have moved them out
of `Open`, the blackout is what makes them eligible.

Precisely: the loss happens when the blackout covers a load's **own pickup
day**. A Monday-pickup load created Saturday is fine. Which means B is
harmless for an org with no weekend pickups — and for an org with weekend
pickups, it is destructive. Those are the only two cases, and in the first
one B does nothing worth having.

### This is not redundant now that B is cut — it constrains A

A's decline path lands in the same place. Restrict 917DK to Mon/Wed/Fri, and
a Tuesday-pickup load on that HCR declines → stays `Open` → expires 6h past
its pickup. Nobody is told at any point.

To be fair to A: that is the *same* fate the load would have had with no
auto-assignment configured at all. A does not make it worse than the
baseline. But it makes it worse than the operator **expects** — they wrote a
rule, and a rule that quietly declines looks identical to a rule that is
working. A introduces a new silent-decline path into a system where silence
costs you the load.

That is why R9 is not optional alongside A.

This finding is what killed B. It is recorded rather than mitigated: any
mitigation (narrow quiet-hours only / gate on service date instead / teach
the sweep to resurrect `Expired` loads) either reduces B to something A
already does, or is a much larger change touching status transitions,
`loadStatusCounts`, and billing — for a knob with no remaining purpose.

It also stands as a constraint on anything future that defers assignment:
**deferral is not free in this system.** An `Open` load has a 6h fuse from
its pickup time.

## R2 — `triggerOnCreate`-only orgs get permanent misses

If the day gate blocks the create trigger and `scheduledEnabled` is
`false`, nothing ever retries — `autoAssignPendingLoads` is the only
catch-up path and it returns immediately when `!settings.scheduledEnabled`
([autoAssignment.ts:331](../convex/autoAssignment.ts)).

Under A this is milder — a day-restricted route declines rather than
defers, so the load stays `Open` and visible. But an org running
`triggerOnCreate` alone still never revisits it if the route's day comes
around later (e.g. the pickup date is edited). Warn in the route-assignment
UI when day restrictions are set while `scheduledEnabled` is `false`.

## R3 — the save button will silently stop working

`auto-assignment-settings.tsx:86` computes `hasChanges` by comparing each
field by hand. New fields not added there → the user toggles days, Save
stays disabled, and nothing reports why. Array fields need a real
comparison, not `!==`.

## R4 — `updateSettings` cannot express "clear this field"

Every arg is `v.optional` with `undefined` meaning *don't change*
([routeAssignments.ts:579](../convex/routeAssignments.ts)), so there is no
way to send "remove the day restriction." Either add an explicit
`restrictDays: v.optional(v.boolean())` companion arg, or have the UI write
all seven days to mean unrestricted. Same problem on
`routeAssignments.update`.

## R5 — one dead trigger site is a landmine

`fourKitesSyncHelpers.createLoad` ([:164](../convex/fourKitesSyncHelpers.ts))
inserts a load and calls `triggerAutoAssignmentForLoad` **before any stops
exist** — `firstStopDate` is `undefined` there, so under A every restricted
route would decline.

It is currently harmless: nothing references
`internal.fourKitesSyncHelpers.createLoad` anywhere in `convex/`. The live
FourKites path is `importLoadFromShipment`, which calls
`syncFirstStopDateMutation` at [:391](../convex/fourKitesSyncHelpers.ts)
before triggering at [:420](../convex/fourKitesSyncHelpers.ts). **Delete the
dead function** as part of this work rather than leaving a wired-up
landmine.

Ordering verified good on all three live paths:

| Path | `firstStopDate` set | trigger |
|---|---|---|
| `createLoadForOrg` | [loads.ts:1684](../convex/loads.ts) | [:1742](../convex/loads.ts) |
| `generateLoadFromTemplate` | [recurringLoads.ts:507](../convex/recurringLoads.ts) | [:536](../convex/recurringLoads.ts) |
| `importLoadFromShipment` | [fourKitesSyncHelpers.ts:391](../convex/fourKitesSyncHelpers.ts) | [:420](../convex/fourKitesSyncHelpers.ts) |

`promoteUnmappedLoad` ([:732](../convex/fourKitesSyncHelpers.ts)) triggers on
a load that already went through import, so its date is already set — worth
one test asserting that, since promotion is the path that rewrites stops.

## R6 — `[]` must be an error, not a synonym for "all"

If empty arrays fall back to "no restriction," a dispatcher who deselects
every day gets *always on* — the exact opposite of the intent, with no
feedback. Reject at the mutation in both A and B.

## R7 — federal-holiday check needs a pure helper

`getHolidaySet` is module-private ([holidays.ts:108](../convex/holidays.ts));
only the `isFederalHoliday` **internalQuery** is exported
([:116](../convex/holidays.ts)). The day test in A runs inside
`triggerAutoAssignmentForLoad`, a mutation — export `getHolidaySet` and call
it synchronously rather than doing a `runQuery` per load. Keep the
per-run memo `generateLoadsForOrg` uses
([recurringLoads.ts:569](../convex/recurringLoads.ts)) for the sweep.

## R8 — the sweep query is the place to pay down existing debt

`getOpenLoadsWithHcr` ([autoAssignment.ts:425](../convex/autoAssignment.ts))
collects **every** Open load in the org, then does one `getLoadFacets` read
per load, then truncates to 4,000. It also does not return `firstStopDate`,
which A needs.

Since this function is being edited anyway: `by_org_status_first_stop`
([schema.ts:1652](../convex/schema.ts)) already exists and would let the
sweep range only the service dates that matter, replacing the full scan.
And the `results: AutoAssignResult[]` array returned by
`autoAssignPendingLoads` grows with every processed load — at the 4,000 cap
that is a large return payload against Convex's limits, and adding skip
reasons only grows it. Consider returning counts plus a bounded sample.

## R9 — overlap: auto-assign must decline where a human may proceed

Build this alongside A.

### Correction to the earlier draft

The overlap is not unrecorded. `logAudit` writes it into the assignment's
description — `"...to load 4471 (schedule overlap with Load #4470)"`
([dispatchLegs.ts:463](../convex/dispatchLegs.ts),
[:595](../convex/dispatchLegs.ts)). It is *unqueryable*, not invisible:
free text in an audit description, with no alert, no counter, and no way to
ask "which loads are double-booked right now."

### Warn vs. block is a per-caller decision

Today overlap **never blocks** — stated outright at
[dispatchLegs.ts:69](../convex/dispatchLegs.ts) and
[:414](../convex/dispatchLegs.ts). For the manual path
(`assignDriver`, [:338](../convex/dispatchLegs.ts)) that is *correct* and
should not change: a dispatcher looking at the driver's board who assigns
anyway is making a judgment call — maybe the first load will finish early,
maybe the windows are soft. Blocking that is paternalistic.

**Auto-assignment has no judgment.** An overlap there means the rule is
wrong or the data is wrong, and proceeding manufactures a double-booking
that nobody requested and nobody reviews. It should **decline**:

- new `AutoAssignResult` action `OVERLAP_CONFLICT`
- load stays `Open`, and the alert in step 1 below fires
- the dispatcher can still assign that driver by hand, warning and all

Mechanically, `assignDriverInternal` is shared by five call sites — auto
([autoAssignment.ts:227](../convex/autoAssignment.ts),
[:567](../convex/autoAssignment.ts)), direct-assign-at-create
([loads.ts:1713](../convex/loads.ts)), and mobile
([dispatchMobile.ts:1508](../convex/dispatchMobile.ts),
[:2086](../convex/dispatchMobile.ts)). Add
`blockOnOverlap: v.optional(v.boolean())` and pass `true` **only** from the
two auto-assignment sites. Do not change the shared default; the other three
are human-initiated.

Note this makes overlap-declines the most common new silent skip, which is
what the rest of R9 exists to surface.

### The reporting channel

1. ~~Raise a `dispatchAlerts` row~~ — **wrong, corrected during
   implementation.** `dispatchAlerts` is not a general alert table: its
   `assignmentId` is a required `v.id('loadCarrierAssignments')` and the
   whole dedupe index is keyed on it
   ([dispatchAlerts.ts:38](../convex/dispatchAlerts.ts),
   [schema.ts:510](../convex/schema.ts)). An auto-assignment decline has no
   carrier assignment, so using it would mean reshaping a table whose dedupe
   design is assignment-scoped. Built instead: a per-load audit row
   (`auto_assign_skipped`) written **only from the on-create path**, since
   the sweep re-evaluates every Open load every cycle and would rewrite the
   same row hourly.
2. Persist per-run outcomes so the settings page can show "last run:
   14 assigned, 3 skipped (2 no matching route, 1 no service date)". The
   counters exist in `runScheduledAutoAssignment`; they are summed,
   `console.log`'d, and dropped
   ([autoAssignmentCron.ts:114](../convex/autoAssignmentCron.ts)).
3. Structure the overlap in the audit row (conflicting `loadId`s as data,
   not prose) so "what is double-booked" becomes answerable.

## R11 — BUG TODAY: unassigning a load makes the robot re-assign it

Independent of A — this is live now.

`unassignResource` sets `primaryDriverId: undefined`,
`primaryCarrierPartnershipId: undefined`, `status: 'Open'`
([dispatchLegs.ts:946](../convex/dispatchLegs.ts)) and records nothing else.

That is exactly the state `getOpenLoadsWithHcr` selects for. So a dispatcher
who pulls a load off a driver — because the driver called in sick, because
the load moved, because the assignment was wrong — gets it handed straight
back to the same driver on the next sweep, **within `scheduleIntervalMinutes`
(default 60)**. The `ALREADY_ASSIGNED` guard
([autoAssignment.ts:131](../convex/autoAssignment.ts),
[:489](../convex/autoAssignment.ts)) protects a load that is still assigned;
it does nothing for one that was deliberately un-assigned.

Reassigning A → B is safe (the load stays `Assigned` to B, so the sweep skips
it). Un-assigning is not. The two read as the same action to a dispatcher.

Preconditions, stated precisely: the org has `enabled` **and**
`scheduledEnabled` ([autoAssignment.ts:331](../convex/autoAssignment.ts)),
and the load still matches an active route. This is a **sweep** bug —
`triggerOnCreate` fires only at creation and never re-fires on unassign, so
an org running create-trigger only is unaffected. Verified mechanically:
`unassignResource` leaves the legs `PENDING` with `driverId: undefined`
([dispatchLegs.ts:931](../convex/dispatchLegs.ts)) and does not touch
`loadTags`, so the HCR facet survives and `getOpenLoadsWithHcr` re-selects
the load; `assignDriverInternal` then finds `assignableLegs.length > 0` and
patches the same driver back onto the same legs
([dispatchLegs.ts:524](../convex/dispatchLegs.ts)).

Fix: a durable opt-out, not a cooldown — a timestamp just delays the fight.
Add `autoAssignOptOut: v.optional(v.boolean())` to `loadInformation`, set it
in `unassignResource`, check it in the matcher, and expose a "re-enable
auto-assign" control on the load so the choice is reversible and visible.

## R12 — there is no driver-availability model, and A does not add one

The sick-driver case has no clean answer today, and the spec should not
imply otherwise.

`assignDriverInternal` gates on `employmentStatus !== 'Active'`
([dispatchLegs.ts:505](../convex/dispatchLegs.ts)) — values are
`Active | Inactive | On Leave` ([schema.ts:736](../convex/schema.ts)). That
is an HR field: no date range, no half-day, and nobody flips it for a
two-day flu. There is no time-off, PTO, or availability table anywhere in
the schema.

So: **driver out sick → auto-assign keeps assigning to them.** The available
levers are all blunt — set `employmentStatus` to `On Leave` (declines all
loads, indefinitely, until someone remembers to flip it back), or toggle the
route's `isActive` off.

A's per-route `activeDays` does not help: it encodes a *recurring pattern*
("this route runs Mon/Wed/Fri"), not an *exception* ("Dave is out this
week"). Do not let it get sold as coverage for this. The honest scope
statement is that a driver-availability model is a separate feature; A's
`customExclusions` handles known-in-advance date exceptions per route and
nothing else.

R9's alerting is the practical stopgap: if the sick driver is already booked,
`OVERLAP_CONFLICT` catches it; if they are simply absent, nothing does.

## R13 — `employmentStatus` is an unvalidated string

[schema.ts:736](../convex/schema.ts) is `v.string()` with the allowed values
in a trailing comment. Anything other than the exact string `'Active'` —
a typo, a casing drift, a value from an importer — silently blocks every
assignment for that driver, manual and automatic, with the message "Driver
is inactive or not found." Should be a `v.union` of literals.

## R14 — the third matching tier was silently mis-assigning loads

Found in production after feature A shipped, and worth recording because
the extraction preserved it and `getByRoute` was "fixed" by adding it.

Matching had a third tier: after an exact HCR + Trip miss and an HCR-only
miss, take **any active route on this HCR**. The effect was that every
trip-specific rule quietly became an HCR-wide catch-all.

Observed on HCR 96036: rules existed for trips 1, 2, 5, 6, 7, 8 and none
for 821. Twenty loads on trips 821/822 were assigned to the driver whose
rule covered trip 1 — all rules shared `priority: 100`, so the winner came
down to a tiebreak. Nothing in the UI could explain the assignment, because
no rule for those trips existed to display.

The legitimate catch-all is tier 2, which says so explicitly by omitting the
trip. Tier 3 was the accidental version of that and could not be turned off.
Removed; a trip with no rule is now a `NO_MATCH` that stays `Open` and shows
up in the run breakdown.

Two things this exposes about the earlier work:

- The matcher extraction consolidated four copies faithfully, including
  this. Consolidating a behavior is not the same as validating it.
- `getByRoute` originally implemented only tiers 1–2, and that was recorded
  as a defect ("the UI preview disagreed with the engine"). The preview was
  right and the engine was wrong.

Cleanup ran via `_devTools/tier3Cleanup`, which deliberately separates two
causes: a trip with **no rule at all** (the artifact — 27 loads, unassigned)
from a trip whose rule simply does not cover that weekday (11 loads,
assigned before service days existed — left for a dispatcher, since
retroactively undoing those is a judgment call, not a backfill).

## R15 — tests

- Weekday derivation from `firstStopDate` across a DST boundary — assert the
  string-slice approach in A.3 gives the same answer year-round.
- Fall-through: restricted priority-1 route + unrestricted priority-2 route
  → Saturday load lands on priority 2 (R/A.5).
- Priority ordering on the third tier (currently untested and currently wrong).
- Absent `activeDays` on a legacy row → assigns every day.
- `firstStopDate: undefined` + restricted route → `NO_SERVICE_DATE`, load
  stays Open.
- A route restricted to days the org never has pickups on → assigns
  nothing, and R9's reporting surfaces it rather than failing silently.
- **R11 regression test**: assign → `unassignResource` → run the sweep →
  assert the load is still `Open` and unassigned.
- Auto-assign onto an already-booked driver → `OVERLAP_CONFLICT`, load
  stays `Open`, alert raised.
- The same overlap via the manual `assignDriver` path → still succeeds,
  with `overlaps` populated. The split in R9 is the assertion.

---

## Suggested order

0. ✅ **R11** — `autoAssignOptOut` on `loadInformation`, set by the three
   paths that return a load to `Open`, honored by both matchers and by
   `getOpenLoadsWithHcr`, reversible via `loads.setAutoAssignOptOut`.
   Regression test in `convex/autoAssignment.optOut.test.ts`.
1. ✅ **Extract `matchRouteAssignment`** (`convex/lib/routeMatch.ts`);
   deleted `findRouteAssignment`; pointed `getByRoute` at it; `priority` now
   actually decides. Tests in `convex/routeMatch.test.ts`.
2. ✅ **Feature A** — `activeDays` / `excludeFederalHolidays` /
   `customExclusions` on `routeAssignments`, evaluated against
   `firstStopDate`; `DAY_RESTRICTED` and `NO_SERVICE_DATE` actions;
   `ServiceDaysField` in both modals and the Schedule column.
   Tests in `convex/routeAssignments.serviceDays.test.ts` and the calendar
   half of `convex/routeMatch.test.ts`.
   *Not done in that step:* deleting the dead `fourKitesSyncHelpers
   .createLoad` (R5) — still a landmine, still has no callers.
3. R9 — overlap-declines-on-auto + the reporting channel. Not optional
   alongside A: day restrictions create new silent-skip paths, and R1 means
   a silent skip costs the load. It is also the feature B was reaching for.

**R11 should jump the queue.** It is a live bug with a one-field fix, it is
unrelated to A, and it makes the system actively fight its operators today.
