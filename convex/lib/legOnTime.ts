/**
 * Compute the on-time stamp for a dispatch leg from its stops. Shared by
 * the completion paths in dispatchLegs.ts and the backfill migration so
 * they cannot disagree. Reads: 2 point reads (start/end stop) + the
 * load's stops via by_load.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { summarizeLegOnTime, type LegOnTimeSummary } from '../_helpers/onTime';

export async function computeLegOnTime(
  ctx: QueryCtx | MutationCtx,
  leg: Pick<Doc<'dispatchLegs'>, 'loadId' | 'startStopId' | 'endStopId'>,
): Promise<LegOnTimeSummary> {
  const [startStop, endStop] = await Promise.all([ctx.db.get(leg.startStopId), ctx.db.get(leg.endStopId)]);
  if (!startStop || !endStop) return { deliveriesEvaluated: 0, deliveriesOnTime: 0 };
  const startSeq = startStop.sequenceNumber ?? 0;
  const endSeq = endStop.sequenceNumber ?? startSeq;
  const stops = await ctx.db
    .query('loadStops')
    .withIndex('by_load', (q) => q.eq('loadId', leg.loadId))
    .collect();
  return summarizeLegOnTime(stops, startSeq, endSeq);
}
