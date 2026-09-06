/**
 * Load completion reconcile — closes the gap between "every stop is
 * closed" and "the load row says Completed".
 *
 * Only the driver's final check-out tap used to complete a load. When a
 * stop was closed by anything else — the geofence fallback after a missed
 * tap, a shift ending with the leg still open — the stops read Delivered,
 * the leg read COMPLETED, and the load sat at Assigned / In Transit with
 * nothing scheduled to ever finish it (load 121536139, 2026-09-05).
 *
 * reconcileLoadCompletion is called from every path that can close a stop
 * or a leg without the driver's tap. It completes the load through the
 * same status helper the tap uses, so the carrier assignment, leg, pay and
 * tracking-row cascades all run, and stamps completionSource so readers
 * can tell an inferred completion from a confirmed one.
 */

import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import {
  deriveLoadProgress,
  type LoadCompletionSource,
  type LoadProgress,
} from '../_helpers/loadProgress';

/** Read a load's stops and derive its progress — the one call every
 *  query projecting a load should make. */
export async function loadProgressForLoad(
  ctx: QueryCtx | MutationCtx,
  load: Doc<'loadInformation'>,
  stops?: Doc<'loadStops'>[],
): Promise<LoadProgress> {
  const rows =
    stops ??
    (await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', load._id))
      .collect());
  return deriveLoadProgress(load, rows);
}

/**
 * Complete the load if every counted stop is closed and the row still says
 * Assigned. Returns true when it completed the load this call. Open loads
 * are left alone (nothing has been dispatched); Completed / Canceled /
 * Expired are terminal.
 */
export async function reconcileLoadCompletion(
  ctx: MutationCtx,
  loadId: Id<'loadInformation'>,
  source: LoadCompletionSource,
): Promise<boolean> {
  const load = await ctx.db.get(loadId);
  if (!load || load.status !== 'Assigned') return false;

  const progress = await loadProgressForLoad(ctx, load);
  if (!progress.allStopsClosed) return false;

  await ctx.runMutation(internal.loads.updateLoadStatusInternal, {
    loadId,
    status: 'Completed',
    completionSource: source,
  });
  return true;
}
