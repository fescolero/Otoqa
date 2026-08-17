# Runbook — reconstructing an account's billing history

**When to use this.** An organization's invoices, payments or credits don't
reflect what actually happened: cycles marked paid that never were, payments
recorded before the invoices existed, credit sitting unusable beside overdue
balances. The usual cause is `backfillHistoricalPaidInvoices`, which creates
every historical cycle as **paid with an empty payment ledger** — a fair
shortcut for cycles genuinely settled, a fiction for cycles that were not.

**The rule everything follows:** money is never edited. Each step either adds a
record, or withdraws a claim that had no record behind it. Anything already
evidenced can only be corrected by a reversal, which stays visible.

---

## 0. Read the account first

Billing board, for this org:

| What you see | What it means |
| --- | --- |
| **Outstanding $0** with a large **Credit owed to orgs** | Invoices are marked paid (probably by the backfill) and real payments had nowhere to land, so they became credit. The account looks settled *and* overfunded; it is neither. |
| Rows in **Payments without a record** | `amountPaid` exceeds the sum of the payment entries. That difference is a claim with no evidence. |
| **Outstanding net of credit** | What is genuinely collectable once the credit is placed. This is usually the number you actually want. |

Write down, before touching anything:

- total billed (invoice ledger)
- total cash actually received (bank statements — not the console)
- expected closing balance = billed − received

The board carries those first two figures itself — **Invoiced** and **Paid** —
and they reconcile exactly:

```
Invoiced − Paid − Written off = Outstanding
```

**Paid** is how much of what you billed has been settled, counted once no
matter how many invoices the money passed through: a transfer that overpaid one
invoice and carried the rest to the next is one payment, not two. When money
arrived that hasn't settled an invoice yet — or an invoice was settled with
credit rather than money — the tile adds a second line saying what actually
reached the bank. No second line means the two agree.

Compare **Invoiced** against your billing figure and **Paid** against the bank,
and any disagreement is in the ledger, not in your arithmetic.

Every step below should move the console toward that number. If it doesn't,
stop.

---

## 1. Decide what each unevidenced claim is

For every invoice in **Payments without a record**, exactly one is true:

- **The money arrived** → *Document payment*. Records method, reference and the
  real date. Capped at the undocumented amount and does not change what was
  paid — it writes the record, not the money.
- **It never arrived** → *Never paid*. Withdraws the claim; the invoice returns
  to issued/sent and re-enters the aging buckets.

Where a whole history was backfilled, use **"Never paid — clear all N"** on the
organization group rather than clicking through them. It applies the same rule
to every row that has a gap and reports what it restored.

⚠️ One case looks like the first but is the second: an invoice marked paid for
its face value when the customer actually paid **more**. Documenting only covers
the face value and leaves the invoice `paid`, so the excess can never be
recorded. Clear the claim and re-record the real payment instead — the
overpayment then posts as credit on its own.

---

## 2. Void payments that landed as credit

If payments were recorded while every invoice was marked paid, allocation had
nothing to apply them to and posted them as *"Paid ahead on …"* credit. Those
are not credit, they are misfiled payments.

Void them (org page → Account credit → Void). They are unconsumed, so voiding is
allowed. **Leave genuine credit alone** — a real overpayment, a goodwill credit,
a service credit.

Skip this step if you don't need the wire references on the invoices; applying
the credit as-is reaches the same balances. The trade is provenance: bank
references stay on the credit rows instead of the invoices, so statement
reconciliation is harder later.

---

## 3. Record the real payments

Org page → **Record a payment across invoices**, once per transfer, **in date
order**.

- Amount, method, bank reference, and the date the money actually arrived.
- It settles open invoices oldest-first by due date, splits across as many as
  the amount covers, and posts any excess as credit.
- A repeat of the same reference on the same date is refused — that shape is
  almost always a double submission.

Check each amount against the statement before submitting: a mismatched date and
amount pair puts the split on the wrong invoices, and unwinding that is several
reversals.

---

## 4. Place the credit

Org page → **Apply credit across invoices**. Spends available credit
oldest-first and reports what is still owed and what credit remains.

Credit applications are dated to when the credit **could first have settled**
each invoice — `max(credit created, invoice issued)` — not to today. A credit
that sat on the account for months therefore settles the invoice it covers as of
that invoice's issue date, and the invoice reads *paid on time* rather than
months late. This matters: the alternative slanders a customer who paid early.

If a credit's own date is wrong (it was keyed later than the money arrived),
reverse the payment that created it and re-record with the right date, or void
it and issue a manual credit carrying the correct date.

---

## 5. Verify

- **Invoiced** equals your billed figure and **Paid** equals what the bank
  actually received.
- **Outstanding** equals your billed − received figure from step 0.
- **Outstanding** and **Outstanding net of credit** agree (credit fully placed),
  or differ by exactly the credit you deliberately left on the account.
- **Payments without a record** is empty.
- Aging buckets look like the real ages, not all-or-nothing.
- Spot-check one invoice: the payments on it carry the right dates, references
  and methods, and the `paid Nd late` chip matches reality.

Every step wrote a `platformAuditLog` entry with your reason. Audit → filter by
this org shows the whole reconstruction as one sequence, which is what an
auditor (or a future you) will want.

---

## Avoiding this next time

- Prefer `cycleClose` per period over `backfillHistoricalPaidInvoices` when the
  cycles were **not** paid. The backfill exists to stop history re-pricing under
  rate changes, not to assert settlement.
- Record payments through the console as they arrive; credit then applies itself
  at issue and none of the above is needed.
- If you must backfill, do it before recording any payments — the order in this
  runbook is exactly the order that avoids the mess.
