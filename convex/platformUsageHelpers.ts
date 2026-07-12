/**
 * Helper functions for maintaining the platformUsageStats aggregate table.
 *
 * Otoqa's platform billing is metered: each org is charged a flat rate for
 * every load written into the system, invoiced monthly. This module follows
 * the same event-driven counter pattern as stats_helpers.ts /
 * accountingStatsHelpers.ts, with the nightly drift-correcting recalc in
 * platformUsage.ts.
 *
 * Billing semantics: a load counts for the cycle it was CREATED in.
 * Editing or cancelling a load later does not remove the charge, so
 * this counter is increment-only (no decrement helper on purpose).
 *
 * Period key format: "YYYY-MM" (monthly granularity, UTC) — shared with
 * accountingPeriodStats via getPeriodKey.
 */

import { MutationCtx } from './_generated/server';
import { getPeriodKey } from './accountingStatsHelpers';

/**
 * Rate applied when the org has no billingRatePerLoad override.
 * Kept here (not in the UI) so backend and frontend read one source of truth
 * through the getBillingOverview query.
 */
export const DEFAULT_BILLING_RATE_PER_LOAD = 2.65;

/**
 * When platform metering went live — the start of the first cycle billed on
 * entry date (July 2026).
 *
 * Loads created BEFORE this moment predate metering: their createdAt reflects
 * whenever the record happened to enter Otoqa (bulk imports, sync backfills),
 * not real usage, so the recalc attributes them to their SERVICE month
 * (firstStopDate) to keep historical cycles truthful. Loads created at or
 * after this moment are attributed to their entry month (createdAt) — the
 * auditable, immutable billing basis.
 */
export const METERING_CUTOVER_MS = Date.UTC(2026, 6, 1); // Jul 1, 2026 UTC

/**
 * Record that a load was written into the system for an org.
 * Call from EVERY code path that inserts into loadInformation
 * (manual create, FourKites sync, recurring-load generator, ...).
 *
 * @param ctx - Mutation context
 * @param orgId - WorkOS org ID the load belongs to
 * @param timestamp - The createdAt written to the loadInformation row —
 *   determines the cycle. Required so every insert site states the coupling
 *   explicitly (the nightly recalc attributes by load.createdAt, and the two
 *   must agree). Non-finite values fall back to now rather than minting a
 *   garbage periodKey.
 */
export async function recordLoadWritten(
  ctx: MutationCtx,
  orgId: string,
  timestamp: number,
): Promise<void> {
  const periodKey = getPeriodKey(Number.isFinite(timestamp) ? timestamp : Date.now());

  const existing = await ctx.db
    .query('platformUsageStats')
    .withIndex('by_org_period', (q) => q.eq('workosOrgId', orgId).eq('periodKey', periodKey))
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, {
      loadsWritten: existing.loadsWritten + 1,
      updatedAt: Date.now(),
    });
  } else {
    await ctx.db.insert('platformUsageStats', {
      workosOrgId: orgId,
      periodKey,
      loadsWritten: 1,
      updatedAt: Date.now(),
    });
  }
}
