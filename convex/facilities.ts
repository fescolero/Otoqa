/**
 * Facilities — customer-scoped registry of verified stop locations.
 *
 * Manual-only by design: rows are created and edited from the customer
 * detail page's Locations tab, never by imports. Imports LINK load stops
 * to facilities (loadStops.facilityId); a VERIFIED facility's pin is
 * authoritative for stop coordinates and check-in geofencing.
 *
 * See docs/fourkites-address-quality-plan.md §5.
 */
import { v } from 'convex/values';
import { mutation, query, MutationCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import { requireCallerOrgId, requireCallerIdentity } from './lib/auth';
import { logAudit } from './lib/audit';

const verificationStateValidator = v.union(
  v.literal('UNVERIFIED'),
  v.literal('VERIFIED'),
);

async function requireOwnedFacility(
  ctx: MutationCtx,
  facilityId: Id<'facilities'>,
  callerOrgId: string,
): Promise<Doc<'facilities'>> {
  const facility = await ctx.db.get(facilityId);
  if (!facility || facility.workosOrgId !== callerOrgId || facility.isDeleted) {
    throw new Error('Facility not found');
  }
  return facility;
}

/**
 * Propagate a facility's pin to stops that still lie ahead of a driver.
 *
 * Import-time snapping alone leaves stale coordinates on already-imported
 * future stops when a user later moves or verifies the pin. Scope is
 * deliberately narrow: linked stops that are still Pending and not checked
 * in, on loads that are Open or Assigned. Completed stops are historical
 * records feeding pay and are never touched.
 */
async function backfillPinToPendingStops(
  ctx: MutationCtx,
  facility: Doc<'facilities'>,
): Promise<number> {
  const linkedStops = await ctx.db
    .query('loadStops')
    .withIndex('by_facility', (q) => q.eq('facilityId', facility._id))
    .collect();

  let updated = 0;
  for (const stop of linkedStops) {
    if (stop.checkedInAt || (stop.status && stop.status !== 'Pending')) continue;
    const load = await ctx.db.get(stop.loadId);
    if (!load || (load.status !== 'Open' && load.status !== 'Assigned')) continue;
    await ctx.db.patch(stop._id, {
      latitude: facility.latitude,
      longitude: facility.longitude,
      updatedAt: Date.now(),
    });
    updated++;
  }
  return updated;
}

export const listByCustomer = query({
  args: {
    customerId: v.id('customers'),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.workosOrgId !== callerOrgId) return [];
    return await ctx.db
      .query('facilities')
      .withIndex('by_customer', (q) =>
        q.eq('customerId', args.customerId).eq('isDeleted', false),
      )
      .collect();
  },
});

export const create = mutation({
  args: {
    customerId: v.id('customers'),
    name: v.string(),
    externalCode: v.optional(v.string()),
    addressLine1: v.optional(v.string()),
    city: v.string(),
    state: v.string(),
    postalCode: v.optional(v.string()),
    latitude: v.number(),
    longitude: v.number(),
    radiusMeters: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.workosOrgId !== callerOrgId) {
      throw new Error('Customer not found');
    }

    const now = Date.now();
    const facilityId = await ctx.db.insert('facilities', {
      workosOrgId: callerOrgId,
      customerId: args.customerId,
      name: args.name,
      externalCode: args.externalCode,
      addressLine1: args.addressLine1,
      city: args.city,
      state: args.state,
      postalCode: args.postalCode,
      latitude: args.latitude,
      longitude: args.longitude,
      radiusMeters: args.radiusMeters,
      verificationState: 'UNVERIFIED',
      notes: args.notes,
      isDeleted: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: callerOrgId,
      entityType: 'facility',
      entityId: facilityId,
      entityName: args.name,
      action: 'created',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Created facility ${args.name} (${args.city}, ${args.state})`,
    });

    return facilityId;
  },
});

export const update = mutation({
  args: {
    facilityId: v.id('facilities'),
    name: v.optional(v.string()),
    externalCode: v.optional(v.string()),
    addressLine1: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    postalCode: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    radiusMeters: v.optional(v.number()),
    verificationState: v.optional(verificationStateValidator),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const facility = await requireOwnedFacility(ctx, args.facilityId, callerOrgId);

    const { facilityId, verificationState, ...fields } = args;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) patch[key] = value;
    }

    if (verificationState !== undefined && verificationState !== facility.verificationState) {
      patch.verificationState = verificationState;
      if (verificationState === 'VERIFIED') {
        patch.verifiedBy = userId;
        patch.verifiedAt = Date.now();
        // Verification clears any Phase 3 demotion flag.
        patch.needsReview = false;
      }
    }

    await ctx.db.patch(facility._id, patch);
    const after = (await ctx.db.get(facility._id))!;

    // Pin moved, or facility just became VERIFIED (its pin is now
    // authoritative either way): push it to still-pending linked stops.
    const pinChanged =
      after.latitude !== facility.latitude || after.longitude !== facility.longitude;
    const becameVerified =
      facility.verificationState !== 'VERIFIED' && after.verificationState === 'VERIFIED';
    let backfilled = 0;
    if (pinChanged || becameVerified) {
      backfilled = await backfillPinToPendingStops(ctx, after);
    }

    await logAudit(ctx, {
      organizationId: callerOrgId,
      entityType: 'facility',
      entityId: facility._id,
      entityName: after.name,
      action: becameVerified ? 'status_changed' : 'updated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: becameVerified
        ? `Verified facility ${after.name}${backfilled ? ` (pin pushed to ${backfilled} pending stop${backfilled === 1 ? '' : 's'})` : ''}`
        : `Updated facility ${after.name}${backfilled ? ` (pin pushed to ${backfilled} pending stop${backfilled === 1 ? '' : 's'})` : ''}`,
      changesBefore: JSON.stringify({
        latitude: facility.latitude,
        longitude: facility.longitude,
        verificationState: facility.verificationState,
      }),
    });

    return { backfilled };
  },
});

export const remove = mutation({
  args: {
    facilityId: v.id('facilities'),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const facility = await requireOwnedFacility(ctx, args.facilityId, callerOrgId);

    // Soft delete. Historical stops keep their facilityId (records stay
    // intact); future imports simply stop matching this facility.
    await ctx.db.patch(facility._id, { isDeleted: true, updatedAt: Date.now() });

    await logAudit(ctx, {
      organizationId: callerOrgId,
      entityType: 'facility',
      entityId: facility._id,
      entityName: facility.name,
      action: 'deleted',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Removed facility ${facility.name}`,
    });
  },
});
