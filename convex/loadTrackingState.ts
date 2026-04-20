import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { QueryCtx, MutationCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';

/**
 * loadTrackingState — per-load geofence frontier.
 *
 * Exactly one row per load while it's being driven. Created on stop-1
 * check-in; advanced on each subsequent check-in; transferred on handoff;
 * deleted on last-stop checkout.
 *
 * This table is deliberately hot and narrow: only the geofence evaluator,
 * check-in/out mutations, and handoff mutations write to it. Dispatcher
 * dashboards do NOT subscribe to it, so per-ping flag flips don't
 * cascade reactive invalidations.
 *
 * All mutations here are internal — callers (checkInAtStop, checkOutFromStop,
 * handoffLoad, evaluateLatestPing) own the auth checks that gate them.
 */

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

export async function getByLoadId(
  ctx: QueryCtx | MutationCtx,
  loadId: Id<'loadInformation'>
): Promise<Doc<'loadTrackingState'> | null> {
  return ctx.db
    .query('loadTrackingState')
    .withIndex('by_load', (q) => q.eq('loadId', loadId))
    .first();
}

// ============================================================================
// INTERNAL MUTATIONS
// ============================================================================

/**
 * Create or re-initialize the tracking state for a load. Called from
 * checkInAtStop when the driver arrives at stop 1.
 *
 * Idempotent: if a row already exists for this load, the mutation is a
 * no-op. This protects against retries in the check-in flow.
 */
export const initForLoad = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    sessionId: v.id('driverSessions'),
    driverId: v.id('drivers'),
    organizationId: v.string(),
    firstStopSeq: v.number(),
    firstStopLat: v.number(),
    firstStopLng: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await getByLoadId(ctx, args.loadId);
    if (existing) return null; // idempotent

    await ctx.db.insert('loadTrackingState', {
      loadId: args.loadId,
      sessionId: args.sessionId,
      driverId: args.driverId,
      organizationId: args.organizationId,
      currentStopSequenceNumber: args.firstStopSeq,
      currentStopLat: args.firstStopLat,
      currentStopLng: args.firstStopLng,
      approachingFired: false,
      arrivedFired: false,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Advance the frontier to the next stop. Called from checkInAtStop for
 * stops with sequenceNumber > 1. Flags are reset so the next stop's
 * APPROACHING/ARRIVED events can fire fresh.
 */
export const advanceToNextStop = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    nextStopSeq: v.number(),
    nextStopLat: v.number(),
    nextStopLng: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await getByLoadId(ctx, args.loadId);
    if (!state) return null; // nothing to advance
    await ctx.db.patch(state._id, {
      currentStopSequenceNumber: args.nextStopSeq,
      currentStopLat: args.nextStopLat,
      currentStopLng: args.nextStopLng,
      approachingFired: false,
      arrivedFired: false,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Flip a frontier flag after the geofence evaluator fires an event.
 * Pass only the flag(s) that changed — the other stays as-is.
 */
export const patchFrontierFlags = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    approaching: v.optional(v.boolean()),
    arrived: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await getByLoadId(ctx, args.loadId);
    if (!state) return null;
    const patch: Partial<Doc<'loadTrackingState'>> = { updatedAt: Date.now() };
    if (args.approaching !== undefined) patch.approachingFired = args.approaching;
    if (args.arrived !== undefined) patch.arrivedFired = args.arrived;
    await ctx.db.patch(state._id, patch);
    return null;
  },
});

/**
 * Handoff: transfer the tracking state from one driver's session to another.
 * Preserves frontier (current stop + flags) so the relay driver resumes
 * exactly where the primary left off. Called atomically inside handoffLoad.
 */
export const transferToDriver = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    newSessionId: v.id('driverSessions'),
    newDriverId: v.id('drivers'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await getByLoadId(ctx, args.loadId);
    if (!state) return null; // handoff before any check-in — no state to transfer
    await ctx.db.patch(state._id, {
      sessionId: args.newSessionId,
      driverId: args.newDriverId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Delete the tracking state when the load completes. Called from
 * checkOutFromStop on the last stop. Historical geofence events stay in
 * the geofenceEvents table; only the frontier pointer is released.
 */
export const completeLoad = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await getByLoadId(ctx, args.loadId);
    if (state) await ctx.db.delete(state._id);
    return null;
  },
});
