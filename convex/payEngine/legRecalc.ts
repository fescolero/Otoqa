// Completed-work recalc trigger.
//
// Since the completed-work gate in calculatePayForLeg, pay items are only
// written for COMPLETED legs (and, for drivers, only once the leg's shift
// has ended). That makes leg completion and session end PRICING EVENTS:
// every code path that flips a leg to COMPLETED must schedule a recalc
// through here, or the leg keeps whatever (possibly zero) items it had
// from the last gated run.
//
// Uses the same latest-wins coalesce contract as the legacy cascade:
// stamp leg.latestRecalcRequestedAt, pass the identical timestamp to the
// scheduled job so an older queued recalc yields instead of racing.

import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

export async function scheduleLegPayRecalc(
  ctx: MutationCtx,
  legId: Id<'dispatchLegs'>,
  userId: string,
): Promise<void> {
  const requestedAt = Date.now();
  await ctx.db.patch(legId, { latestRecalcRequestedAt: requestedAt });
  await ctx.scheduler.runAfter(0, internal.payEngine.calculatePayForLeg.calculatePayForLeg, {
    legId,
    userId,
    requestedAt,
  });
}

/**
 * Inline void of a load's unlocked engine payItems — for the paths where a
 * scheduled recalc can't do the cleanup: unassignment clears the leg's
 * payee (calculatePayForLeg exits LEG_UNASSIGNED before its void loop) and
 * load deletion removes the load doc the recalc would need to re-read.
 * Locked rows (reviewer edits / approval-frozen) survive, same as a recalc.
 * Pass a legId to scope the void to one leg; omit for the whole load.
 */
export async function voidUnlockedLegPayItems(
  ctx: MutationCtx,
  loadId: Id<'loadInformation'>,
  legId: Id<'dispatchLegs'> | null,
  reason: string,
): Promise<number> {
  const now = Date.now();
  const items = await ctx.db
    .query('payItems')
    .withIndex('by_load_payee', (q) => q.eq('sourceRef.loadId', loadId))
    .collect();
  let voided = 0;
  for (const it of items) {
    if (it.isVoided || it.isLocked) continue;
    if (legId && it.sourceRef.legId !== legId) continue;
    await ctx.db.patch(it._id, {
      isVoided: true,
      voidedAt: now,
      voidReason: reason,
      updatedAt: now,
    });
    voided++;
  }
  return voided;
}
