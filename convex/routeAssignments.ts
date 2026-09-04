import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { assertCallerOwnsOrg, requireCallerOrgId, requireCallerIdentity } from './lib/auth';
import { logAudit } from './lib/audit';
import { matchRouteAssignment, overlappingDays, effectiveRangesOverlap, DAY_NAMES } from './lib/routeMatch';
import { assertValidAssignAheadDays, shiftServiceDate } from './lib/assignHorizon';
import type { Doc } from './_generated/dataModel';
import { assessRuleLoads } from './routeRotation';
import { unassignLoadResources } from './dispatchLegs';
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
    effectiveFrom?: string;
    effectiveUntil?: string;
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
    // A planned rotation: the outgoing rule ends the day before the
    // incoming one starts. Same days, never the same date — no clash.
    if (!effectiveRangesOverlap(candidate, sibling)) continue;

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

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function validateDate(label: string, d: string | null | undefined): string | undefined {
  if (d === undefined || d === null || d === '') return undefined;
  if (!YMD.test(d)) throw new ConvexError(`${label} must be YYYY-MM-DD (got "${d}")`);
  return d;
}

function assertEffectiveRange(from: string | undefined, until: string | undefined): void {
  if (from !== undefined && until !== undefined && from > until) {
    throw new ConvexError('"Active from" must be on or before "Active until"');
  }
}

function formatDays(days: number[] | undefined): string {
  if (!days || days.length === 0 || days.length === 7) return 'every day';
  return days.map((d) => DAY_NAMES[d]).join('/');
}

/**
 * Describe an edit in the words a dispatcher would use, for the audit
 * trail: "Driver: Dana Rae → Sam Rae · Days: Mon/Wed/Fri → every day".
 * The rule's history is read back from these descriptions, so they carry
 * the before AND after of every field that changed.
 */
async function describeChanges(
  ctx: MutationCtx,
  before: Doc<'routeAssignments'>,
  after: Record<string, unknown>,
): Promise<string> {
  const parts: string[] = [];
  const driverName = async (id: Id<'drivers'> | undefined) => {
    if (!id) return 'none';
    const d = await ctx.db.get(id);
    return d ? `${d.firstName} ${d.lastName}` : 'unknown driver';
  };
  const carrierName = async (id: Id<'carrierPartnerships'> | undefined) => {
    if (!id) return 'none';
    const c = await ctx.db.get(id);
    return c ? c.carrierName : 'unknown carrier';
  };
  const dateOr = (d: unknown, open: string) => (typeof d === 'string' ? d : open);

  if ('driverId' in after && after.driverId !== before.driverId) {
    parts.push(`Driver: ${await driverName(before.driverId)} → ${await driverName(after.driverId as Id<'drivers'> | undefined)}`);
  }
  if ('carrierPartnershipId' in after && after.carrierPartnershipId !== before.carrierPartnershipId) {
    parts.push(
      `Carrier: ${await carrierName(before.carrierPartnershipId)} → ${await carrierName(after.carrierPartnershipId as Id<'carrierPartnerships'> | undefined)}`,
    );
  }
  if ('activeDays' in after && formatDays(after.activeDays as number[] | undefined) !== formatDays(before.activeDays)) {
    parts.push(`Days: ${formatDays(before.activeDays)} → ${formatDays(after.activeDays as number[] | undefined)}`);
  }
  if ('excludeFederalHolidays' in after && !!after.excludeFederalHolidays !== !!before.excludeFederalHolidays) {
    parts.push(`Skip federal holidays: ${before.excludeFederalHolidays ? 'on' : 'off'} → ${after.excludeFederalHolidays ? 'on' : 'off'}`);
  }
  if ('customExclusions' in after) {
    const b = before.customExclusions ?? [];
    const a = (after.customExclusions as string[] | undefined) ?? [];
    if (b.join(',') !== a.join(',')) parts.push(`Excluded dates: ${b.length} → ${a.length}`);
  }
  if ('effectiveFrom' in after && after.effectiveFrom !== before.effectiveFrom) {
    parts.push(`Active from: ${dateOr(before.effectiveFrom, 'start')} → ${dateOr(after.effectiveFrom, 'start')}`);
  }
  if ('effectiveUntil' in after && after.effectiveUntil !== before.effectiveUntil) {
    parts.push(`Active until: ${dateOr(before.effectiveUntil, 'open-ended')} → ${dateOr(after.effectiveUntil, 'open-ended')}`);
  }
  if ('hcr' in after && after.hcr !== before.hcr) parts.push(`HCR: ${before.hcr} → ${after.hcr}`);
  if ('tripNumber' in after && after.tripNumber !== before.tripNumber) {
    parts.push(`Trip: ${before.tripNumber ?? 'any'} → ${(after.tripNumber as string | undefined) ?? 'any'}`);
  }
  if ('priority' in after && after.priority !== before.priority) parts.push(`Priority: ${before.priority} → ${after.priority}`);
  if ('isActive' in after && after.isActive !== before.isActive) parts.push(after.isActive ? 'Activated' : 'Paused');
  if ('name' in after && after.name !== before.name) parts.push(`Name: "${before.name ?? ''}" → "${after.name ?? ''}"`);
  if ('notes' in after && after.notes !== before.notes) parts.push('Notes updated');
  return parts.join(' · ');
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
  heldLoads: v.optional(
    v.array(
      v.object({
        orderNumber: v.string(),
        serviceDate: v.optional(v.string()),
        reason: v.string(),
        detail: v.optional(v.string()),
      }),
    ),
  ),
});

/**
 * Kick off a re-sync for a rule: release the loads it placed that no
 * longer fit it, and let auto-assignment place them again (routeRotation.ts).
 */
async function scheduleRotation(
  ctx: MutationCtx,
  routeId: Id<'routeAssignments'>,
  actor: { userId: string; userName?: string },
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.routeRotation.runRotation, {
    routeId,
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
      effectiveFrom: v.optional(v.string()),
      effectiveUntil: v.optional(v.string()),
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
      effectiveFrom: v.optional(v.string()),
      effectiveUntil: v.optional(v.string()),
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
      effectiveFrom: v.optional(v.string()),
      effectiveUntil: v.optional(v.string()),
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
      effectiveFrom: v.optional(v.string()),
      effectiveUntil: v.optional(v.string()),
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
      effectiveFrom: v.optional(v.string()),
      effectiveUntil: v.optional(v.string()),
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
    // Effective range (service dates, inclusive). Omit for open-ended.
    effectiveFrom: v.optional(v.string()),
    effectiveUntil: v.optional(v.string()),
    name: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdBy: v.string(),
  },
  returns: v.id('routeAssignments'),
  handler: async (ctx, args) => {
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const effectiveFrom = validateDate('Active from', args.effectiveFrom);
    const effectiveUntil = validateDate('Active until', args.effectiveUntil);
    assertEffectiveRange(effectiveFrom, effectiveUntil);

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
      effectiveFrom,
      effectiveUntil,
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
      effectiveFrom,
      effectiveUntil,
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
      description:
        `Created route assignment for HCR ${args.hcr}${args.tripNumber ? ` / Trip ${args.tripNumber}` : ''}` +
        (effectiveFrom ? `, active from ${effectiveFrom}` : '') +
        (effectiveUntil ? `, until ${effectiveUntil}` : ''),
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
    // Effective range. null clears a bound; undefined leaves it alone.
    effectiveFrom: v.optional(v.union(v.string(), v.null())),
    effectiveUntil: v.optional(v.union(v.string(), v.null())),
    // A planned change: instead of editing this rule in place, end it the
    // day before `applyFrom` and create its replacement — this rule's
    // fields plus the edit — starting on that date. Both stay visible,
    // both are audited, and nothing the current rule placed is touched
    // until the sweep reaches the new date.
    applyFrom: v.optional(v.string()),
    // Re-sync afterwards: release the loads this rule placed that no
    // longer fit it and let auto-assignment place them again
    // (routeRotation.ts). Off by default: editing a rule never silently
    // re-dispatches anything.
    reassignFutureLoads: v.optional(v.boolean()),
  },
  returns: v.id('routeAssignments'),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const { id, reassignFutureLoads, applyFrom: applyFromRaw, ...updates } = args;
    const applyFrom = validateDate('Apply from', applyFromRaw);

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
    if (updates.effectiveFrom !== undefined) {
      updateData.effectiveFrom = validateDate('Active from', updates.effectiveFrom);
    }
    if (updates.effectiveUntil !== undefined) {
      updateData.effectiveUntil = validateDate('Active until', updates.effectiveUntil);
    }
    assertEffectiveRange(
      ('effectiveFrom' in updateData ? updateData.effectiveFrom : existing.effectiveFrom) as string | undefined,
      ('effectiveUntil' in updateData ? updateData.effectiveUntil : existing.effectiveUntil) as string | undefined,
    );

    // A planned change splits the rule instead of editing it.
    if (applyFrom !== undefined && (existing.effectiveFrom === undefined || existing.effectiveFrom < applyFrom)) {
      return await scheduleChange(ctx, existing, updateData, applyFrom, {
        userId,
        userName,
        userEmail,
        reassign: reassignFutureLoads === true,
      });
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
      effectiveFrom: ('effectiveFrom' in updateData ? updateData.effectiveFrom : existing.effectiveFrom) as
        | string
        | undefined,
      effectiveUntil: ('effectiveUntil' in updateData ? updateData.effectiveUntil : existing.effectiveUntil) as
        | string
        | undefined,
      excludeId: id,
    });

    await ctx.db.patch(id, updateData);

    const changedFields = Object.keys(updateData).filter((key) => key !== 'updatedAt');
    if (changedFields.length > 0) {
      const summary = await describeChanges(ctx, existing, updateData);
      const before: Record<string, unknown> = {};
      for (const key of changedFields) before[key] = (existing as Record<string, unknown>)[key];
      await logAudit(ctx, {
        organizationId: existing.workosOrgId,
        entityType: 'routeAssignment',
        entityId: id,
        entityName: existing.name,
        action: 'updated',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description:
          `Updated rule for HCR ${existing.hcr}${existing.tripNumber ? ` / Trip ${existing.tripNumber}` : ''}` +
          (summary ? ` — ${summary}` : ''),
        changedFields,
        changesBefore: JSON.stringify(before),
        changesAfter: JSON.stringify(updateData),
      });
    }

    // Re-sync: when the caller asked. The assessment decides what is
    // actually out of sync (resource, days, effective range), so a save
    // that changed nothing placement-related is a no-op run.
    if (reassignFutureLoads) {
      await scheduleRotation(ctx, id, { userId, userName });
    }

    return id;
  },
});

/**
 * What a re-sync would do right now, for the edit modal's confirmation.
 * Evaluated against the PROPOSED edit, before it is saved: any placement
 * field passed here overrides the stored one.
 */
export const previewRotation = query({
  args: {
    id: v.id('routeAssignments'),
    driverId: v.optional(v.id('drivers')),
    carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
    activeDays: v.optional(v.array(v.number())),
    excludeFederalHolidays: v.optional(v.boolean()),
    effectiveFrom: v.optional(v.string()),
    effectiveUntil: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
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

    const proposedTarget =
      args.driverId || args.carrierPartnershipId
        ? { driverId: args.driverId, carrierPartnershipId: args.carrierPartnershipId }
        : { driverId: rule.driverId, carrierPartnershipId: rule.carrierPartnershipId };
    const proposed = {
      ...rule,
      ...proposedTarget,
      activeDays: args.activeDays !== undefined ? normalizeActiveDays(args.activeDays) : rule.activeDays,
      excludeFederalHolidays: args.excludeFederalHolidays ?? rule.excludeFederalHolidays,
      effectiveFrom: args.effectiveFrom ?? rule.effectiveFrom,
      effectiveUntil: args.effectiveUntil ?? rule.effectiveUntil,
      isActive: args.isActive ?? rule.isActive,
    };

    const assessed = await assessRuleLoads(ctx, proposed);
    const byReason = new Map<string, number>();
    let eligible = 0;
    for (const a of assessed) {
      if (a.verdict.eligible) eligible++;
      else if (a.verdict.reason !== 'IN_SYNC') {
        byReason.set(a.verdict.reason, (byReason.get(a.verdict.reason) ?? 0) + 1);
      }
    }
    const held = [...byReason.values()].reduce((n, c) => n + c, 0);
    return {
      eligible,
      held,
      byReason: [...byReason.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    };
  },
});

/**
 * Re-sync one rule: release the loads it placed that no longer fit it and
 * let auto-assignment place them again. The retry path when a scheduled
 * re-sync was interrupted, and the fix for a rule changed earlier without
 * one.
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

    await scheduleRotation(ctx, args.id, { userId, userName });
    return null;
  },
});

/**
 * Is anything out of sync across the org? Drives the page's "Re-sync all"
 * banner: it appears when some rule owns upcoming loads that sit on a
 * previous resource, and disappears once a re-sync has moved them.
 *
 * `outOfSync` is what a re-sync would release and re-place. `blocked` is
 * what it will not touch (in motion, past) — IN_SYNC is not a block, it is
 * the normal state, so it is left out of the count.
 */
export const previewOrgRotation = query({
  args: { workosOrgId: v.string() },
  returns: v.object({
    outOfSync: v.number(),
    blocked: v.number(),
    rules: v.number(),
    byRule: v.array(
      v.object({
        routeId: v.id('routeAssignments'),
        name: v.optional(v.string()),
        hcr: v.string(),
        outOfSync: v.number(),
        blocked: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const rules = (
      await ctx.db
        .query('routeAssignments')
        .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
        .collect()
    ).filter((r) => r.driverId || r.carrierPartnershipId);

    const byRule: Array<{
      routeId: Id<'routeAssignments'>;
      name?: string;
      hcr: string;
      outOfSync: number;
      blocked: number;
    }> = [];
    for (const rule of rules) {
      const assessed = await assessRuleLoads(ctx, rule);
      let outOfSync = 0;
      let blocked = 0;
      for (const a of assessed) {
        if (a.verdict.eligible) outOfSync++;
        else if (a.verdict.reason !== 'IN_SYNC') blocked++;
      }
      if (outOfSync > 0 || blocked > 0) {
        byRule.push({ routeId: rule._id, name: rule.name, hcr: rule.hcr, outOfSync, blocked });
      }
    }

    return {
      outOfSync: byRule.reduce((n, r) => n + r.outOfSync, 0),
      blocked: byRule.reduce((n, r) => n + r.blocked, 0),
      rules: byRule.filter((r) => r.outOfSync > 0).length,
      byRule,
    };
  },
});

/**
 * Re-sync every active rule at once (routeRotation.runOrgRotation). The
 * bulk form of rotateLoads, for after a rotation touched several rules.
 */
export const rotateAllLoads = mutation({
  args: { workosOrgId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);

    await logAudit(ctx, {
      organizationId: args.workosOrgId,
      entityType: 'routeAssignment',
      entityId: args.workosOrgId,
      action: 'auto_assign_rotated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: 'Requested re-sync of upcoming loads for every active route rule',
    });

    await ctx.scheduler.runAfter(0, internal.routeRotation.runOrgRotation, {
      workosOrgId: args.workosOrgId,
      userId,
      userName,
    });
    return null;
  },
});

/**
 * The planned-change split. The current rule keeps everything it has and
 * gains an end date; a new rule — the current one plus the edit — starts
 * the next day. Returns the new rule's id.
 */
async function scheduleChange(
  ctx: MutationCtx,
  existing: Doc<'routeAssignments'>,
  updateData: Record<string, unknown>,
  applyFrom: string,
  actor: { userId: string; userName?: string; userEmail?: string; reassign: boolean },
): Promise<Id<'routeAssignments'>> {
  const now = Date.now();
  const dayBefore = shiftServiceDate(applyFrom, -1);
  if (existing.effectiveUntil !== undefined && existing.effectiveUntil < applyFrom) {
    throw new ConvexError(`This rule already ends on ${existing.effectiveUntil}, before ${applyFrom}`);
  }

  // The replacement: current fields, then the edit, then the range.
  const {
    _id: _oldId,
    _creationTime: _ct,
    lastRotation: _lr,
    createdBy: _cb,
    createdAt: _ca,
    updatedAt: _ua,
    ...base
  } = existing;
  void _oldId; void _ct; void _lr; void _cb; void _ca; void _ua;
  const { updatedAt: _u, ...edit } = updateData;
  void _u;
  const replacement = {
    ...base,
    ...edit,
    effectiveFrom: applyFrom,
    // The edit may set its own end; otherwise inherit the current rule's.
    effectiveUntil:
      'effectiveUntil' in edit
        ? (edit.effectiveUntil as string | undefined)
        : existing.effectiveUntil,
    createdBy: actor.userId,
    createdAt: now,
    updatedAt: now,
  } as Omit<Doc<'routeAssignments'>, '_id' | '_creationTime'>;
  assertEffectiveRange(replacement.effectiveFrom, replacement.effectiveUntil);

  // End the current rule first so the collision check sees the two as
  // disjoint on the date axis.
  await ctx.db.patch(existing._id, { effectiveUntil: dayBefore, updatedAt: now });
  await assertNoDayCollision(ctx, {
    workosOrgId: replacement.workosOrgId,
    hcr: replacement.hcr,
    tripNumber: replacement.tripNumber,
    activeDays: replacement.activeDays,
    effectiveFrom: replacement.effectiveFrom,
    effectiveUntil: replacement.effectiveUntil,
  });
  const newId = await ctx.db.insert('routeAssignments', replacement);

  const summary = await describeChanges(ctx, existing, edit);
  const route = `HCR ${existing.hcr}${existing.tripNumber ? ` / Trip ${existing.tripNumber}` : ''}`;
  await logAudit(ctx, {
    organizationId: existing.workosOrgId,
    entityType: 'routeAssignment',
    entityId: existing._id,
    entityName: existing.name,
    action: 'updated',
    performedBy: actor.userId,
    performedByName: actor.userName,
    performedByEmail: actor.userEmail,
    description: `Scheduled change for ${route}: this rule now ends ${dayBefore}; from ${applyFrom} replaced by a new rule${summary ? ` — ${summary}` : ''}`,
    changedFields: ['effectiveUntil'],
    changesBefore: JSON.stringify({ effectiveUntil: existing.effectiveUntil }),
    changesAfter: JSON.stringify({ effectiveUntil: dayBefore, replacedBy: newId }),
  });
  await logAudit(ctx, {
    organizationId: existing.workosOrgId,
    entityType: 'routeAssignment',
    entityId: newId,
    entityName: replacement.name,
    action: 'created',
    performedBy: actor.userId,
    performedByName: actor.userName,
    performedByEmail: actor.userEmail,
    description: `Created by scheduled change for ${route}, active from ${applyFrom}${summary ? ` — ${summary}` : ''} (replaces the rule ending ${dayBefore})`,
    changesAfter: JSON.stringify(edit),
  });

  // Loads the current rule placed on or after applyFrom are no longer
  // covered by it; a re-sync releases them and the sweep re-places them
  // under the replacement. With a one-day horizon this is usually nothing.
  if (actor.reassign) {
    await scheduleRotation(ctx, existing._id, { userId: actor.userId, userName: actor.userName });
  }
  return newId;
}

/**
 * A rule's change history, from the audit trail — who changed what, when,
 * in the words the edit was described with.
 */
export const history = query({
  args: { id: v.id('routeAssignments'), limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      at: v.number(),
      by: v.string(),
      action: v.string(),
      description: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const rule = await ctx.db.get(args.id);
    if (!rule || rule.workosOrgId !== callerOrgId) return [];
    const rows = await ctx.db
      .query('auditLog')
      .withIndex('by_org_entity', (q) =>
        q.eq('organizationId', callerOrgId).eq('entityType', 'routeAssignment').eq('entityId', args.id),
      )
      .order('desc')
      .take(Math.min(args.limit ?? 20, 100));
    return rows.map((r) => ({
      at: r.timestamp,
      by: r.performedByName ?? r.performedByEmail ?? r.performedBy,
      action: r.action,
      description: r.description ?? '',
    }));
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

    // The loads this rule placed would be orphaned by the delete — their
    // provenance would point at nothing, so no later re-sync could reach
    // them. Release the upcoming, not-started ones now (no opt-out) and
    // queue the ordinary assignment decision on each, so whichever rule
    // covers them next takes them, or they wait Open for a dispatcher.
    const assessed = await assessRuleLoads(ctx, assignment);
    let released = 0;
    for (const a of assessed) {
      const stays = !a.verdict.eligible && a.verdict.reason !== 'IN_SYNC';
      if (stays) continue;
      const r = await unassignLoadResources(
        ctx,
        a.load._id,
        { userId, userName, userEmail },
        `route rule "${assignment.name ?? assignment.hcr}" deleted; released for re-assignment`,
        false,
      );
      if (r.status !== 'SUCCESS') continue;
      released++;
      await ctx.scheduler.runAfter(0, internal.autoAssignment.autoAssignLoad, {
        loadId: a.load._id,
        userId,
        userName: userName ?? 'Route re-sync',
      });
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
      description:
        `Deleted route assignment for HCR ${assignment.hcr}${assignment.tripNumber ? ` / Trip ${assignment.tripNumber}` : ''}` +
        (released > 0 ? ` — released ${released} upcoming load${released === 1 ? '' : 's'} it had assigned` : ''),
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
      lastBulkRotation: v.optional(
        v.object({
          at: v.number(),
          rules: v.number(),
          considered: v.number(),
          moved: v.number(),
          held: v.number(),
          byReason: v.array(v.object({ reason: v.string(), count: v.number() })),
        }),
      ),
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
