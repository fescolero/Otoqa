/**
 * Compute the on-time stamp for a dispatch leg from its stops. Shared by
 * the completion paths in dispatchLegs.ts and the backfill migration so
 * they cannot disagree. Reads: 2 point reads (start/end stop) + the
 * load's stops via by_load.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { summarizeLegOnTime, type LegOnTimeSummary } from '../_helpers/onTime';
import { scheduleLegPayRecalc } from '../payEngine/legRecalc';

export async function computeLegOnTime(
  ctx: QueryCtx | MutationCtx,
  leg: Pick<Doc<'dispatchLegs'>, 'loadId' | 'startStopId' | 'endStopId'>,
  /** Pre-read stops for the leg's load, when the caller already has them. */
  preloadedStops?: Doc<'loadStops'>[],
): Promise<LegOnTimeSummary> {
  const [startStop, endStop] = await Promise.all([ctx.db.get(leg.startStopId), ctx.db.get(leg.endStopId)]);
  if (!startStop || !endStop) return { deliveriesEvaluated: 0, deliveriesOnTime: 0, deliveriesMaxLateMs: 0 };
  const startSeq = startStop.sequenceNumber ?? 0;
  const endSeq = endStop.sequenceNumber ?? startSeq;
  const stops =
    preloadedStops ??
    (await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', leg.loadId))
      .collect());
  return summarizeLegOnTime(stops, startSeq, endSeq);
}

export type LegEndReason = NonNullable<Doc<'dispatchLegs'>['endReason']>;

/**
 * Close a leg — the ONE way a leg becomes COMPLETED. Every completion
 * path (driver's final check-out, load-level completion cascade,
 * handoff, shift end, carrier completion) goes through here so the stamp
 * cannot drift between them:
 *
 *   - idempotent: a COMPLETED or CANCELED leg is left alone (returns false);
 *   - the delivery on-time roll-up is written only for a leg that was
 *     actually driven (ACTIVE). A PENDING leg closed because the load
 *     completed never ran — stamping it would credit or blame a driver
 *     for stops someone else made;
 *   - completion is a pricing event, so the pay recalc is scheduled unless
 *     the caller schedules it itself (shift end does, after the session
 *     row is closed, so the completed-work gate sees the closed shift).
 */
export async function closeLeg(
  ctx: MutationCtx,
  leg: Doc<'dispatchLegs'>,
  opts: {
    endReason: LegEndReason;
    endedAt: number;
    /** Pay-recalc actor: a user id or a 'system:*' tag. */
    actor: string;
    stops?: Doc<'loadStops'>[];
    schedulePay?: boolean;
  },
): Promise<boolean> {
  if (leg.status === 'COMPLETED' || leg.status === 'CANCELED') return false;
  const onTime = leg.status === 'ACTIVE' ? await computeLegOnTime(ctx, leg, opts.stops) : {};
  await ctx.db.patch(leg._id, {
    status: 'COMPLETED',
    endedAt: opts.endedAt,
    endReason: opts.endReason,
    updatedAt: opts.endedAt,
    ...onTime,
  });
  if (opts.schedulePay !== false) {
    await scheduleLegPayRecalc(ctx, leg._id, opts.actor);
  }
  return true;
}
