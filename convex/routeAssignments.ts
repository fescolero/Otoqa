import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { assertCallerOwnsOrg, requireCallerOrgId, requireCallerIdentity } from './lib/auth';
import { logAudit } from './lib/audit';
import { matchRouteAssignment, overlappingDays, DAY_NAMES } from './lib/routeMatch';
import { assertValidAssignAheadDays } from './lib/assignHorizon';
import { assessRuleLoads, targetOf } from './routeRotation';
import { internal } from './_generated/api';

/**
 * Route Assignments - Maps recurring routes (HCR+Trip) to drivers/carriers
 * Used by the auto-assignment system to automatically assign loads
 */

/**
 * Normalize a route's service calendar before it is stored.
 *
 * "Absent = runs every day" is the ONE representation of unrestricted, so
 * a full seven-day selection is stored as absent rather than as
 * [0,1,2,3,4,5,6]. Otherwise the two would behave differently for a load
 * with no service date, which routeMatch declines for any restricted route.
 *
 * An empty array is rejected rather than silently treated as "every day" —
 * a dispatcher who deselects every day means "never", and reading that as
 * "always" is the worst possible guess.
 */
/**
 * Reject a rule that would compete with an existing one on the same
 * HCR + Trip for the same day.
 *
 * Paused rules are ignored: an inactive rule matches nothing, so it has no
 * claim to reserve. Before service days this was a flat "one rule per
 * HCR + Trip", which is why a second rule for different days was refused.
 */
async function assertNoDayCollision(
  ctx: MutationCtx,
  candidate: {
    workosOrgId: string;
    hcr: string;
    tripNumber?: string;
    activeDays?: number[];
    excludeId?: Id<'routeAssignments'>;
  },
): Promise<void> {
  const siblings = await ctx.db
    .query('routeAssignments')
    .withIndex('by_org_hcr_trip', (q) =>
      q
        .eq('workosOrgId', candidate.workosOrgId)
        .eq('hcr', candidate.hcr)
        .eq('tripNumber', candidate.tripNumber),
    )
    .collect();

  for (const sibling of siblings) {
    if (candidate.excludeId && sibling._id === candidate.excludeId) continue;
    if (!sibling.isActive) continue;

    const clash = overlappingDays(candidate, sibling);
    if (clash.length === 0) continue;

    const route = `HCR ${candidate.hcr}${candidate.tripNumber ? ` / Trip ${candidate.tripNumber}` : ''}`;
    const which = sibling.name ? `"${sibling.name}"` : 'another rule';
    throw new ConvexError(
      `${which} already covers ${route} on ${clash.map((d) => DAY_NAMES[d]).join(', ')}. ` +
        `Give the two rules different days, or pause the existing one.`,
    );
  }
}

function normalizeActiveDays(activeDays: number[] | undefined): number[] | undefined {
  if (activeDays === undefined) return undefined;
  if (activeDays.length === 0) {
    throw new ConvexError('Select at least one day, or turn off the day restriction');
  }
  const unique = [...new Set(activeDays)].sort((a, b) => a - b);
  if (unique.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new ConvexError('Days must be integers 0 (Sunday) through 6 (Saturday)');
  }
  return unique.length === 7 ? undefined : unique;
}

function validateExclusions(dates: string[] | undefined): string[] | undefined {
  if (dates === undefined) return undefined;
  for (const d of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new ConvexError(`Exclusion dates must be YYYY-MM-DD (got "${d}")`);
    }
  }
  return [...new Set(dates)].sort();
}

/** Outcome of the last rotation, as stored on the rule (routeRotation.ts). */
const lastRotationValidator = v.object({
  at: v.number(),
  considered: v.number(),
  moved: v.number(),
  held: v.number(),
  byReason: v.array(v.object({ reason: v.string(), count: v.number() })),
});

/**
 * Kick off a rotation for a rule. `previous` is the resource the rule
 * named before this edit; absent means "anything the rule owns that is
 * not on its current resource" (the explicit re-sync).
 */
async function scheduleRotation(
  ctx: MutationCtx,
  routeId: Id<'routeAssignments'>,
  previous: { driverId?: Id<'drivers'>; carrierPartnershipId?: Id<'carrierPartnerships'> } | undefined,
  actor: { userId: string; userName?: string },
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.routeRotation.runRotation, {
    routeId,
    previousDriverId: previous?.driverId,
    previousCarrierPartnershipId: previous?.carrierPartnershipId,
    userId: actor.userId,
    userName: actor.userName,
  });
}

// List all route assignments for an organization
export const list = query({
  args: {
    workosOrgId: v.string(),
    isActive: v.optional(v.boolean()),
    search: v.optional(v.string()),
  },
  returns: v.array(
    v.object({
      _id: v.id('routeAssignments'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      hcr: v.string(),
      tripNumber: v.optional(v.string()),
      driverId: v.optional(v.id('drivers')),
      carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
      priority: v.number(),
      isActive: v.boolean(),
      activeDays: v.optional(v.array(v.number())),
      excludeFederalHolidays: v.optional(v.boolean()),
      customExclusions: v.optional(v.array(v.string())),
      name: v.optional(v.string()),
      notes: v.optional(v.string()),
      createdBy: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
      lastRotation: v.optional(lastRotationValidator),
      // Enriched data
      driverName: v.optional(v.string()),
      carrierName: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    let assignments = await ctx.db
      .query('routeAssignments')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    // Filter by active status if specified
    if (args.isActive !== undefined) {
      assignments = assignments.filter((a) => a.isActive === args.isActive);
    }

    // Search filter
    if (args.search) {
      const searchLower = args.search.toLowerCase();
      assignments = assignments.filter(
        (a) =>
          a.hcr.toLowerCase().includes(searchLower) ||
          a.tripNumber?.toLowerCase().includes(searchLower) ||
          a.name?.toLowerCase().includes(searchLower)
      );
    }

    // Enrich with driver/carrier names
    const enriched = await Promise.all(
      assignments.map(async (assignment) => {
        let driverName: string | undefined;
        let carrierName: string | undefined;

        if (assignment.driverId) {
          const driver = await ctx.db.get(assignment.driverId);
          if (driver) {
            driverName = `${driver.firstName} ${driver.lastName}`;
          }
        }

        if (assignment.carrierPartnershipId) {
          const carrier = await ctx.db.get(assignment.carrierPartnershipId);
          if (carrier) {
            carrierName = carrier.carrierName;
          }
        }

        return {
          ...assignment,
          driverName,
          carrierName,
        };
      })
    );

    // Sort by priority (lower = higher priority)
    return enriched.sort((a, b) => a.priority - b.priority);
  },
});

// Get a single route assignment by ID
export const get = query({
  args: {
    id: v.id('routeAssignments'),
  },
  returns: v.union(
    v.object({
      _id: v.id('routeAssignments'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      hcr: v.string(),
      tripNumber: v.optional(v.string()),
      driverId: v.optional(v.id('drivers')),
      carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
      priority: v.number(),
      isActive: v.boolean(),
      activeDays: v.optional(v.array(v.number())),
      excludeFederalHolidays: v.optional(v.boolean()),
      customExclusions: v.optional(v.array(v.string())),
      name: v.optional(v.string()),
      notes: v.optional(v.string()),
      createdBy: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
      lastRotation: v.optional(lastRotationValidator),
      driverName: v.optional(v.string()),
      carrierName: v.optional(v.string()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);

    const assignment = await ctx.db.get(args.id);
    if (!assignment) return null;
    if (assignment.workosOrgId !== callerOrgId) return null;

    let driverName: string | undefined;
    let carrierName: string | undefined;

    if (assignment.driverId) {
      const driver = await ctx.db.get(assignment.driverId);
      if (driver) {
        driverName = `${driver.firstName} ${driver.lastName}`;
      }
    }

    if (assignment.carrierPartnershipId) {
      const carrier = await ctx.db.get(assignment.carrierPartnershipId);
      if (carrier) {
        carrierName = carrier.carrierName;
      }
    }

    return {
      ...assignment,
      driverName,
      carrierName,
    };
  },
});

// Find assignment for a specific HCR + Trip (used by auto-assignment)
export const getByRoute = query({
  args: {
    workosOrgId: v.string(),
    hcr: v.string(),
    tripNumber: v.optional(v.string()),
    // Business-local YYYY-MM-DD. Omit to ignore route service calendars.
    serviceDate: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      _id: v.id('routeAssignments'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      hcr: v.string(),
      tripNumber: v.optional(v.string()),
      driverId: v.optional(v.id('drivers')),
      carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
      priority: v.number(),
      isActive: v.boolean(),
      activeDays: v.optional(v.array(v.number())),
      excludeFederalHolidays: v.optional(v.boolean()),
      customExclusions: v.optional(v.array(v.string())),
      name: v.optional(v.string()),
      notes: v.optional(v.string()),
      lastRotation: v.optional(lastRotationValidator),
      createdBy: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    // Shared matcher (lib/routeMatch.ts). This query previously implemented
    // only the first two tiers, so the UI's preview disagreed with what the
    // assignment engine would actually pick.
    const match = await matchRouteAssignment(ctx, {
      workosOrgId: args.workosOrgId,
      hcr: args.hcr,
      trip: args.tripNumber,
      serviceDate: args.serviceDate,
    });
    return match.route;
  },
});

// List routes assigned to a specific driver
export const getByDriver = query({
  args: {
    driverId: v.id('drivers'),
  },
  returns: v.array(
    v.object({
      _id: v.id('routeAssignments'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      hcr: v.string(),
      tripNumber: v.optional(v.string()),
      driverId: v.optional(v.id('drivers')),
      carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
      priority: v.number(),
      isActive: v.boolean(),
      activeDays: v.optional(v.array(v.number())),
      excludeFederalHolidays: v.optional(v.boolean()),
      customExclusions: v.optional(v.array(v.string())),
      name: v.optional(v.string()),
      notes: v.optional(v.string()),
      lastRotation: v.optional(lastRotationValidator),
      createdBy: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);

    const assignments = await ctx.db
      .query('routeAssignments')
      .withIndex('by_driver', (q) => q.eq('driverId', args.driverId))
      .collect();

    return assignments.filter((a) => a.workosOrgId === callerOrgId);
  },
});

// List routes assigned to a specific carrier
export const getByCarrier = query({
  args: {
    carrierPartnershipId: v.id('carrierPartnerships'),
  },
  returns: v.array(
    v.object({
      _id: v.id('routeAssignments'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      hcr: v.string(),
      tripNumber: v.optional(v.string()),
      driverId: v.optional(v.id('drivers')),
      carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
      priority: v.number(),
      isActive: v.boolean(),
      activeDays: v.optional(v.array(v.number())),
      excludeFederalHolidays: v.optional(v.boolean()),
      customExclusions: v.optional(v.array(v.string())),
      name: v.optional(v.string()),
      notes: v.optional(v.string()),
      lastRotation: v.optional(lastRotationValidator),
      createdBy: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);

    const assignments = await ctx.db
      .query('routeAssignments')
      .withIndex('by_carrier', (q) => q.eq('carrierPartnershipId', args.carrierPartnershipId))
      .collect();

    return assignments.filter((a) => a.workosOrgId === callerOrgId);
  },
});

// Create a new route assignment
export const create = mutation({
  args: {
    workosOrgId: v.string(),
    hcr: v.string(),
    tripNumber: v.optional(v.string()),
    driverId: v.optional(v.id('drivers')),
    carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
    priority: v.optional(v.number()),
    // Service calendar — see lib/routeMatch.ts. Omit for "runs every day".
    activeDays: v.optional(v.array(v.number())),
    excludeFederalHolidays: v.optional(v.boolean()),
    customExclusions: v.optional(v.array(v.string())),
    name: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdBy: v.string(),
  },
  returns: v.id('routeAssignments'),
  handler: async (ctx, args) => {
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);

    // Validate that either driver or carrier is set (not both, not neither)
    if (!args.driverId && !args.carrierPartnershipId) {
      throw new ConvexError('Either driverId or carrierPartnershipId must be provided');
    }
    if (args.driverId && args.carrierPartnershipId) {
      throw new ConvexError('Cannot assign to both driver and carrier');
    }

    // Validate driver exists and is active
    if (args.driverId) {
      const driver = await ctx.db.get(args.driverId);
      if (!driver) {
        throw new ConvexError('Driver not found');
      }
      if (driver.isDeleted) {
        throw new ConvexError('Cannot assign to deleted driver');
      }
      if (driver.employmentStatus !== 'Active') {
        throw new ConvexError('Cannot assign to inactive driver');
      }
    }

    // Validate carrier exists and is active
    if (args.carrierPartnershipId) {
      const carrier = await ctx.db.get(args.carrierPartnershipId);
      if (!carrier) {
        throw new ConvexError('Carrier partnership not found');
      }
      if (carrier.status !== 'ACTIVE') {
        throw new ConvexError('Cannot assign to inactive carrier');
      }
    }

    // Two rules may share an HCR + Trip as long as they never claim the
    // same day — "Dana runs Mon/Wed/Fri, Sam runs Tue/Thu" is the whole
    // point of service days. Only a genuine day collision is rejected,
    // because then which rule wins depends on priority and nobody reading
    // the list would be able to tell.
    await assertNoDayCollision(ctx, {
      workosOrgId: args.workosOrgId,
      hcr: args.hcr,
      tripNumber: args.tripNumber,
      activeDays: normalizeActiveDays(args.activeDays),
    });

    const now = Date.now();

    const assignmentId = await ctx.db.insert('routeAssignments', {
      workosOrgId: args.workosOrgId,
      hcr: args.hcr,
      tripNumber: args.tripNumber,
      driverId: args.driverId,
      carrierPartnershipId: args.carrierPartnershipId,
      priority: args.priority ?? 100, // Default priority
      isActive: true,
      activeDays: normalizeActiveDays(args.activeDays),
      excludeFederalHolidays: args.excludeFederalHolidays || undefined,
      customExclusions: validateExclusions(args.customExclusions)?.length
        ? validateExclusions(args.customExclusions)
        : undefined,
      name: args.name,
      notes: args.notes,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: args.workosOrgId,
      entityType: 'routeAssignment',
      entityId: assignmentId,
      entityName: args.name,
      action: 'created',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Created route assignment for HCR ${args.hcr}${args.tripNumber ? ` / Trip ${args.tripNumber}` : ''}`,
    });

    return assignmentId;
  },
});

// Update an existing route assignment
export const update = mutation({
  args: {
    id: v.id('routeAssignments'),
    hcr: v.optional(v.string()),
    tripNumber: v.optional(v.string()),
    driverId: v.optional(v.id('drivers')),
    carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
    priority: v.optional(v.number()),
    // Service calendar. Send all seven days (or an empty exclusion list) to
    // clear a restriction; normalizeActiveDays stores that as absent.
    activeDays: v.optional(v.array(v.number())),
    excludeFederalHolidays: v.optional(v.boolean()),
    customExclusions: v.optional(v.array(v.string())),
    name: v.optional(v.string()),
    notes: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
    // Driver rotation. When the driver/carrier changes, also move the
    // upcoming loads this rule already auto-assigned onto the new one
    // (routeRotation.ts). Off by default: editing a rule never silently
    // re-dispatches anything.
    reassignFutureLoads: v.optional(v.boolean()),
  },
  returns: v.id('routeAssignments'),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const { id, reassignFutureLoads, ...updates } = args;

    const existing = await ctx.db.get(id);
    if (!existing) {
      throw new ConvexError('Route assignment not found');
    }
    if (existing.workosOrgId !== callerOrgId) {
      throw new ConvexError('Not authorized for this organization');
    }

    // Validate driver if being updated
    if (updates.driverId) {
      const driver = await ctx.db.get(updates.driverId);
      if (!driver) {
        throw new ConvexError('Driver not found');
      }
      if (driver.isDeleted) {
        throw new ConvexError('Cannot assign to deleted driver');
      }
    }

    // Validate carrier if being updated
    if (updates.carrierPartnershipId) {
      const carrier = await ctx.db.get(updates.carrierPartnershipId);
      if (!carrier) {
        throw new ConvexError('Carrier partnership not found');
      }
    }

    // Build update object, only including defined values
    const updateData: Record<string, unknown> = {
      updatedAt: Date.now(),
    };

    if (updates.hcr !== undefined) updateData.hcr = updates.hcr;
    if (updates.tripNumber !== undefined) updateData.tripNumber = updates.tripNumber;
    if (updates.driverId !== undefined) {
      updateData.driverId = updates.driverId;
      updateData.carrierPartnershipId = undefined; // Clear carrier if assigning driver
    }
    if (updates.carrierPartnershipId !== undefined) {
      updateData.carrierPartnershipId = updates.carrierPartnershipId;
      updateData.driverId = undefined; // Clear driver if assigning carrier
    }
    if (updates.priority !== undefined) updateData.priority = updates.priority;
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.notes !== undefined) updateData.notes = updates.notes;
    if (updates.isActive !== undefined) updateData.isActive = updates.isActive;

    // Calendar fields normalize to `undefined` when unrestricted, and
    // patching a key to undefined removes it — which is exactly the
    // "clear the restriction" path.
    if (updates.activeDays !== undefined) {
      updateData.activeDays = normalizeActiveDays(updates.activeDays);
    }
    if (updates.excludeFederalHolidays !== undefined) {
      updateData.excludeFederalHolidays = updates.excludeFederalHolidays || undefined;
    }
    if (updates.customExclusions !== undefined) {
      const cleaned = validateExclusions(updates.customExclusions);
      updateData.customExclusions = cleaned && cleaned.length > 0 ? cleaned : undefined;
    }

    // `update` never had the duplicate check `create` did, so a collision
    // could always be produced by editing rather than creating. Now that
    // rules legitimately share an HCR + Trip across different days, the
    // check matters on both paths — against the values AFTER this edit.
    await assertNoDayCollision(ctx, {
      workosOrgId: existing.workosOrgId,
      hcr: (updateData.hcr as string | undefined) ?? existing.hcr,
      tripNumber:
        'tripNumber' in updateData
          ? (updateData.tripNumber as string | undefined)
          : existing.tripNumber,
      activeDays:
        'activeDays' in updateData
          ? (updateData.activeDays as number[] | undefined)
          : existing.activeDays,
      excludeId: id,
    });

    await ctx.db.patch(id, updateData);

    const changedFields = Object.keys(updateData).filter((key) => key !== 'updatedAt');
    if (changedFields.length > 0) {
      await logAudit(ctx, {
        organizationId: existing.workosOrgId,
        entityType: 'routeAssignment',
        entityId: id,
        entityName: existing.name,
        action: 'updated',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description: `Updated route assignment for HCR ${existing.hcr}${existing.tripNumber ? ` / Trip ${existing.tripNumber}` : ''}`,
        changedFields,
        changesAfter: JSON.stringify(updateData),
      });
    }

    // Rotation: only when the resource actually changed and the caller
    // asked. The previous resource is captured from the pre-edit row so
    // loads a person had already moved elsewhere are left alone.
    const resourceChanged =
      ('driverId' in updateData && updateData.driverId !== existing.driverId) ||
      ('carrierPartnershipId' in updateData &&
        updateData.carrierPartnershipId !== existing.carrierPartnershipId);
    if (reassignFutureLoads && resourceChanged) {
      await scheduleRotation(ctx, id, targetOf(existing), { userId, userName });
    }

    return id;
  },
});

/**
 * What a rotation would do right now, for the edit modal's confirmation.
 * Evaluated against the PROPOSED resource, before the edit is saved.
 */
export const previewRotation = query({
  args: {
    id: v.id('routeAssignments'),
    driverId: v.optional(v.id('drivers')),
    carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
  },
  returns: v.object({
    eligible: v.number(),
    held: v.number(),
    byReason: v.array(v.object({ reason: v.string(), count: v.number() })),
  }),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const rule = await ctx.db.get(args.id);
    if (!rule || rule.workosOrgId !== callerOrgId) {
      throw new ConvexError('Route assignment not found');
    }

    const proposed = targetOf({
      driverId: args.driverId,
      carrierPartnershipId: args.carrierPartnershipId,
    });
    const target = proposed.driverId || proposed.carrierPartnershipId ? proposed : targetOf(rule);
    // Previewing the current resource is the explicit re-sync case: no
    // "previous" constraint, just "not already on target".
    const previous =
      target.driverId === rule.driverId && target.carrierPartnershipId === rule.carrierPartnershipId
        ? undefined
        : targetOf(rule);

    const assessed = await assessRuleLoads(ctx, rule, target, previous);
    const byReason = new Map<string, number>();
    let eligible = 0;
    for (const a of assessed) {
      if (a.verdict.eligible) eligible++;
      else byReason.set(a.verdict.reason, (byReason.get(a.verdict.reason) ?? 0) + 1);
    }
    return {
      eligible,
      held: assessed.length - eligible,
      byReason: [...byReason.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    };
  },
});

/**
 * Re-sync: move every upcoming load this rule owns onto its current
 * resource. The retry path when a scheduled rotation was interrupted, and
 * the fix when the resource was changed earlier without one.
 */
export const rotateLoads = mutation({
  args: { id: v.id('routeAssignments') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const rule = await ctx.db.get(args.id);
    if (!rule) throw new ConvexError('Route assignment not found');
    if (rule.workosOrgId !== callerOrgId) throw new ConvexError('Not authorized for this organization');
    if (!rule.driverId && !rule.carrierPartnershipId) {
      throw new ConvexError('Route assignment has no driver or carrier to move loads to');
    }

    await logAudit(ctx, {
      organizationId: rule.workosOrgId,
      entityType: 'routeAssignment',
      entityId: args.id,
      entityName: rule.name,
      action: 'auto_assign_rotated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Requested re-sync of upcoming loads for HCR ${rule.hcr}${rule.tripNumber ? ` / Trip ${rule.tripNumber}` : ''}`,
    });

    await scheduleRotation(ctx, args.id, undefined, { userId, userName });
    return null;
  },
});

// Toggle active status
export const toggleActive = mutation({
  args: {
    id: v.id('routeAssignments'),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const assignment = await ctx.db.get(args.id);
    if (!assignment) {
      throw new ConvexError('Route assignment not found');
    }
    if (assignment.workosOrgId !== callerOrgId) {
      throw new ConvexError('Not authorized for this organization');
    }

    const newStatus = !assignment.isActive;

    await ctx.db.patch(args.id, {
      isActive: newStatus,
      updatedAt: Date.now(),
    });

    await logAudit(ctx, {
      organizationId: assignment.workosOrgId,
      entityType: 'routeAssignment',
      entityId: args.id,
      entityName: assignment.name,
      action: newStatus ? 'reactivated' : 'deactivated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `${newStatus ? 'Activated' : 'Deactivated'} route assignment for HCR ${assignment.hcr}${assignment.tripNumber ? ` / Trip ${assignment.tripNumber}` : ''}`,
    });

    return newStatus;
  },
});

// Delete a route assignment (hard delete)
export const remove = mutation({
  args: {
    id: v.id('routeAssignments'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const assignment = await ctx.db.get(args.id);
    if (!assignment) {
      throw new ConvexError('Route assignment not found');
    }
    if (assignment.workosOrgId !== callerOrgId) {
      throw new ConvexError('Not authorized for this organization');
    }

    await ctx.db.delete(args.id);

    await logAudit(ctx, {
      organizationId: assignment.workosOrgId,
      entityType: 'routeAssignment',
      entityId: args.id,
      entityName: assignment.name,
      action: 'deleted',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Deleted route assignment for HCR ${assignment.hcr}${assignment.tripNumber ? ` / Trip ${assignment.tripNumber}` : ''}`,
      changesBefore: JSON.stringify(assignment),
    });

    return null;
  },
});

// Get/create auto-assignment settings for an organization
export const getSettings = query({
  args: {
    workosOrgId: v.string(),
  },
  returns: v.union(
    v.object({
      _id: v.id('autoAssignmentSettings'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      enabled: v.boolean(),
      triggerOnCreate: v.boolean(),
      scheduledEnabled: v.boolean(),
      scheduleIntervalMinutes: v.optional(v.number()),
      lastScheduledRunAt: v.optional(v.number()),
      assignAheadDays: v.optional(v.number()),
      lastRun: v.optional(
        v.object({
          at: v.number(),
          processed: v.number(),
          assigned: v.number(),
          skipped: v.number(),
          errors: v.number(),
          byAction: v.array(v.object({ action: v.string(), count: v.number() })),
        }),
      ),
      updatedBy: v.string(),
      updatedAt: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    return await ctx.db
      .query('autoAssignmentSettings')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();
  },
});

// Update auto-assignment settings
export const updateSettings = mutation({
  args: {
    workosOrgId: v.string(),
    enabled: v.optional(v.boolean()),
    triggerOnCreate: v.optional(v.boolean()),
    scheduledEnabled: v.optional(v.boolean()),
    scheduleIntervalMinutes: v.optional(v.number()),
    // Assignment horizon in days; null clears it (undefined = leave as is,
    // like every other field here — see spec R4).
    assignAheadDays: v.optional(v.union(v.number(), v.null())),
    updatedBy: v.string(),
  },
  returns: v.id('autoAssignmentSettings'),
  handler: async (ctx, args) => {
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const existing = await ctx.db
      .query('autoAssignmentSettings')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();

    const now = Date.now();

    if (typeof args.assignAheadDays === 'number') {
      try {
        assertValidAssignAheadDays(args.assignAheadDays);
      } catch (e) {
        throw new ConvexError(e instanceof Error ? e.message : String(e));
      }
    }

    // A horizon defers loads for the sweep to pick up later. With no
    // sweep there is no later: a load imported beyond the horizon would
    // never be assigned and would expire Open (spec R1/R2). Refuse the
    // combination rather than let it fail silently.
    const nextScheduled = args.scheduledEnabled ?? existing?.scheduledEnabled ?? false;
    const nextHorizon =
      args.assignAheadDays === undefined ? existing?.assignAheadDays : args.assignAheadDays;
    if (typeof nextHorizon === 'number' && !nextScheduled) {
      throw new ConvexError(
        'An assignment horizon needs Scheduled Processing turned on — the scheduled run is what assigns deferred loads once they come due.',
      );
    }

    let settingsId;
    if (existing) {
      // Update existing
      const updateData: Record<string, unknown> = {
        updatedBy: userId,
        updatedAt: now,
      };

      if (args.enabled !== undefined) updateData.enabled = args.enabled;
      if (args.triggerOnCreate !== undefined) updateData.triggerOnCreate = args.triggerOnCreate;
      if (args.scheduledEnabled !== undefined) updateData.scheduledEnabled = args.scheduledEnabled;
      if (args.scheduleIntervalMinutes !== undefined)
        updateData.scheduleIntervalMinutes = args.scheduleIntervalMinutes;
      // null → patch to undefined, which removes the field.
      if (args.assignAheadDays !== undefined)
        updateData.assignAheadDays = args.assignAheadDays ?? undefined;

      await ctx.db.patch(existing._id, updateData);
      settingsId = existing._id;
    } else {
      // Create new with defaults
      settingsId = await ctx.db.insert('autoAssignmentSettings', {
        workosOrgId: args.workosOrgId,
        enabled: args.enabled ?? false,
        triggerOnCreate: args.triggerOnCreate ?? false,
        scheduledEnabled: args.scheduledEnabled ?? false,
        scheduleIntervalMinutes: args.scheduleIntervalMinutes,
        assignAheadDays: args.assignAheadDays ?? undefined,
        updatedBy: userId,
        updatedAt: now,
      });
    }

    await logAudit(ctx, {
      organizationId: args.workosOrgId,
      entityType: 'routeAssignment',
      entityId: settingsId,
      action: 'updated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: 'Updated route assignment settings',
    });

    return settingsId;
  },
});
