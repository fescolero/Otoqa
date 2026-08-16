# Runbook — `billing_drift`

**What fired.** The nightly usage recalc RAISED `loadsWritten` for a period that
already has a committed invoice. The invoice carries a `drift` badge and the
number was **not** changed — that's the whole point.

**What it means.** We under-billed that cycle. The metered count moved after we
froze the invoice, usually because loads were created late or a backfill landed.

**Check first**

1. Billing board → the flagged invoice → *Detail*. Compare `loadsWritten` on
   the invoice against current usage on the org page.
2. Work out the delta in dollars: `(current − invoiced) × the invoice's frozen
   ratePerLoad`. Use the FROZEN rate, not today's.
3. Decide whether it's material. Small deltas are usually not worth a customer
   conversation.

**Fix — pick one, never edit the invoice**

- **Bill it next cycle** (default): add an adjustment line to the next cycle's
  draft describing the prior-period delta.
- **Waive it**: no adjustment; note the decision on the alert so the next person
  doesn't re-investigate.

Never re-issue or edit the committed invoice, and never `rebaseline` the period
— the rebaseline actions hard-fail on invoiced periods by design.

**Escalate when** drift appears on several orgs in the same cycle (that's a
metering bug, not a timing artifact) or when the delta is large enough to need a
customer conversation.

**Resolved when** you've billed or waived it. Resolve the alert manually with a
note recording which one you chose — the condition won't clear on its own.
