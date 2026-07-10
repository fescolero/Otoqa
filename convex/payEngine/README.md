# Pay Engine

Cents-native pay/settlement ledger that runs **in parallel with the legacy pay
system** (`driverSettlements` / `carrierSettlements` + `loadPayables` +
`rateRules`) via a shadow-validated strangler migration. Nothing here is
user-facing until an org flips the `settlements_read_ledger` feature flag; the
default is `legacy`, so live behavior is unchanged.

## Money model

All amounts are `int64` in the smallest currency unit. **Amounts** are cents
(`*Cents`); **rates** are micro-cents (1/1000 of a cent, `*MicroCents`) to handle
sub-cent trucking rates like `$0.555/mi`. Conversions and rounding live in
[`../lib/money.ts`](../lib/money.ts) — never use floats or bare `bigint`
literals (`0n` fails under the root ES2017 tsconfig; use `BigInt(0)`).

`payItems.amountCents` is always an **unsigned magnitude**; direction comes from
the item's `chargeComponents.bucket` + `sign`, never the numeric sign.

## Modules

| Area | Files |
|---|---|
| Calc | `calculatePay.ts` (pure), `calculatePayForLeg.ts`, `calculatePayForSession.ts`, `applyPostCalcRules.ts`, `assembleInput.ts` |
| Aggregation | `aggregateSettlement.ts` — pure `rollupSettlementTotals` + Convex wrappers (idempotent full-recompute; convergent `settlementId` stamping) |
| Read adapter | `settlementReads.ts` — flag-gated queries emitting the dashboard's `SettlementRow` / detail shapes from the new ledger |
| Write layer | `settlementWrites.ts` (lifecycle: status / ack / adjust / remove / reverse), `editSessionPay.ts` (append-only reviewer line edits) |
| Coverage | `manualCoverage.ts` (backfill + forward dual-write of legacy manual lines), `backfill.ts` (leg/session pay + stale-item sweeps) |
| Cutover | `generationCron.ts`, `lifecycleMigration.ts`, `settlementReadParity.ts`, `shadowValidateSettlement.ts` |
| Catalog/config | `chargeComponentsCatalog.ts`, `seedChargeComponents.ts` (+ sibling `../payProfiles.ts`, `../payRules.ts`, `../payeeProfileAssignments.ts`, `../payItems.ts`) |

Trigger sources (`resolveTriggerSource` in `calculatePay.ts`): `constant.1`,
`leg.legLoadedMiles` / `legEmptyMiles` / `totalMiles` / `durationMinutes`,
`session.activeMinutes`, `stops.count` / `dwellMinutesSum`,
`load.invoiceTotalCents` / `linehaulTotalCents`, `attr.hazmat` / `tarp` /
`oversize`. Driver pay is per-**session** (shift); carrier pay is per-**leg**
(mileage) — partitioned by trigger source so the two never double-pay.

## Read adapter: totals + frozen membership

The read adapter (`settlementReads.ts`) is fast **and** consistent with the
materialized aggregates:

- **Settled-bucket stat sums** read `settlements.totals.netCents` directly
  (`netUsdOf`) instead of re-collecting every statement's `payItems` on each
  reactive tick — this is what keeps `getViewStats` O(active) rather than
  O(all settled statements ever).
- **Finalized statements** (`VERIFIED` / `SENT` / `PAID` / `CLOSED` / `VOID`)
  read their lines from the items the aggregator **stamped**
  (`by_settlement`), not the live period window. So list, stats, and detail all
  agree with `totals`, and a line that lands in a period **after** its statement
  was approved can't leak into that approved statement's displayed net. Open /
  in-review statements still read the live period window so accruals show before
  the next aggregation stamps them.
- Payee-scoped reads use the `settlements.by_org_payee_status` index, so a driver
  query never pages the org's carrier statements (and vice versa).

**Net invariant:** `settlements.totals.netCents` equals the adapter's
`summarizeLines(lines).net` for every bucket present today. They diverge **only**
once `TAX_WITHHOLDING` / `GARNISHMENT` / `REVERSAL` items exist (M6/M7) — the
aggregator subtracts those at net, `summarizeLines` does not — and `totals` is
the correct value then. Locked in `settlementReads.test.ts`
(aggregator ⇄ reads parity + leak-exclusion).

## Post-approval adjustments roll forward

When a manual line's natural period already has a **finalized** statement, the
forward dual-write (`manualCoverage.ts` `syncManualPayItem` →
`resolveForwardAnchor`) re-anchors the mirrored payItem onto the payee's **next
open period** (falling back to *now* if none exists), so post-approval
adjustments land on the next pay run instead of orphaning in an approved
statement.

## Cutover (per org)

1. Run the backfills + `lifecycleMigration.migrateLegacyLifecycle` +
   `aggregateAll{Driver,Carrier}Settlements` for the org (dry-run first).
2. Flip the flag:
   ```
   npx convex run featureFlags:setFlagInternal \
     '{"workosOrgId":"<org>","key":"settlements_read_ledger","value":"new"}'
   ```
   Absent / any other value = `legacy`.
3. Verify the dashboard in both modes; the new ledger may legitimately show
   **higher** totals than legacy (e.g. Health & Welfare fringe + shifts legacy
   missed) — that is intended completeness, not a bug.
4. Once an org runs stable, remove the legacy path + the
   `use-settlements-ledger` frontend shim.

## Testing

`npx vitest run convex/payEngine` — pure functions and Convex mutations/queries
via `convex-test`. Typecheck with **both** `npx tsc --noEmit -p convex` and the
root `npx tsc --noEmit` (the root targets ES2017 and catches bare `bigint`
literals that the Convex tsconfig tolerates).
