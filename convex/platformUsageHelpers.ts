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
export const DEFAULT_BILLING_RATE_PER_LOAD = 2.5;

/**
 * Record that a load was written into the system for an org.
 * Call from EVERY code path that inserts into loadInformation
 * (manual create, FourKites sync, recurring-load generator, ...).
 *
 * @param ctx - Mutation context
 * @param orgId - WorkOS org ID the load belongs to
 * @param timestamp - The load's createdAt (defaults to now) — determines the cycle
 */
export async function recordLoadWritten(
  ctx: MutationCtx,
  orgId: string,
  timestamp: number = Date.now(),
): Promise<void> {
  const periodKey = getPeriodKey(timestamp);

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
