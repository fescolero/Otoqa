import { ConvexError, v } from 'convex/values';
import { query, mutation } from './_generated/server';
import { requireCallerOrgId, requireCallerIdentity, assertOrgPermission } from './lib/auth';
import { resolveAuthenticatedDriver } from './driverMobile';
import { YARD_DEFAULT_RADIUS_METERS, exitRadiusFor } from './lib/geo';

/**
 * Org yard / parking locations — the carrier's own places (vs `facilities`,
 * which are customer shipper/receiver sites). Anchor session-level geofence
 * triggers (convex/yardGeofence.ts) and render as rings on the Active
 * Sessions map. Managed from Settings → Yards & parking.
 */

const locationTypeValidator = v.union(v.literal('YARD'), v.literal('PARKING'));

const yardValidator = v.object({
  _id: v.id('yardLocations'),
  name: v.string(),
  locationType: locationTypeValidator,
  addressLine1: v.union(v.string(), v.null()),
  city: v.union(v.string(), v.null()),
  state: v.union(v.string(), v.null()),
  latitude: v.number(),
  longitude: v.number(),
  radiusMeters: v.number(), // effective (default applied)
  exitRadiusMeters: v.number(),
  notes: v.union(v.string(), v.null()),
  updatedAt: v.number(),
});

/**
 * The fence radius actually in force: the row's override when set, else the
 * default. Every projection and the evaluator must agree on this — note that
 * `exitRadiusFor(undefined)` returns the load-stop departure ring (1207 m),
 * NOT 1.5× the yard default, so the default has to be applied BEFORE the
 * exit ring is derived from it.
 */
// Driver-app projection: the fence, and nothing that isn't the fence.
const yardFenceValidator = v.object({
  _id: v.id('yardLocations'),
  name: v.string(),
  latitude: v.number(),
  longitude: v.number(),
  radiusMeters: v.number(), // effective (default applied)
  exitRadiusMeters: v.number(), // 1.5x the effective radius
});

function effectiveRadiusMeters(radiusMeters?: number): number {
  return radiusMeters && radiusMeters > 0 ? radiusMeters : YARD_DEFAULT_RADIUS_METERS;
}

function toClientYard(yard: {
  _id: import('./_generated/dataModel').Id<'yardLocations'>;
  name: string;
  locationType: 'YARD' | 'PARKING';
  addressLine1?: string;
  city?: string;
  state?: string;
  latitude: number;
  longitude: number;
  radiusMeters?: number;
  notes?: string;
  updatedAt: number;
}) {
  const radius = effectiveRadiusMeters(yard.radiusMeters);
  return {
    _id: yard._id,
    name: yard.name,
    locationType: yard.locationType,
    addressLine1: yard.addressLine1 ?? null,
    city: yard.city ?? null,
    state: yard.state ?? null,
    latitude: yard.latitude,
    longitude: yard.longitude,
    radiusMeters: radius,
    exitRadiusMeters: exitRadiusFor(radius),
    notes: yard.notes ?? null,
    updatedAt: yard.updatedAt,
  };
}

/** All active yards for the caller's org (settings list + map layer). */
export const list = query({
  args: {},
  returns: v.array(yardValidator),
  handler: async (ctx) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const yards = await ctx.db
      .query('yardLocations')
      .withIndex('by_org', (q) => q.eq('workosOrgId', callerOrgId).eq('isDeleted', false))
      .collect();
    return yards.map(toClientYard);
  },
});

/**
 * Fence-only projection for the driver app (docs/end-shift-reminder-spec.md).
 *
 * Separate from `list` for two reasons. Auth: `list` goes through
 * `requireCallerOrgId`, the WorkOS org-claim path, and drivers authenticate
 * by Clerk phone claim — a driver calling `list` gets "No organization claim
 * on identity". Payload: a phone caching this for offline use needs the
 * fence and nothing else, so addresses, notes and audit fields stay on the
 * dispatcher side.
 *
 * Both radii are resolved server-side so the device can't re-derive them
 * wrongly, and the 100-row ceiling matches `evaluateYards` exactly — if an
 * org ever exceeds it, both sides must fall off the same edge, or the device
 * would watch a fence the server doesn't (or vice versa).
 */
export const listForDriver = query({
  args: {},
  returns: v.array(yardFenceValidator),
  handler: async (ctx) => {
    const driver = await resolveAuthenticatedDriver(ctx);
    const yards = await ctx.db
      .query('yardLocations')
      .withIndex('by_org', (q) =>
        q.eq('workosOrgId', driver.organizationId).eq('isDeleted', false),
      )
      .take(100);

    return yards.map((yard) => {
      const radius = effectiveRadiusMeters(yard.radiusMeters);
      return {
        _id: yard._id,
        name: yard.name,
        latitude: yard.latitude,
        longitude: yard.longitude,
        radiusMeters: radius,
        exitRadiusMeters: exitRadiusFor(radius),
      };
    });
  },
});

function validateFence(args: { latitude: number; longitude: number; radiusMeters?: number }) {
  if (!Number.isFinite(args.latitude) || Math.abs(args.latitude) > 90) {
    throw new ConvexError('Latitude must be between -90 and 90');
  }
  if (!Number.isFinite(args.longitude) || Math.abs(args.longitude) > 180) {
    throw new ConvexError('Longitude must be between -180 and 180');
  }
  if (
    args.radiusMeters !== undefined &&
    (!Number.isFinite(args.radiusMeters) || args.radiusMeters < 50 || args.radiusMeters > 5000)
  ) {
    throw new ConvexError('Radius must be between 50 and 5000 meters');
  }
}

export const create = mutation({
  args: {
    name: v.string(),
    locationType: locationTypeValidator,
    addressLine1: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    latitude: v.number(),
    longitude: v.number(),
    radiusMeters: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  returns: v.id('yardLocations'),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await requireCallerIdentity(ctx);
    await assertOrgPermission(ctx, callerOrgId, 'settings:edit');
    if (!args.name.trim()) throw new ConvexError('Name is required');
    validateFence(args);

    const now = Date.now();
    return await ctx.db.insert('yardLocations', {
      workosOrgId: callerOrgId,
      name: args.name.trim(),
      locationType: args.locationType,
      addressLine1: args.addressLine1,
      city: args.city,
      state: args.state,
      latitude: args.latitude,
      longitude: args.longitude,
      radiusMeters: args.radiusMeters,
      notes: args.notes,
      isDeleted: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    yardId: v.id('yardLocations'),
    name: v.optional(v.string()),
    locationType: v.optional(locationTypeValidator),
    addressLine1: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    radiusMeters: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId } = await requireCallerIdentity(ctx);
    await assertOrgPermission(ctx, callerOrgId, 'settings:edit');
    const yard = await ctx.db.get(args.yardId);
    if (!yard || yard.isDeleted || yard.workosOrgId !== callerOrgId) {
      throw new ConvexError('Yard not found');
    }
    if (args.name !== undefined && !args.name.trim()) throw new ConvexError('Name is required');
    validateFence({
      latitude: args.latitude ?? yard.latitude,
      longitude: args.longitude ?? yard.longitude,
      radiusMeters: args.radiusMeters,
    });

    const { yardId, ...updates } = args;
    await ctx.db.patch(yardId, {
      ...updates,
      ...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const softDelete = mutation({
  args: { yardId: v.id('yardLocations') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId } = await requireCallerIdentity(ctx);
    await assertOrgPermission(ctx, callerOrgId, 'settings:edit');
    const yard = await ctx.db.get(args.yardId);
    if (!yard || yard.workosOrgId !== callerOrgId) throw new ConvexError('Yard not found');
    await ctx.db.patch(args.yardId, { isDeleted: true, updatedAt: Date.now() });
    return null;
  },
});
