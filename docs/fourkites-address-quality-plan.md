# FourKites Address Quality & Geofence Reliability — Implementation Plan

**Status:** Phases 1–3 implemented on this branch (2026-07-24). Phase 0
(`dumpRawShipment` on 116569618) still needs a dashboard run; its findings
may add FK fields to the Phase 1 address mapping. Implementation note:
hard mode semantics landed as designed — the `hard` flag value only
hard-blocks stops anchored to VERIFIED, non-needs-review facilities;
everything else stays soft even in hard mode.
**Revised:** 2026-07-24 codebase review — added: soft-mode outer bound (pay-engine
protection), flag-read helper, recurring/manual-load matching (2.7), pin-correction
backfill (2.8), NASS-code + schedule-import facility seeding (2.5), `externalCode` on
facilities. Simplified: no `locationName` field and no mobile projection changes — FK
name/street text goes into the existing `address` field; all other new stop fields are
dispatch-only.
**Branch:** `claude/fourkites-address-quality-joymkn`
**Reference incident:** Load 116569618 (Redding → Yreka, 2026-07-23) — driver physically at
the stop was blocked from checking in/out by the 500 m geofence.

---

## 1. Problem statement

FourKites-imported loads show empty stop addresses (web and mobile render city only), and
stop coordinates come verbatim from the FourKites feed. When FourKites lacks street-level
data it sends geocoded city/zip-centroid coordinates, which can sit hundreds of meters from
the real facility. The driver check-in geofence anchors to those coordinates with a hard
500 m limit and no tolerance, so a bad pin blocks a driver who is standing at the dock.

### Root causes (verified in code)

| # | Cause | Location |
|---|-------|----------|
| 1 | Import hard-codes `address: ""`; `stopName` and any other FK address fields are dropped | `convex/fourKitesUtils.ts:151` (`buildStopRecord`), `convex/fourKitesApiClient.ts:41` |
| 2 | Check-in geofence: hard 500 m, no GPS-accuracy margin, no per-stop radius | `convex/driverMobile.ts:21,864-874` |
| 3 | Check-in limit (500 m) disagrees with the arrival ring the evaluator uses (804 m) | `convex/lib/geo.ts:32` |
| 4 | Re-sync patches `city`/`latitude`/`longitude`/`timeZone` unconditionally; `undefined` values **delete** fields in Convex, so a sparse FK payload wipes previously good coordinates | `convex/fourKitesPullSyncAction.ts:267-279` |
| 5 | No dispatcher path to correct a stop's address/coordinates (`updateStopTimes` covers times only) | `convex/loads.ts:1952` |
| 6 | The server-side bypass `skipDistanceCheck` exists but mobile never sends it; drivers' only workaround is mislabeling the stop as redirected | `convex/driverMobile.ts:785,862` |
| 7 | Offline-queued check-ins replay without checking the mutation result; a geofence rejection (`success: false`) is silently marked completed | `mobile/app/_layout.tsx:147-153`, `mobile/lib/offline-queue.ts` |
| 8 | Mobile navigation builds its maps query from `[address, city, state]`; with empty addresses drivers navigate to the city, and the shortcut button is dead when `address` is empty | `mobile/app/(app)/trip/[id].tsx:277,813` |

### Assets already in place

- `dumpRawShipment` diagnostic dumps the full untouched FK payload for one shipment
  (`convex/fourKitesDiag.ts`) — run from the Convex dashboard.
- Successful check-ins/outs already store ground-truth coordinates on the stop:
  `checkinLatitude/Longitude` (`convex/driverMobile.ts:916`), `checkoutLatitude/Longitude`
  (`convex/driverMobile.ts:1042`).
- `contractLanes.stops` is an ordered array with user-typed `address/city/state/zip/stopOrder`
  (`convex/schema.ts:935-946`) — lane stop plans already exist.
- Server-side Google geocoding infra + `GOOGLE_MAPS_API_KEY` exist (`convex/laneAnalyzerActions.ts`);
  client-side Places autocomplete exists (`lib/googlePlaces.ts`, used on driver/customer forms).
- Per-org feature flags with mobile accessors (`convex/featureFlags.ts`,
  `mobile/lib/feature-flags.ts`) for staged rollout.
- Customer detail page already has a Locations tab stub
  (`app/(app)/operations/customers/[id]/customer-detail-content.tsx:664`).
- Schedule import (`convex/scheduleImport.ts`) already extracts per-stop **NASS codes**
  (stable USPS facility identifiers) from HCR schedule PDFs and already **geocodes every
  lane stop** via Google during verification (`verifyAndEnrichStops`) — both are currently
  discarded after use (NASS codes aren't persisted; coordinates only feed
  `_calculatedMiles`). Direct seeds for the facility registry.

### Related gaps in non-FourKites paths (found in review)

- **Recurring loads** create stops with **no coordinates at all**
  (`convex/recurringLoads.ts:455-479`): no geofence, no arrival events, degraded live
  tracking. This is also why only some drivers hit the geofence problem.
- **Manual load creation** (`convex/loads.ts:1530`) accepts `latitude/longitude` per stop
  but the web create form never sends them, so manual stops are coordinate-less too.
- **Detour stops** are fine (driver GPS coordinates, synthesized address label —
  `convex/driverMobile.ts:2017-2031`).

---

## 2. Settled design decisions

1. **Facilities are manual-only.** Users add/edit/remove facilities on the customer detail
   page → Locations tab. Imports never create facility rows.
2. **Facilities are customer-scoped** (`workosOrgId` + `customerId`). No reliance on
   FourKites location IDs (not stable/shared across tenants). Each org builds its own registry.
3. **Primary match: contract lanes.** Lane stop entries gain an optional `facilityId`; a
   lane-matched load snaps stops to facilities by position, guarded by count + city agreement.
4. **Fallback match: coordinate proximity** to facility pins (threshold ~15 km, winner must
   beat runner-up by ~3× margin), with `(city, state)` as a veto only — never as the primary key.
5. **UNMAPPED loads do no facility work** until promoted to a real customer;
   `promoteUnmappedLoad` re-runs matching.
6. **Soft geofence by default, hard only for verified facilities.** Soft = allow check-in,
   record distance, flag exceptions. Hard = block past the facility radius, with a
   driver-visible override that records the event. Repeated overrides auto-demote the
   facility to soft + review queue. Checkout is never distance-blocked.
7. **Verification is a human action, data-assisted.** Check-in history clustering produces a
   *suggested* pin + evidence; a user confirms. (Consistent with manual-only.)
8. **No forward-geocoding dependency.** Navigation switches to coordinates; history mining
   replaces geocoding for pin accuracy. Reverse geocoding for display text is optional/later.

---

## 3. Phase 0 — Diagnostics (no code, do first)

> **FINDINGS (2026-07-24, dev run against shipment 687686124 / order 116569618):**
> - **No street-address field exists** in this tenant's feed — the empty
>   address column was a feed limitation, not dirty data. Lane inheritance
>   + facilities are the correct fix.
> - `stopName` is a facility label for plants ("LOG REDDING CA LPC") but
>   just the city in caps for delivery stops ("LAKEHEAD") — the import now
>   suppresses city-duplicate names so lane addresses win.
> - `externalAddressID`/`stopReferenceId` are **stable USPS facility codes**
>   (ZIP for post offices, 3-digit plant code like "960" for LPCs). The
>   import now uses them as a facility-match key against
>   facilities.externalCode when no lane binding exists.
> - Pins are per-facility geocodes (distinct 6-decimal coords per stop),
>   not city centroids — plausible-looking but unverified; per-stop
>   `checkinDistanceMeters` will quantify their real error in production.
> - Per-stop `arrivalTime`/`departureTime` (FK-detected) exist and are not
>   yet consumed — possible future enrichment.
> - referenceNumbers `["1","96036","CarrierCode:000227710"]` classify as
>   HCR 96036 / Trip 1, as designed.

- Run `internal.fourKitesDiag.dumpRawShipment` from the Convex dashboard for
  `externalLoadId` 116569618 (and one non-HCR shipment if available).
- Record: does FK send street address lines? `stopName`? a location name/code? country?
  This decides exactly which fields Phase 1.1 maps. It no longer affects keying.
- Compare the stored `loadStops.latitude/longitude` for 116569618's stops against the real
  facility positions to confirm the centroid-pin hypothesis and measure the offset.

**Exit criteria:** a short findings note appended to this doc (fields available, offsets seen).

---

## 4. Phase 1 — Tactical fixes (independent; each is a small PR-able unit)

### 1.1 Import field mapping
- `buildStopRecord` (`convex/fourKitesUtils.ts`): stop hard-coding `address: ""`. Persist
  whatever Phase 0 confirms exists into the **existing `address` field** (e.g.
  "Yreka Post Office, 401 S Broadway" when FK sends both `stopName` and a street; just
  the name or just the street otherwise). No new field: `address` is already in the
  schema, already projected to mobile, and already rendered on web and mobile — so this
  requires zero display or projection changes anywhere.
- **Lane address inheritance:** in `importLoadFromShipment`, when the load matched a lane,
  copy `contractLane.stops[i].address` (matched by position with count + city agreement)
  into the load stop's `address`. This fills the web/mobile address display for every
  contract load with data dispatch already typed — no external calls.
- **Mobile projection: deliberately unchanged.** `getLoadWithStops`
  (`convex/driverMobile.ts:628-762`) is an explicit field allowlist; none of the new
  stop fields introduced by this plan (`facilityId`, `checkinDistanceMeters`,
  `checkinOutsideGeofence`, `checkinOverride`) are added to it — they are all
  server/dispatch-facing. Decision 2026-07-24: mobile shows nothing new; the improved
  `address` string flows through the projection that already exists.

### 1.2 Re-sync guard
- `convex/fourKitesPullSyncAction.ts` STEP 6: build the patch object field-by-field,
  including a key **only when the incoming value is defined** (Convex deletes on `undefined`).
- Never regress: keep existing value when FK omits one. (Full "manual edits win" protection
  arrives with source flags in Phase 2.4.)

### 1.3 Check-in soft-block + tolerance
- `checkInAtStop` (`convex/driverMobile.ts`):
  - Raise the base limit to align with the arrival ring: `INNER_RING_METERS` (804 m) +
    GPS-accuracy margin. Accept an optional `accuracy` arg from mobile and add it to the
    allowance (capped, e.g. +100 m).
  - Behavior by org feature flag `checkin_geofence_mode`: `off` | `soft` (default) | `hard`.
    - `soft`: allow past the inner limit, but persist `checkinDistanceMeters` and
      `checkinOutsideGeofence: true` on the stop and return a warning message so mobile
      can toast it. **Soft mode is NOT unbounded:** beyond `OUTER_RING_METERS` (~8 km)
      check-in is still refused. Rationale: `checkedInAt/checkedOutAt` feed the pay
      engine (TIME_WAITING dwell sums and TIME_DURATION leg duration —
      `convex/payEngine/calculatePay.ts:180-187,473`), so an accidental check-in from
      far away would start dwell/detention clocks and distort pay. 8 km is generous
      enough to never block a driver at a real stop with a bad pin, tight enough to
      stop "checked in from the yard 40 miles away".
    - `hard`: current blocking behavior (kept for Phase 3's verified-facility mode).
  - Flag read: `featureFlags.ts` only exposes a public `getForOrg` query — add a small
    internal helper that reads the org's flag row directly from `ctx.db` so the check-in
    mutation can consult it without a query round-trip.
  - Schema: add `checkinDistanceMeters` / `checkinOutsideGeofence` optionals to `loadStops`.
- Mobile: show the warning non-blockingly on check-in success (the warning arrives in
  the mutation's return message — no projection changes needed).

### 1.4 Coordinate-based navigation (mobile)
- `openMaps` (`mobile/app/(app)/trip/[id].tsx:277`): prefer `latitude,longitude` when the
  stop has coordinates; fall back to address text. Enable the nav shortcut (line 813) when
  either coordinates or address exist.

### 1.5 Offline replay honesty
- `setMutationProcessor` (`mobile/app/_layout.tsx:147`): inspect the returned
  `{success, message}` for `checkIn`/`checkOut`. On `success: false`, mark the queued
  mutation `failed` with the reason, fire an analytics event, and surface a local
  notification/toast ("Check-in at <stop> didn't sync: <reason>") instead of silently
  completing. Do not endlessly retry business-rule rejections (only network errors retry).

### 1.6 Tests
- Unit: `buildStopRecord` mapping (with/without address fields), re-sync patch builder
  (undefined omission), check-in soft/hard modes via `convex-test`, queue processor
  result handling.

**Exit criteria:** contract loads show addresses; no driver is hard-blocked (soft mode);
re-syncs can't wipe coordinates; navigation works from coordinates; failed offline
check-ins are visible.

---

## 5. Phase 2 — Facilities registry

### 2.1 Schema (`convex/schema.ts`)
```
facilities: defineTable({
  workosOrgId: v.string(),
  customerId: v.id('customers'),
  name: v.string(),
  addressLine1: v.optional(v.string()),
  city: v.string(),
  state: v.string(),
  postalCode: v.optional(v.string()),
  latitude: v.number(),
  longitude: v.number(),
  radiusMeters: v.optional(v.number()),      // default INNER_RING_METERS when unset
  verificationState: v.union(v.literal('UNVERIFIED'), v.literal('VERIFIED')),
  verifiedBy: v.optional(v.string()),
  verifiedAt: v.optional(v.number()),
  externalCode: v.optional(v.string()),      // e.g. USPS NASS code from schedule import
  needsReview: v.optional(v.boolean()),      // set by auto-demotion (Phase 3)
  overrideCount: v.optional(v.number()),     // rolling override tally (Phase 3)
  notes: v.optional(v.string()),
  isDeleted: v.boolean(),
  createdBy: v.string(), createdAt: v.number(), updatedAt: v.number(),
})
  .index('by_customer', ['customerId', 'isDeleted'])
  .index('by_org', ['workosOrgId', 'isDeleted'])
```
- `loadStops` gains `facilityId: v.optional(v.id('facilities'))` plus a `by_facility`
  index (needed by 2.8 backfill and Phase 3 evidence aggregation).
- `contractLanes.stops[]` entries gain `facilityId: v.optional(v.id('facilities'))`.

### 2.2 Convex functions (`convex/facilities.ts`)
- `listByCustomer` (query), `create` / `update` / `remove` (mutations) using the existing
  `requireCallerIdentity` org-auth pattern and `logAudit` for every write.
- `remove` is a soft delete; linked historical stops keep their `facilityId` (records stay
  intact), future imports simply stop matching it.

### 2.3 Customer Locations tab UI
- Replace the address-only stub (`customer-detail-content.tsx:664-669`) with a
  `DSMiniTable` of facilities (name, city/state, pin status, radius, verified chip) +
  add/edit modal. Address entry uses the existing `AddressAutocomplete`
  (`components/ui/address-autocomplete`) so coordinates come from Places selection;
  lat/lng also editable directly. Verify/unverify action lives here.

### 2.4 Sync protection
- In the re-sync stop update: if `stop.facilityId` is set, do not overwrite
  `city/latitude/longitude` from FourKites at all (facility pin is authoritative).

### 2.5 Lane binding UI
- `components/contract-lanes/stop-input.tsx`: add a facility picker (filtered to the
  lane's customer) writing `facilityId` onto the lane stop entry. Optional per stop.
- `contractLanes.stops[]` entries also gain `nassCode: v.optional(v.string())` — the
  schedule import already extracts NASS codes per stop (`convex/scheduleImport.ts:113`)
  and currently discards them. Persisting them enables exact facility matching by code
  (`facilities.externalCode`) instead of position/proximity for schedule-imported lanes.
- **Schedule-import assist:** `verifyAndEnrichStops` already geocodes every lane stop
  with Google and throws the coordinates away (`scheduleImport.ts:648-651`). Keep them
  through the import flow and offer "create missing facilities from this schedule"
  during review — pre-filled with NASS code, address, and geocoded pin, each row
  user-confirmed before insert. This respects manual-only (a human approves every row)
  while eliminating the data-entry chore for a whole contract's facilities at once.

### 2.6 Import matching (`convex/fourKitesUtils.ts` + `fourKitesSyncHelpers.ts`)
- New pure helper `matchStopToFacility(stop, laneStops, facilities)` with unit tests:
  1. **Lane path:** if the lane's stop list length matches the shipment's and cities agree
     per position, use `laneStops[i].facilityId`. Any disagreement → per-stop fallback for
     the stops that don't line up (never force-assign by position).
  2. **Proximity fallback:** among the load's customer facilities, nearest pin to the FK
     coordinates wins if ≤ 15 km AND ≥ 3× closer than the runner-up; `(city, state)`
     mismatch at > 8 km vetoes. No unique winner → no match.
- On match: set `loadStops.facilityId`; when the facility is VERIFIED, write the facility's
  pin into `latitude/longitude` (snap); when UNVERIFIED, keep FK coordinates but still link.
- `importUnmappedLoad`: no facility logic. `promoteUnmappedLoad`: re-run matching across
  the load's stops after the customer is known.

### 2.7 Matching beyond FourKites
The matcher is a pure helper — wire it into every stop-creation path, not just the FK sync:
- **Recurring loads** (`convex/recurringLoads.ts:455`): template stops have address/city
  but no coordinates today. Match against the template customer's facilities at
  generation time; a match supplies `facilityId` + pin coordinates, turning geofencing
  and arrival events ON for recurring loads for the first time.
- **Manual load creation** (`convex/loads.ts:1529`): run the matcher per stop on insert;
  additionally, the web create form should send coordinates from `AddressAutocomplete`
  (the backend already accepts `stop.latitude/longitude`; the form currently never
  supplies them).

### 2.8 Pin-correction propagation
Import-time snapping alone leaves stale coordinates on already-imported future stops when
a user later verifies or moves a facility pin. On facility pin change / verification:
backfill `latitude/longitude` to linked stops (`facilityId` index) on loads that are not
completed and stops that are still `Pending`. Never touch completed stops (they're
historical records feeding pay).

**Exit criteria:** dispatch can maintain facilities per customer; contract-lane loads link
stops to facilities on import; verified pins override FK coordinates; re-sync can't clobber
facility-anchored stops.

---

## 6. Phase 3 — Verification lifecycle & hard mode

### 3.1 Evidence-assisted verification
- Aggregation (internal query or nightly cron): for each facility, collect
  `checkinLatitude/Longitude` + `checkoutLatitude/Longitude` from linked, non-override,
  non-redirected stops; compute count, distinct days, median point, spread.
- Locations tab shows the suggestion when evidence is strong (≥ 5 check-ins, ≥ 3 days,
  spread ≤ 150 m): "Suggested pin from N check-ins — apply & verify". Applying sets the
  pin to the median, radius to observed spread + margin, state to VERIFIED. Humans decide;
  data assists.

### 3.2 Hard mode for verified facilities
- `checkInAtStop`: when `checkin_geofence_mode` allows and the stop's facility is VERIFIED,
  enforce `radiusMeters` (default 804 m) + accuracy margin. Rejection response includes the
  distance so mobile can render it.
- Mobile: on rejection, offer **"Check in anyway"** → resend with `skipDistanceCheck: true`
  + a required reason; server records an override marker on the stop
  (`checkinOverride: true`, reason, distance) and increments the facility's override tally.
- Overridden / redirected check-ins are excluded from 3.1's evidence pool (prevents a wrong
  pin from re-verifying itself).

### 3.3 Auto-demotion
- On override: if a facility accrues ≥ 3 overrides in a rolling 30 days, set
  `needsReview: true` and treat it as soft until a user re-verifies. Surfaced on the
  Locations tab (and optionally as a load risk signal).

### 3.4 Exception visibility (web)
- Load detail: show a warning chip on stops with `checkinOutsideGeofence` /
  `checkinOverride`, with the recorded distance — dispatch sees pin problems as they
  happen instead of via blocked drivers.

**Exit criteria:** verified facilities enforce accurate fences with an honest escape hatch;
wrong pins self-surface and self-demote; evidence loop closes.

---

## 7. Rollout

1. Phase 1 ships behind `checkin_geofence_mode` = `soft` for all orgs (flag default).
2. Phase 2 is additive schema + UI; no migration needed (registry starts empty, stops
   without `facilityId` behave exactly as today).
3. Phase 3 hard mode enables per-org once that org has verified facilities; start with the
   pilot org (Fames Transport).
4. No destructive migrations anywhere; every schema change is optional fields or new tables.

## 8. Test plan

- **Unit (vitest / convex-test):** stop-record mapping; re-sync patch builder omits
  undefined; matcher (lane-position guard, proximity margin, city veto, no-winner);
  check-in off/soft/hard × verified/unverified/unlinked; override recording + demotion
  counter; offline processor marks business-rule failures failed.
- **Fixture:** raw FK payload from Phase 0 checked into test fixtures for the mapping tests.
- **Manual:** end-to-end on staging org — import a lane-matched load, verify address
  inheritance; check in inside/outside the ring in soft and hard modes; facility CRUD +
  verify flow; offline check-in rejection surfaces.

## 9. Rough sizing

| Phase | Scope | Estimate |
|-------|-------|----------|
| 0 | Dashboard run + notes | < 1 hr |
| 1 | 5 small fixes + tests | 1–2 days |
| 2 | Schema, CRUD, 2 UI surfaces, matcher across all creation paths, schedule-import seeding, pin backfill | 3–5 days |
| 3 | Clustering, hard mode, override UX, demotion | 2–3 days |

## 10. Open parameters (defaults chosen, tune during rollout)

- Soft/hard base limit: 804 m (+ accuracy margin, capped +100 m).
- Proximity match: 15 km threshold, 3× margin, city veto beyond 8 km.
- Verification evidence: ≥ 5 check-ins, ≥ 3 distinct days, ≤ 150 m spread.
- Demotion: ≥ 3 overrides / 30 days.
