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
