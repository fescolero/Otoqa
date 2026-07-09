# Accounting Reports — Redesign Implementation Plan

Status: **approved to build**. Source design: `Otoqa Mobile(4).zip` →
`web/screens/accounting-reports-screen.jsx`. This plan reflects a codebase
verification pass (see "Verification notes" at the bottom for what changed from
the first draft).

---

## 1. Goal

Replace the current **table-first** Reports page (5 tabs: Receivables,
Discrepancies, Revenue, Profitability, Costs) with the new **analytics-first**
surface: a `SavedViews` bar + range selector + structured `FilterBar`, leading
with KPI cards and roll-up cards whose rows open a **drill slide-over**.

Ship **5 views**: **Overview, A/R aging, P&L, Profitability, Discrepancies**.
Defer **Payables, Tax/1099, QuickBooks sync** (little/no backend; settlement
engine mid-migration).

### Non-negotiables
- **No performance regression.** Summary/roll-up views read *aggregate* queries;
  heavy row data lives in drills loaded on demand. Discrepancies stays
  **server-paginated/sorted**. Do **not** reintroduce the old
  fetch-all-then-client-paginate pattern for the main views.
- **No free-text search box** (decided) — structured `FilterBar` chips + ⌘K only.
- Row-selection checkboxes are dropped (verified vestigial — no bulk actions).

---

## 2. Architecture

Rebuild `app/(app)/accounting/reports/_components/reports-dashboard.tsx` as an
analytics shell composed from existing `components/web/` primitives:

| Concern | Component (already exists) | Notes |
|---|---|---|
| View bar | `web/saved-views.tsx` `SavedViews` | `{views:[{id,label,count,tone}], activeId, onChange, actions}` — 1:1. count/tone pills back the exception badges. |
| Entity filters | `web/filter-bar.tsx` `FilterBar` | `{properties, value:[{propId,operator,values}], onChange, slot:'all'}` — 1:1. Needs facet option lists. |
| Cards | `web/ds-card.tsx` `DSCard` | = the mockup's `RCard`. |
| KPI cards | `web/quick-stats.tsx` (+ thin wrapper) | mockup's `AcKpi` (value/delta/tone/spark/clickable). |
| Buttons / icons / avatars | `web/btn.tsx` `WBtn`, `web/icons.tsx` `WIcon`, `web/avatar.tsx` `Avatar` | 1:1. |
| Drill slide-over | **NEW thin component on `components/ui/sheet.tsx`** | `details-slide-over.tsx` is a heavy record-detail (tabs/sections) — NOT a drop-in. Build a light `{title, subtitle, metrics[], body, footAction}` panel matching `AcDrillPanel`. |
| Range selector | port mockup's `AcRangeSelect` (presets + custom) | uses `components/ui/popover` + `calendar`. |

**Delete after migration:** `_components/tabs/*`,
`shared/report-data-table.tsx`, `shared/report-table-layout.tsx`,
`shared/report-intelligence-sidebar.tsx` (and `summary-stat.tsx` if unused).

**Data access:** keep the existing `useAuthQuery` +
`assertCallerOwnsOrg(ctx, workosOrgId)` pattern for every new query.

---

## 3. View-by-view data mapping

### Overview
- KPIs: `getRevenueSummary`, `getReceivablesSummary` (aging total), `getProfitabilitySummary`.
- Trend combo chart: `getRevenueOverTime`.
- Revenue-by-customer bars: `getRevenueByCustomer`.
- A/R snapshot: `getReceivablesSummary.agingBuckets`.
- P&L summary card: `getRevenueSummary` + `getCostSummary` → gross profit.
- **Attention band — TRIMMED:** only **Overdue** (receivables) + **Disputed**
  (discrepancy count) in v1. Unbilled-delivered / blocked-settlements /
  missing-POD have no count queries and blocked ties to the mid-migration
  settlement engine → deferred with Payables.

### A/R aging
- Buckets + DSO: `getReceivablesSummary` (**note: no `DSO` field — relabel
  `avgDaysToPay` or compute DSO = outstanding / revenue × days**).
- Per-customer table: **NEW `getAgingByCustomer`** (per-customer bucket roll-up)
  — avoids client-side fetch-all.
- Drill (customer-ar / bucket-ar) → `getReceivablesDetail` filtered.
- ⚠️ Buckets cap at `MAX_INVOICES_PER_STATUS` (1500)/status — undercounts for
  very large A/R (existing behavior; note in UI if needed).

### P&L
- Revenue: `getRevenueSummary`. Direct costs (driver/carrier/fuel/DEF):
  `getCostSummary`. Bottom line = **Gross profit**.
- **Opex → Net Operating Income deferred** — no expense ledger in schema
  (insurance/maintenance fields are fleet coverage attributes, not paid
  expenses). Ship the statement ending at Gross profit.
- Optional **Export PDF**: PDF infra exists (`lib/bulk-pdf.ts` + react-pdf), but
  a report/P&L template is **net-new** — separate line item (see decision).

### Profitability
- ⚠️ **New backend required.** No cost-by-customer or cost-by-lane query exists
  today (`getRevenueByCustomer` = revenue only; `getProfitabilityByLoad` =
  per-load, capped 500). Build **`getProfitabilityByCustomer`** and
  **`getProfitabilityByLane`** (join loads → customer/lane, sum driver+carrier+
  fuel per load, group, compute margin vs fleet).
- Drill → `getProfitabilityByLoad` filtered.

### Discrepancies
- Summary + HCR roll-up: `getDiscrepancyIntelligence` — **add `underpaidSum`**
  (sum of underpaid dollars, for the "$X to recover" KPI).
- Detail: `getDiscrepancyDetailSorted` (server paged/sorted — reuse as-is).
- **Sign flip at the query boundary:** design uses `difference = invoiced − paid`
  (+ = underpaid/owed to us); backend uses `paid − invoiced`. Visual
  (underpaid = red) already consistent.
- Drill = mileage reconciliation (data already on the row). Footer actions
  ("Dispute short-pay" / "View invoice") need real targets — confirm dispute
  flow exists or wire to invoice record.

---

## 4. New / changed backend (all additive, indexed, capped)

1. `getDiscrepancyIntelligence` → add `underpaidSum`.
2. `getAgingByCustomer` — per-customer aging buckets.
3. `getProfitabilityByCustomer` — revenue/cost/profit/margin per customer.
4. `getProfitabilityByLane` — same, per lane.
5. Overview exception counts: reuse overdue (receivables) + disputed
   (discrepancy count). No new query needed for v1.
6. FilterBar facet option lists (customer/driver/carrier/lane) — light
   distinct-value queries or reuse existing entity-list queries.
7. DSO on `getReceivablesSummary` (or relabel in UI).

---

## 5. Phasing

- **Phase 0 — Shell.** New dashboard: `SavedViews` + range selector + `FilterBar`
  (with facet option queries) + thin `sheet`-based drill scaffold + KPI/`DSCard`
  wrappers. Views render as empty containers. *Low risk.*
- **Phase 1 — A/R aging + Overview.** `getAgingByCustomer`, DSO; Overview
  attention band = overdue + disputed only. *Low–medium.*
- **Phase 2 — Discrepancies.** `underpaidSum` + sign flip; reuse server paging;
  reconciliation drill. *Low.*
- **Phase 3 — Profitability.** `getProfitabilityByCustomer` +
  `getProfitabilityByLane` (the real new aggregation work). *Medium.*
- **Phase 4 — P&L.** Revenue → Direct costs → Gross profit. Optional Export PDF
  template. *Medium.*
- **Deferred backlog:** Payables (settlement engine), Tax/1099, QuickBooks,
  full attention band, Opex/NOI.
  - **Data integrity:** reconcile `accountingPeriodStats` counters vs ground
    truth — sum invoice `paidAmount` vs `totalAmount` over an in-range cohort and
    compare to `totalCollected` / `totalInvoiced`. Collected exceeded billed
    (~114% YTD); confirm whether that's legit overpayments (discrepancies) or
    counter drift from the reversal/`Math.max(0,…)` paths. Independent of the UI.

## Progress — all 5 views shipped & verified in browser
- Phase 4 (P&L) — **done**, verified. Revenue → direct costs (driver/carrier/
  fuel/DEF) → **gross profit** bottom line (Opex/NOI deferred, no ledger). Data
  from `getProfitabilitySummary` (no new backend). Reconciles the Phase 3 margins:
  driver+carrier pay is tiny here; fuel ($940K) dominates direct cost and is
  fleet-level (excluded from Profitability's per-load contribution).
- **Export CSV — done.** Wired per-view via `useRegisterExport` + the shared
  `exportToCSV` helper: each table card has a working Export CSV, and the header
  Export CSV exports the active view's dataset (A/R aging, Discrepancies,
  Profitability by customer/lane, P&L income statement, Overview revenue-by-
  customer). Verified: captured blob matches the P&L view exactly. **Export PDF
  removed** (deferred — needs a report PDF template).
- Deferred backlog unchanged (Payables, Tax/1099, QuickBooks, Opex/NOI, Export
  PDF, the 3 data-integrity items).

### Filter review (customer / status)
Reviewed all views under the Customer + Invoice-status facets. Findings & fixes:
- **Customer filter** worked on Discrepancies + Profitability; was **silently
  ignored** on A/R aging (now **fixed** — `getAgingByCustomer` + the summary/
  bucket-drill queries take `customerId`).
- **Invoice status facet** consumed by no view → **removed** (re-add when wired).
- **Overview + P&L customer scoping — DONE (Option 1, contribution semantics).**
  Decided to make the Customer filter scope **all five views** consistently
  (a global filter must behave globally in an accounting surface). Implemented
  **invoice-driven, dual-path**: unfiltered Overview/P&L keep their fast org
  period-stats path unchanged; when a customer is scoped they switch to
  per-customer sources — `getReceivablesSummary(customerId)` (A/R, collected,
  overdue, aging) + `getProfitabilityBreakdown(customerId)` (revenue +
  contribution) + new `getCustomerRevenueTrend` (trend). P&L becomes a
  **Contribution statement** (revenue − attributable driver+carrier pay;
  fuel/DEF/overhead stay fleet-level and are labeled as such) — never implies
  unallocatable overhead is attributed to one customer.
  - Shared `useCustomerFilter` + `useCustomerContribution` hooks (`use-customer-
    scope.ts`) so every view reads the facet identically.
  - **Verified in browser:** unfiltered Overview/P&L unchanged (Collected
    $1,318,199, Gross profit $156,033, full Income statement — no regression);
    USPS-Moreno scoped → Revenue $32,558 / Contribution $32,103 / 98.6% margin,
    reconciling **exactly** across Overview, P&L, and Profitability. Acme → A/R
    aging empty. Revenue-by-customer card auto-hidden when scoped. No console
    errors.

### Detailed phase log
- Phase 0 (shell) — **done**, verified in browser.
- Phase 1 (A/R aging + Overview) — **done**, verified with real YTD data.
  Collected KPI shows "vs $X billed" (no derived %/cap — see data-integrity note).
- Phase 2 (Discrepancies) — **done**, verified in browser (server-paged table,
  HCR roll-up, sign flip, mileage-reconciliation drill). `underpaidSum` added.
  Note: this org's data is net **overpaid** (4,771 over vs 774 under, −$164K net)
  — reinforces the data-integrity reconciliation item above (likely
  `paymentDifference` sign / `paidAmount` semantics).
- Phase 3 (Profitability) — **done**, verified. **Invoice-driven** (revenue from
  finalized invoices — pivoted from a completed-load scan that missed nearly all
  revenue, since invoiced loads have moved past `status='Completed'`). New
  backend: `getProfitabilityBreakdown` action + `getFinalizedInvoicesForProfit`
  / `getLoadCostBatch` / `getLaneLabelBatch` internal queries. By-customer /
  by-lane toggle, vs-fleet chips, data-backed customer drill.
  - **Data note (backlog):** revenue is correct, but per-load cost
    (`loadPayables`/`loadCarrierPayables` by `by_load`) is **sparse** for these
    invoiced loads → margins read ~100%. Org-level direct cost is ~$999K
    (`by_org`) but little is linked to the invoiced loadIds (payables are on
    other/standalone loads). Same data-linkage family as the collected>billed
    gap — the view renders faithfully; the source linkage is the follow-up.

---

## 6. Open decisions

- **Export PDF:** include a report/P&L PDF template in v1, or ship CSV-only and
  defer PDF? (CSV export already exists via `lib/csv-export`.)

---

## Verification notes (what changed after the codebase pass)

- Profitability by customer/lane is **new backend**, not existing reuse (biggest
  correction).
- Overview attention band trimmed to 2 backable counts; the rest depend on the
  mid-migration settlement engine.
- Export PDF was missing from the first draft; PDF infra exists but a report
  template is net-new.
- Drill panel uses a **new thin `sheet` component**, not `details-slide-over`.
- `getReceivablesSummary` returns `avgDaysToPay`, not `DSO`.
- `SavedViews` / `FilterBar` / `DSCard` reuse confirmed 1:1 (lower shell risk
  than assumed).

---

# Upstream review — Invoices → Reports (2026-07)

Reports consume two things the Invoices page owns: the `loadInvoices` rows
(status, totalAmount, paidAmount, paymentDifference, paymentMiles, dates,
customer/load/lane links) and the `accountingPeriodStats` monthly rollup
(maintained by invoice mutations). Review of the whole Invoices surface found the
gaps below. Verified against the downstream data-integrity smells (collected >
billed, net-overpaid discrepancies, sparse per-load cost).

## (a) Prioritized backlog

### Tier A — data accuracy (why Reports don't reconcile)
- **A1. `accountingPeriodStats` drift → "Collected > billed".** `bulkUpdateStatus`
  records paid/invoiced asymmetrically and can double-count on re-transition;
  payments anchor to `invoiceDateNumeric ?? now` (diverges from finalize anchor
  and from the nightly recalc); the recalc (`accountingStats.ts`) uses a
  different rule, overwrites live values, and can itself yield collected>billed
  when `paidAmount > totalAmount`. → Reports "Collected" KPI untrustworthy.
- **A2. Discrepancies are CSV-import-only.** `paymentDifference` + `paymentMiles`
  captured only via the payment CSV import (`confirmPaymentChunk`). "Mark as
  Paid" sets `paymentDifference: 0`, no miles. → Discrepancies report
  structurally under-reports; mileage reconciliation only works with a miles
  column in the CSV.
- **A3. Dead divergent payment mutation** `processPaymentChunk` (invoices.ts:1368)
  drops miles, skips stats, skips finalize. No caller today (footgun). Delete or
  converge.
- **A4. `createInvoice` (fourKitesSyncHelpers.ts) can seed PAID/BILLED with no
  stats call** — latent "imported-as-paid skips finalize" hazard; likely origin
  of the seed data's drift + net-overpaid pattern.
- **A5. `BILLED` status is dead** (finalize goes DRAFT→PENDING_PAYMENT) yet
  receivables queries still scan BILLED — harmless now, silent status-model
  mismatch between Invoices and Reports.

### Tier B — workflow smoothness (accounting friction)
- **B1. No manual single-invoice payment entry** — one check needs a CSV or the
  coarse "Mark as Paid" (no amount/date/ref/miles, forces paid-in-full). Root of
  A2.
- **B2. No partial-payment tracking** — importer marks PAID even when short-paid;
  no "partial, still open with balance" state → A/R aging can't reflect partials.
- **B3. No sortable columns** on the invoice list (amount, due date, days-late,
  balance).
- **B4. No "Send"/delivery** — "Mark as billed" only finalizes; "Sent" tab
  delivers nothing; no email/delivery status.
- **B5. No inline edit** of amounts/line items/dates — a wrong auto-rate can't be
  corrected (only Change Type / Fix Lane / Reset→Draft) → wrong revenue in
  Reports.
- **B6. No manual invoice creation** — invoices come only from load sync + Fix
  Lane; can't bill an ad-hoc charge.

### Tier C — risk / cleanup (see design notes below)
- **C1. Destructive admin tools in the everyday header menu** — `resetPaidToDraft`
  wipes ALL paid invoices org-wide (clears amounts/payments/line items, reverses
  stats) behind a single `confirm()`; `backfillInvoiceNumbers` likewise.
- **C2. Hardcoded bank details + fixed "due within 30 days"** in invoice
  templates — not driven by org settings / customer paymentTerms.
- **C3. Dead code / debug** — `processPaymentChunk`, `fix-lane-modal-old.tsx`,
  `floating-action-bar.tsx`, `console.log`s in the preview route.

## (b) Design — payment-recording + stats-anchor rework (fixes A1, A2, B1, B2)

These four are one coherent piece: a correct payment primitive with one immutable
period anchor, used by every entry point, supporting partials.

**Data model**
- New ledger table `invoicePayments`: `{ workosOrgId, invoiceId, loadId, amount,
  miles?, paymentDate, reference?, note?, createdAt, createdBy }`; indexes
  `by_invoice`, `by_org_created`. Each customer payment is one row.
- `loadInvoices` payment fields become **maintained aggregates** (backward-compat
  with Reports): `paidAmount` = Σ ledger amounts; `paymentMiles` = Σ miles;
  `paymentDifference` = `paidAmount − totalAmount`; `paymentDate`/`paymentReference`
  = latest. Add `statsFinalized: boolean` (guards double-count).

**One primitive** `recordInvoicePayment(invoiceId, { amount, miles?, date,
reference?, note?, closeShort? })`, called by single-entry UI, bulk "Mark as
Paid", and the CSV importer (converge both chunk paths into this):
1. Assert org.
2. **Finalize-once:** if not `statsFinalized`, freeze amounts
   (`enrichInvoiceWithCalculatedAmounts` + `materializeLineItems`), set
   `invoiceDateNumeric = now` **immutably**, `recordInvoiceFinalized(total,
   invoiceDateNumeric)`, set `statsFinalized = true`.
3. Insert an `invoicePayments` row.
4. Recompute aggregates on `loadInvoices` (paidAmount, paymentDifference, miles).
5. **Status:** `paidAmount ≥ total − ε` → PAID; else `closeShort` → PAID
   (accepted short-pay, dispute closed); else PENDING_PAYMENT (partial, open).
6. **Stats:** `recordPaymentCollected(thisRowAmount, invoiceDateNumeric)` — a
   clean per-row positive delta on the SAME immutable anchor. No
   `previousPaidAmount` reconstruction, no re-finalize.

**Why this fixes A1:** invoiced + every collected row share one immutable period
anchor → per-invoice collected can exceed invoiced only by genuine overpayment,
never by anchor drift or double-count. Reversals (void/unpay/delete-payment)
reverse the exact ledger amounts (not `Math.max(0,…)` guesses). The nightly
recalc is rewritten to sum the ledger under the same anchor rule, so it can't
disagree with live.

**Migration / rollout** (mirror the pay-engine strangler pattern):
- Backfill `invoicePayments` from existing `paidAmount` (one synthetic row per
  PAID invoice); backfill `statsFinalized`.
- Recompute `accountingPeriodStats` from the ledger (single anchor), replacing
  drifted values — one-time.
- **Shadow-validate**: compute new stats alongside old, diff, then cut over.

**UI**
- Preview sheet gets a **Record payment** form: amount (default = balance), date,
  reference, miles (optional), "close as short-pay" toggle when amount < balance,
  running balance shown.
- "Mark as Paid" routes through the primitive (records a real full payment row).
- New **Partial** view/filter; A/R aging then reflects open balances correctly.
- CSV importer calls the primitive per row (single source of truth).

## (b) — Design review & revision (2026-07-02)

Reviewed the design against the codebase before building. Findings that **revise**
the design above:

- **The daily recalc (`accountingStats.countAccountingStats`, cron every 24h) is
  already an authoritative full recompute** — paginated scan of all finalized
  invoices, overwrites `accountingPeriodStats` from source, logs drift, zeroes
  stale periods. So imperative-helper drift self-heals ≤24h. **Do NOT rewrite the
  recalc or add a single-immutable-anchor discipline** — that was over-scoped.
- **The "numbers don't reconcile" cause is query CAPS, not drift.**
  `getReceivablesSummary` (1500/status) and `getProfitabilityBreakdown` (2000)
  undercount vs the uncapped period-stats — that's the $348K-vs-$1.3M collected
  gap. And `collected > billed` = real source overpayment (recalc counts
  `Σ paidAmount` vs `Σ totalAmount`), consistent with the −$164K net-overpaid
  discrepancies. **Not a stats-machinery bug.**
- **`payItems` is the house ledger convention** (append rows; engine rows
  immutable; void-and-recreate for corrections) — mirror it if we add a ledger.

**Revised scope (supersedes the ledger+anchor design above):**
1. **One payment write primitive** `recordInvoicePayment` — converge `bulkMarkPaid`
   + `confirmPaymentChunk` + new single-invoice entry into ONE internal helper
   (freeze-if-needed, capture amount/miles/reference/difference, O(1) stats
   delta). **Delete `processPaymentChunk`.** Kills divergence debt + fixes
   miles/discrepancy capture; single path keeps live deltas consistent (cheap).
2. **Fix the Reports caps** — totals read uncapped `accountingPeriodStats`;
   replace cap-and-undercount scans with aggregate reads or pagination. The real
   reconciliation fix.
3. **`invoicePayments` ledger (mirror `payItems`)** — justified by partials +
   audit trail, NOT drift. The one new table; earns its place for AR
   receipts/short-pay handling.
4. **Keep the nightly recalc** as backstop (well-built); optionally align its rule
   to sum the ledger.
5. **NOT doing synchronous recompute-on-write** — a period can hold thousands of
   invoices; per-write recompute is a real latency/read-cost hit. One correct
   O(1) write path + nightly backstop is the better perf/stability trade.
6. **Data-quality audit (non-code)** — is the net overpayment genuine, or an
   artifact of CSV lump-sum remittances matched to single invoices? Decides
   whether "collected > billed" is even a defect.

Debt delta: −1 dead mutation, −2 divergent paths → 1, +1 table on an existing
convention. Net cleaner.

## Progress — Invoices cleanup (2026-07-02)

**Step 1 (safe cleanups) — DONE, verified in browser.**
- Deleted dead `processPaymentChunk` mutation + its unused `PAYMENT_BATCH_SIZE`
  const + the now-unused `internalMutation` import (kept shared `paymentBatchArgs`,
  used by `confirmPaymentChunk`). Removes the A3 footgun outright.
- Deleted dead files `fix-lane-modal-old.tsx`, `floating-action-bar.tsx`; removed
  the debug `console.log` `useEffect` (+ unused `useEffect` import) from the
  invoice preview route.
- **Guarded `resetPaidToDraft`**: replaced the bare `confirm()` with a
  type-to-confirm `AlertDialog` (must type `RESET`; destructive-styled action
  disabled until it matches) and grouped both admin utilities under an
  "Admin tools" label + separator, reset item in destructive red. Verified:
  disabled for wrong input, enabled only on exact `RESET`; never triggered the
  reset. `tsc` clean, no console errors.

**Step 2 (caps) — re-scoped after the final review (NOT a quick fix).** The
"one more review" showed: org Collected/Revenue KPIs already read the *uncapped*
`accountingPeriodStats` (fine); the Profitability truncation (2000 cap on 5548
invoices) is inherent to per-load cost attribution and is **already surfaced**
("Top N of M invoices" note); the A/R 1500/status caps are latent (A/R is tiny
today). So the real "fix" is **per-customer/lane pre-aggregation** (a proper
project), not a query tweak — folded into the backlog rather than rushed.

**Next:** Step 3 (one payment write primitive) + Step 4 (invoicePayments ledger /
partials) — the real design commitment + migration; pause for go-ahead.

## Progress — payment primitive + ledger, Increment 1 (2026-07-02)

**Additive foundation shipped & verified — no existing paths touched, no migration.**
- Schema: new `invoicePayments` ledger table (mirrors `payItems`: append rows,
  ACTIVE/VOID) + `statsFinalized` flag on `loadInvoices`.
- `recordInvoicePayment` — the ONE primitive: freeze-if-needed → append ledger row
  → recompute maintained aggregates (paidAmount/miles/difference) from ACTIVE rows
  → status (Paid / Partial-open / accepted-short) → O(1) stats delta on the
  invoice's immutable period anchor.
- `recordSinglePayment` mutation + `RecordPaymentDialog` wired into the invoice
  preview sheet ("Record payment" on open invoices). Delivers the missing manual
  single-invoice payment entry (B1) + partial payments (B2).
- **Verified end-to-end in browser:** recorded a $300 partial of a $516.42 invoice
  → invoice went **Partial (open)** with a **$216 balance**, ledger row +
  aggregates + stats all updated, no console errors. Partial/short-pay preview and
  the "accept short-pay & close" toggle work.
- **Bug caught + fixed during the test:** the finalize-stats guard re-recorded
  `recordInvoiceFinalized` on already-finalized invoices (statsFinalized undefined
  on legacy rows) → double-count. Fixed: finalize is recorded **only when we
  actually freeze** (matches `confirmPaymentChunk`); already-finalized invoices
  just get the flag set. (The one pre-fix test payment double-counted its invoiced
  side once → self-heals on the nightly recalc.)

**Transitional state (safe):** the ledger is populated only by new manual payments
so far; `paidAmount` remains the source of truth Reports read (unchanged). No
inconsistency in Reports.

**Next increment (the real migration — pause point):** converge
`confirmPaymentChunk` + `bulkMarkPaid` onto the primitive; backfill `statsFinalized`
+ `invoicePayments` from history; **shadow-validate** stats old-vs-new; add a
Partial view/filter; then cut over.

## Bug review of the payment primitive (2026-07-02)

Reviewed the double-count fix and the whole primitive. Two findings:

1. **Finalize double-count (already fixed) — confirmed correct.** Traced all four
   cases (fresh DRAFT pay / legacy PENDING pay / repeat pay / already-flagged).
   Finalize is now recorded only when the invoice is actually frozen here
   (`needsFreeze`); already-finalized invoices just get `statsFinalized` set. No
   double-count in any path.

2. **Second latent bug found + fixed: recompute-from-ledger could clobber a prior
   non-ledger `paidAmount`.** `paidAmount` is recomputed as Σ ACTIVE ledger rows;
   an invoice carrying a `paidAmount` not represented in the ledger (any legacy
   payment) would be overwritten to just the new payment, and the collected delta
   would go negative. **Not reachable in today's UI** (the button only shows on
   BILLED/PENDING_PAYMENT, which never carry `paidAmount`), but a landmine for the
   convergence increment. **Fix: migrate-on-touch** — before recomputing, seed a
   synthetic ledger row for any pre-existing `paidAmount − Σ active rows`, so
   `paidAmount = Σ ACTIVE rows` holds unconditionally (this is exactly what the
   one-time backfill does, applied lazily). Collected delta stays = the new
   payment only; the seed represents already-counted prior collections.

Both verified by full-trace review + `tsc`. Live primitive still verified (the
earlier $300 partial reduced org outstanding $1.6K → $1.3K correctly).

## Progress — payment primitive, Increment 2: converge bulkMarkPaid (2026-07-02)

Reviewing this increment against the code re-scoped it (for the better):
- The **full ledger backfill is NOT needed for correctness** — migrate-on-touch
  seeds prior paidAmount lazily, so the primitive is correct regardless of
  backfill state. A full backfill is only for making the ledger authoritative for
  reporting/audit (deferred, low urgency, not read by Reports yet).
- **`confirmPaymentChunk` convergence deferred** — it already captures miles +
  difference correctly (no functional gap), and converging it needs a deliberate
  CSV re-import semantics decision (overwrite vs additive). Not rushed.
- **Shadow-validation** only becomes meaningful after a full backfill — deferred
  with it.

**Shipped: converged `bulkMarkPaid` onto the primitive.**
- Added `payInFull` mode to `recordInvoicePayment` (settles the remaining balance;
  primitive owns the freeze so finalize is still recorded correctly on DRAFT→PAID).
- `bulkMarkPaid` now routes through the primitive instead of its own freeze/patch/
  stats logic. This **fixes a latent double-count** (the old code did
  `recordPaymentCollected(total, 0)`, so marking an already-partially-paid invoice
  paid double-counted the partial) and now writes a ledger row + correct diff.
- Removed a divergent write path — one fewer place that maintains payment state.
- **Verified in browser:** bulk "Mark as Paid" on 3 open invoices (incl. the one
  carrying a $300 partial) → all settled, org **outstanding → $0**, INV-2026-5546
  reached exactly $516.42 (partial + $216.42 balance, no double-count), no console
  errors.

**Remaining (deliberate-decision work, paused):** `confirmPaymentChunk`
convergence (re-import semantics), full `invoicePayments` + `statsFinalized`
backfill, shadow-validate stats, Partial view/filter.

## Performance batch (2026-07-02)

Grounded in a full-stack perf audit (stack is healthy overall: big tables indexed,
materialized rollups, pagination, virtualization). Did the quick, safe wins:

**Index swaps — cross-tenant scans → org-scoped (all against existing indexes):**
- `customers.list` + `countCustomersByStatus` — were `query('customers').collect()`
  across ALL orgs then filter; now `withIndex('by_organization')`.
- `carrierPartnerships.countPartnershipsByStatus` — `.filter(brokerOrgId)` → `withIndex('by_broker')`.
- `payPlans` ×4 driver scans (350/611/898/1038) — global `drivers` scans →
  `withIndex('by_organization')` first, remaining conditions via `.filter`.

**Dead code removed:**
- `driverSettlements.listForOrganization` (zero live consumers; had a latent
  O(settlements × loadPayables) quadratic).
- The superseded reports `tabs/` + `shared/` cluster (5 tabs + 4 shared files) —
  fully orphaned by the redesign; this was also the *only* live `recharts` /
  `components/ui/chart` consumer, so recharts is now unused (dep can be dropped in
  a follow-up; `ui/chart.tsx` now orphaned too).

All typecheck clean; my touched files have zero TS errors. (Pre-existing unrelated
errors in `load-detail.tsx`/`calendar.tsx` were already in the tree.)

**Deferred (not "quick"): lazy-load `@react-pdf/renderer`.** Re-scoped out — it
touches 5 critical PDF-generation files across invoices + settlements and needs
real download/print testing. Worth doing as a focused, tested pass, not a
drive-by.

## Performance: lazy-load @react-pdf/renderer (2026-07-02) — DONE, both routes verified

Removed the heavy `@react-pdf/renderer` from the initial JS bundle of the
invoices + settlements routes; it now loads only when a PDF is generated.

**Invoices** (template was already a separate file — clean): converted the static
`pdf` + `InvoicePDFTemplate` imports to dynamic `import()` inside the handlers in
`use-bulk-actions.tsx`, `invoice-preview-sheet.tsx`, `[invoiceId]/preview/page.tsx`.

**Settlements** (needed extraction): `SettlementPDF` was *defined inside*
`settlement-doc-panel.tsx` with the `@react-pdf` primitives, making that module —
and everything importing it (types, builders, the panel) — pull `@react-pdf`.
- Extracted `pdfStyles` + `SettlementPDF` into new `settlement-pdf-template.tsx`.
- Exported the shared formatters/helpers it needs (`fmtDateYear`, `fmtPeriodYear`,
  `basisLabel`, `lineDisplay`) from `settlement-doc-panel` (no static cycle:
  template→doc-panel is static, doc-panel→template is dynamic-only).
- `settlement-doc-panel` + `settlements-dashboard` now dynamically import
  `pdf` + `SettlementPDF` in their handlers; doc-panel is fully `@react-pdf`-free.

**Verified in browser (both routes, blob-intercepted, no console errors):**
- Invoices: "PDF" on an invoice preview → valid **4,461-byte** PDF, toast success.
- Settlements: "PDF" on a driver statement → valid **5,337-byte** PDF, toast success.
- Doc-panel still renders the on-screen statement correctly (HTML, no react-pdf).

`tsc` clean across all 7 touched/created files.
