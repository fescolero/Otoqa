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

One row per org × closed cycle, created by the cycle-close job (§3).

```
platformInvoices {
  workosOrgId, periodKey,                      // identity; unique together
  invoiceNumber,                               // SAME deterministic scheme as today
  loadsWritten,                                // frozen at issue
  ratePerLoad,                                 // frozen at issue
  subtotal,                                    // loadsWritten × ratePerLoad, frozen
  adjustments: [{                              // signed line items
    label, amountDelta, reason, addedByEmail, addedAt
  }],
  total,                                       // subtotal + Σ adjustments
  amountPaid,                                  // running total of recorded payments
  status: 'draft' | 'issued' | 'sent' | 'paid' | 'void',
  termsDays,                                   // default 15 (net-15, matches today's due-on-15th)
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
2. For each org with `loadsWritten > 0` in the closed period (or a contractual minimum,
   §8-D3): create a `draft` invoice with frozen count/rate/subtotal.
3. Zero-usage cycles: **no invoice issued** (default; §8-D2), but the cycle still renders
   in the tenant timeline as a zero row.
4. Drafts sit for a **review window until the 5th**: staff see all drafts on the console's
   billing board, can add adjustments, then bulk-issue. On the 5th, any untouched drafts
   **auto-issue** (the default path once we trust the pipeline; initially auto-issue is
   off and issuing is manual — §8-D1).
5. Issue sets `issuedAt = now`, `dueAt = issuedAt + termsDays`, emits the PDF (reuse the
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
- Backdating a rate is allowed **only** onto periods with no issued invoice, requires
  step-up + reason, and is audited with before/after.
- Contract fields (number, license window, terms, contacts) are console-editable and
  audited. `organizations.billingCycle` (holds values like "Annual") has **undefined
  semantics today** — clarify what it means contractually before wiring it to anything
  (§8-D4). Until then the engine bills monthly metered, which matches the code as built.
- License expiry (`platformLicenseEnd`) surfaces on the console org page 60/30/7 days out
  (systemEvent + badge) so renewals aren't discovered by accident.

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

**Verify:** V-B1 — what `organizations.billingCycle` ("Annual") means contractually.
V-B2 — email provider for invoice delivery (none exists in the repo today; Resend or
Postmark are the obvious candidates). V-B3 — sales-tax obligations (accountant;
whether Stripe Tax is needed).

**Decide:** D-B1 — auto-issue on the 5th vs manual-issue-only initially (default:
manual until two clean cycles). D-B2 — zero-usage cycles get no invoice (default: yes,
skip). D-B3 — contractual monthly minimums: none modeled today; add
`minimumMonthlyCharge` only if a contract actually has one. D-B4 — payment terms
per-org (`termsDays`) default 15; confirm against signed contracts.
