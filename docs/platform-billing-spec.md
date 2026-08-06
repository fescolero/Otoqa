# Platform Billing Specification

_Companion to `platform-admin-console-plan.md` §7.4. How Otoqa bills its customer
organizations, from metering to money in the bank. Last updated 2026-08-06._

Currency: **USD only** (stated explicitly; multi-currency is out of scope).
All period boundaries are **UTC** and printed on invoices as such.

---

## 1. Layer 0 — Metering (exists today, unchanged)

- Every insert into `loadInformation` calls `recordLoadWritten(ctx, orgId, createdAt)`
  (`convex/platformUsageHelpers.ts:54`) — manual create, FourKites sync, recurring
  generator. Counter is **increment-only**: editing/cancelling a load never removes the
  charge (documented product decision).
- Period attribution: the load's `createdAt` month (`"YYYY-MM"` UTC). Loads created before
  the metering cutover (Jul 1 2026, `METERING_CUTOVER_MS`) attribute to their **service
  month** instead, so historical bulk imports don't read as usage spikes.
- Nightly recalc (cron `recalculate-platform-usage`, 04:30 UTC) is **raise-only**
  (`Math.max(existing, counted)`) — a hard-deleted load can never un-charge a period.
- Rate: `organizations.billingRatePerLoad` override, else `DEFAULT_BILLING_RATE_PER_LOAD
  = 2.65` (`platformUsageHelpers.ts:26`).

**Invariant carried forward: the metered count is never edited.** Every commercial
correction happens in a visible adjustment layer on top (§4), never by touching
`platformUsageStats`.

## 2. Layer 1 — The invoice record (`platformInvoices`, new)

### Org billing configuration (console-editable, all audited)

Contracts vary, so the org carries a billing config the cycle-close job reads
(fields on `organizations` / `organizations_sensitive` as appropriate):

```
ratePerLoad,                       // current rate (existing billingRatePerLoad)
rateSchedule?: [{                  // escalators: future-dated steps (some multi-year
  effectiveFromPeriod,             //   contracts step the rate at set dates)
  ratePerLoad }],                  // cycle close picks the step covering the period
recurringCharges?: [{              // fixed fees beyond metered usage
  label, amount,
  cadence: 'monthly' | 'annual',
  anniversaryMonth? }],            // annual charges bill in their anniversary cycle
minimumMonthlyCharge?,             // commitment floor (see line computation below)
terms, taxRatePercent?, taxJurisdiction?, termYears, license window, contacts
```

### The invoice row

One row per org × closed cycle, created by the cycle-close job (§3).

```
platformInvoices {
  workosOrgId, periodKey,                      // identity; unique together
  invoiceNumber,                               // SAME deterministic scheme as today
  loadsWritten,                                // frozen at issue
  ratePerLoad,                                 // frozen at issue (from schedule if set)
  lines: [{ kind: 'usage' | 'recurring' | 'minimum_true_up',
            label, amount }],                  // computed at draft, frozen at issue
  subtotal,                                    // Σ lines, frozen
  adjustments: [{                              // signed line items
    label, amountDelta, reason, addedByEmail, addedAt
  }],
  taxRatePercent?, taxJurisdiction?,           // snapshot at issue; unset = no tax line (§6a)
  taxAmount?,                                  // taxable base × rate, frozen at issue
  total,                                       // subtotal + Σ adjustments + taxAmount
  payments: [{ amount, method: 'ach' | 'check' | 'wire' | 'stripe' | 'other',
               reference?, recordedByEmail, receivedAt }],  // check #s, ACH refs
  amountPaid,                                  // Σ payments (denormalized)
  status: 'draft' | 'issued' | 'sent' | 'paid' | 'void',
  terms: { kind: 'net', days: number }         // net-N (N ≤ 15 typical, per agreement)
       | { kind: 'dayOfMonth', day: number },  // fixed calendar due day (1–28; see §3)
  issuedAt?, dueAt?, paidAt?, voidedAt?, voidReason?,
  driftDetectedAt?,                            // §5
  stripeInvoiceId?,                            // §7, null until Stripe phase
}
.index('by_org_period', ['workosOrgId','periodKey'])
.index('by_status', ['status'])
```

**Numbering** keeps `platformInvoiceNumber()` (`convex/platformUsage.ts:333`) —
`INV-<ORG6>-<SEQ>`, monthly series anchored Jan 2024 — so nothing in history renumbers
and page/CSV/PDF stay consistent. Credit notes (§4) get their own `CN-<ORG6>-<n>` series.

**State machine** (all transitions staff-actioned or job-actioned, all audited):

```
draft ──issue──▶ issued ──send──▶ sent ──payment≥total──▶ paid
  │                 │               │
  └─delete          └────void───────┴────void  (reason required; pre-payment only)
```

- `overdue` is **derived** (status issued/sent AND now > dueAt), never stored — no job
  needed to flip it, no stale state possible.
- Partial payments: staff record payments with an amount; `amountPaid` accumulates;
  status flips to `paid` only when `amountPaid ≥ total`. Underpayment stays
  issued/sent with a visible balance.
- Post-issue corrections NEVER edit the invoice: either **void + reissue** (pre-payment,
  e.g. wrong rate) or a **credit note / next-cycle adjustment** (post-payment).

**Immutability rule:** once `status ≠ draft`, the row's `loadsWritten`, `ratePerLoad`,
`subtotal`, and existing adjustment lines are frozen. This is what fixes today's latent
bug where `getBillingOverview` recomputes closed cycles from the *current* rate
(`platformUsage.ts:360,408-425`) and a rate change silently rewrites "paid" history.

## 3. Cycle close — how an invoice is born

Monthly job (new cron), **03:00 UTC on the 2nd** of each month:

1. Runs after the nightly recalc window so the count for the just-closed month has had a
   full drift-correction pass. (The period boundary itself is clean — attribution is by
   `createdAt`, so a load created on the 1st belongs to the new cycle.)
2. For each org, compute the draft's lines from the billing config:
   - **usage**: `loadsWritten × ratePerLoad` (rate = the `rateSchedule` step covering
     this period, else the current rate);
   - **recurring**: every `monthly` charge, plus any `annual` charge whose anniversary
     month this is;
   - **minimum_true_up**: `max(0, minimumMonthlyCharge − (usage + monthly recurring))`
     when a minimum is configured — annual charges don't count toward the minimum.
   A draft is created when any line is non-zero.
3. Cycles with no non-zero line: **no invoice issued** (default; §8-D2), but the cycle
   still renders in the tenant timeline as a zero row.
4. Drafts sit for a **review window until the 5th**: staff see all drafts on the console's
   billing board, can add adjustments, then bulk-issue. On the 5th, any untouched drafts
   **auto-issue** (the default path once we trust the pipeline; initially auto-issue is
   off and issuing is manual — §8-D1).
5. Issue sets `issuedAt = now` and computes `dueAt` from the org's terms: `net` →
   `issuedAt + days`; `dayOfMonth` → the next occurrence of that calendar day strictly
   after issue (issue on the 2nd with day 20 → the 20th this month; day already passed →
   next month; days 29–31 are stored as given but clamp to the last day of short months).
   It emits the PDF (reuse the
   existing React-PDF template at
   `app/(app)/settings/billing/_components/billing-invoice-pdf-template.tsx`), and — once
   email exists (§8-V2) — sends it to `organizations.billingEmail` (a required field
   already).

Idempotency: the job upserts by `(workosOrgId, periodKey)`; re-running it can never
double-invoice. It refuses to touch rows with `status ≠ draft`.

## 4. Adjustments, credits, and the "never edit the meter" rule

Three correction mechanisms, in order of preference:

1. **Draft adjustments** — before issue, staff add signed line items to the draft
   (`-$132.50 — duplicate FourKites sync loads, ticket #241`). Requires reason; audited.
2. **Next-cycle adjustments** — after issue/payment, corrections ride the *next* invoice
   as line items. Keeps the ledger append-only.
3. **Credit notes** — standalone negative documents (`CN-` series) when there is no next
   cycle to ride (churned org) or the customer needs a formal credit document. Stored in
   the same table with `total < 0` and a `creditForInvoiceId` link.

Goodwill credits, disputed-load removals, minimum-commitment true-ups, and migration
discounts are all just adjustment lines with reasons — no special cases in the engine.

## 5. Drift: when the meter moves after invoicing

The nightly recalc is raise-only and *can* raise a period that's already invoiced (e.g.
a backfilled sync writes loads with an old `createdAt`). Handling:

- Recalc compares its new count against any invoice for that period. If
  `newCount > invoice.loadsWritten`: set `driftDetectedAt`, write a `systemEvents` warn
  (`billing.drift`, org, delta), and surface a **drift badge** on the invoice in the
  console. **Nothing changes silently.**
- Resolution is a human decision: bill the delta as a next-cycle adjustment line
  ("late-attributed loads for 2026-08: +37 × $2.65"), or waive it (audited either way).
- `rebaselineOrgPlatformUsage` / `rebaselinePlatformUsage` **hard-fail** for any period
  with an invoice in `status ≠ draft|void` — today's "only safe pre-invoicing" docstring
  becomes an enforced check.

## 6. Rate & contract changes

- `billingRatePerLoad` edits in the console take effect **from the next cycle**. The UI
  shows "current rate / next-cycle rate" when a change is pending.
- **Escalators (RESOLVED: some contracts have them):** multi-year agreements may step the
  rate at contract dates. The `rateSchedule` (§2) holds future-dated steps entered when
  the contract is signed; cycle close applies whichever step covers the period, so
  escalations happen on schedule without anyone remembering to edit the rate. Console
  shows the full schedule on the org billing tab and flags the cycle where a step lands.
- Backdating a rate is allowed **only** onto periods with no issued invoice, requires
  step-up + reason, and is audited with before/after.
- **Contract term vs billing cycle (RESOLVED 2026-08-06):** these are two different
  things. The contractual **term** varies per agreement — 1, 3, 5, or 8 years — and lives
  in the license window (`platformLicenseStart`/`platformLicenseEnd`, plus a `termYears`
  field for display). **Billing is always monthly** regardless of term. The legacy
  `organizations.billingCycle` string is retired in favor of these explicit fields.
- **Payment terms (RESOLVED):** per-org, either net-N with N ≤ 15 (never longer), or a
  fixed calendar due day of the month — the `terms` union in §2. Default for orgs with
  nothing specified: net-15 (matches today's derived behavior).
- Contract fields (number, term, license window, terms, contacts) are console-editable
  and audited.
- License expiry (`platformLicenseEnd`) surfaces on the console org page — for multi-year
  terms, alerts at 180/90/30 days out (systemEvent + badge) so a renewal on a 3–8 year
  contract isn't discovered by accident.

## 6a. Taxes (mechanism now, rates later — RESOLVED as design)

Rates are unknown today, but the engine supports them from day one so adding a rate is
data entry, not a schema migration:

- Per-org tax config on the billing tab: `taxRatePercent` + `taxJurisdiction` (free-text
  label, e.g. "TX", set according to where the client is based). Both optional; unset
  means no tax line and the invoice footer states "tax not included".
- At issue time the invoice **snapshots** the rate and computes
  `taxAmount = (subtotal + adjustments) × rate` as a frozen line — a later rate change
  never touches issued invoices, same immutability rule as everything else.
- Backfilled historical invoices carry no tax line.
- When real rates are determined (accountant, per client state — §11 V-B3), staff fill
  the per-org fields; if obligations turn out to be multi-state/complex, Stripe Tax can
  replace manual rates at the Stripe phase without changing the invoice model (it just
  becomes the source of the snapshot).

## 7. Payments — Stripe phase (after manual lifecycle is proven)

Order of adoption is deliberate: **manual invoice lifecycle first** (Phases 0-3), Stripe
second. Billing must work — issue, track, record check/ACH payments by hand — before a
processor is in the loop.

- **Stripe Invoicing** (not raw PaymentIntents): create a Stripe customer per org into
  the reserved `organizations_sensitive.stripeCustomerId` column, push our frozen invoice
  as a Stripe invoice (`stripeInvoiceId` link), Stripe hosts the payment page + receipts.
- **ACH-first**: freight back-offices pay by bank transfer; card fees (~2.9%) on
  four-figure invoices are worth avoiding. Enable ACH debit + credit-card as fallback.
- **Webhooks**: new authenticated route in `convex/http.ts` (there are currently NO
  inbound webhooks — this is the first) with Stripe signature verification;
  `invoice.paid` → record payment + flip status; `invoice.payment_failed` → systemEvent +
  dunning state.
- **Reconciliation job**: nightly compare of Stripe invoice status vs `platformInvoices`;
  any mismatch is a systemEvent, never auto-corrected. Stripe is the payment record;
  `platformInvoices` remains the billing record of truth.
- **Dunning**: Stripe Smart Retries for autopay orgs; reminder emails (due-3d, due date,
  +7d, +14d) for invoice-pay orgs; past-due badge in the console aging view. Suspension
  for non-payment is a **human decision from the console** (flag-driven), never automatic.
- **Sales tax**: SaaS taxability varies by state (e.g. Texas taxes SaaS). Get an
  accountant's read on nexus; if taxable, Stripe Tax computes at issue time and the
  invoice gains a tax line (§8-V3). Until then invoices state "tax not included".

## 8. Tenant-facing changes

- `getBillingOverview` switches closed cycles to read `platformInvoices` where a row
  exists; **backfill** all historical closed cycles as `paid` invoice rows at migration
  so there is exactly one code path (no placeholder branch kept alive).
- The tenant page gains nothing new visually at first — same table, but statuses/dates
  become real, and the "amounts change when rate changes" bug dies.
- Later (Stripe): a "Pay now" link on due invoices and stored payment-method display.
  Autopay enrollment is console-initiated per contract, not tenant self-serve, initially.

## 9. Console billing surfaces

- **Revenue dashboard**: MRR (issued totals by month), accrual for the open cycle
  (live count × rate), collection rate, **DSO**, and an **aging view** (current /
  1-30 / 31-60 / 61-90 / 90+ days past due — same buckets as the domain-side
  `customerAging.ts` for familiarity).
- **Billing board**: draft queue (cycle-close output awaiting review), issued/sent list
  with balances, drift badges, overdue filter.
- **Invoice detail**: frozen lines, adjustments with reasons, payment records, PDF,
  Stripe link (later), full audit trail of every touch.
- **Org billing tab**: rate (with pending next-cycle change), terms, contacts, contract +
  license window, invoice history, "record manual payment" and "add adjustment" actions.
- All writes: `platformAuditLog` with reason; void/credit require step-up auth.

## 10. Edge cases (decided here so they're not improvised later)

| Case | Handling |
| --- | --- |
| Org soft-deleted mid-cycle | Cycle-close still invoices the partial cycle (loads were written); open invoices remain collectible; restore resumes metering. |
| Org disputes specific loads | Invoice stays as-is; resolution = adjustment/credit with the dispute ticket referenced. Dunning paused via a `disputed` flag while open. |
| Payment arrives for a voided invoice | Record against the reissued invoice; console warns on void-with-payments. |
| Duplicate payment | `amountPaid > total` shows a credit balance surfaced to staff; applied as next-cycle adjustment or refunded. |
| Corrupt ancient periodKey (e.g. "1970-01") | Already bounded by the 24-cycle window in the overview; cycle-close ignores periods before Jan 2024 (invoice-series epoch). |
| Org with rate override removed | Reverts to default rate **next cycle**, same as any rate change. |
| First cycle after cutover | Jul 2026 is the first metered cycle; earlier cycles were backfilled by service month and get backfilled `paid` records (§8). |

## 11. Open items (roll up into plan §14)

**Resolved 2026-08-06 (owner decisions):**
- ~~V-B1~~ — contract term is 1/3/5/8 years per agreement; billing is always monthly (§6).
- ~~D-B4~~ — payment terms are net-≤15 or a fixed due day, per agreement (§2, §3).
- V-B3 (partial) — tax **mechanism** built now (per-org rate + jurisdiction, snapshot at
  issue, §6a); actual rates still pending accountant/per-state determination.

**Resolved 2026-08-06 (second round):**
- ~~D-B3~~ — both fixed fees AND monthly minimums exist in real agreements → modeled as
  `recurringCharges` + `minimumMonthlyCharge` with a `minimum_true_up` line (§2, §3).
- ~~D-B5~~ — some multi-year contracts have rate escalators → `rateSchedule` with
  future-dated steps applied automatically at cycle close (§2, §6).
- ~~D-B6~~ — clients pay by ACH and check → payment records carry method + reference
  (check number / ACH ref); confirms ACH-first for the Stripe phase.
- ~~V-B2~~ — invoice email deferred by decision: invoices are download/manual-send for
  the first cycles; "sent" is a staff-marked status. Provider chosen when automated
  sending is wanted.

**Still open:**
- D-B1 — auto-issue on the 5th vs manual-issue-only initially (default: manual until two
  clean cycles).
- D-B2 — zero-line cycles get no invoice (default: yes, skip).
- V-B3 — actual tax rates per client state (accountant); mechanism is ready (§6a).
