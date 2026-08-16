# Runbook — `fourkites_all_failed`

**What fired.** Every FourKites push in a tick failed for one org
(`fourKitesPushTickHealth.lastTickKind = all_failed`).

**What it means.** That customer's loads are not being updated in FourKites at
all. It is customer-visible, and their shipper may notice before they do.

**Check first**

1. Org detail page → *FourKites push health*: `lastErrorKind` and
   `lastErrorStatus` distinguish the cases.
   - **401/403** → credentials. Rotated or revoked on their side.
   - **429** → we're being rate-limited; check whether load volume for that org
     jumped.
   - **5xx / timeout** → FourKites-side. Check whether other orgs are also
     failing (Health board lists every org's tick).
2. All orgs failing → vendor incident, not configuration.

**Fix**

- Credentials → the customer re-issues; update the integration and confirm the
  next tick turns `ok`.
- Rate limit → back off; if it persists, the push cadence for that org needs
  discussion with FourKites.
- Vendor outage → snooze the alert with the vendor ticket in the note, and tell
  the customer before they ask.

**Escalate when** it persists past one hour for a contracted org, or when
`consecutiveTransientTicks` keeps climbing after a credential fix.

**Resolved when** a tick returns `ok` or `empty`. Auto-resolves within 5 minutes.
