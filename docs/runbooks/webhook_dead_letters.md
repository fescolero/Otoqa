# Runbook — `webhook_dead_letters`

**What fired.** More than 10 partner webhook deliveries are in `DEAD_LETTER`
(exhausted `maxAttempts`).

**What it means.** A partner endpoint has been failing long enough that we gave
up on those deliveries. The partner is missing tracking data.

**Check first**

1. Console → **Health** → *Dead-lettered webhook deliveries*. Group by org and
   error: one partner failing, or many?
   - **One org/partner** → their endpoint. Usual causes: expired TLS cert,
     endpoint moved, auth rotated on their side.
   - **Many orgs at once** → suspect us. Check the delivery job
     (`external-tracking-webhook-delivery`) on the jobs board first.
2. Read `lastHttpStatus` / `lastErrorMessage` on the rows. A 4xx is their
   config; a timeout or DNS failure may be either side.

**Fix**

1. Confirm the endpoint is healthy again (ask the partner, or check that newer
   deliveries to the same subscription are succeeding).
2. **Requeue** from the Health page — single rows or all of them. Attempts reset
   to 0 and delivery is scheduled immediately. Duplicates are safe: partners
   deduplicate on `deliveryId`.
3. Requeueing into a still-broken endpoint just re-deads the rows. Fix first,
   requeue second.

Rows whose subscription has been deleted are skipped, not resurrected — the
requeue result reports how many were skipped and why.

**Escalate when** dead-letters keep accumulating after a successful requeue, or
when a contractual partner has been missing data for more than a few hours.

**Resolved when** the dead-letter count drops below the threshold. Auto-resolves
within 5 minutes.
