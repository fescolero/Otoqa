import { v } from 'convex/values';
import { mutation, query, MutationCtx } from './_generated/server';
import { Id } from './_generated/dataModel';
import { assertCallerOwnsOrg, requireCallerOrgId, requireCallerIdentity } from './lib/auth';
import { logAudit } from './lib/audit';

type CallerIdentity = Awaited<ReturnType<typeof requireCallerIdentity>>;

/**
 * Load Hold Workflow
 * 
 * The "Power User" feature for accountants to hold loads from settlement
 * when paperwork is missing (POD, receipts, etc.)
 * 
 * Key Behaviors:
 * - Held loads are excluded from settlement generation
 * - When released, they automatically appear in the next settlement
 * - Audit trail tracks who held/released and why
 */

// ============================================
// QUERIES
// ============================================

/**
 * Get all held loads for an organization
 */
export const listHeldLoads = query({
  args: {
    workosOrgId: v.string(),
    driverId: v.optional(v.id('drivers')),
  },
  returns: v.array(
    v.object({
      _id: v.id('loadInformation'),
      internalId: v.string(),
      orderNumber: v.string(),
      primaryDriverId: v.optional(v.id('drivers')),
      driverName: v.optional(v.string()),
      isHeld: v.boolean(),
      heldReason: v.optional(v.string()),
      heldAt: v.optional(v.float64()),
      heldBy: v.optional(v.string()),
      hasSignedPod: v.optional(v.boolean()),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    let loadsQuery = ctx.db
      .query('loadInformation')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId));

    const allLoads = await loadsQuery.collect();

    // Filter to held loads
    const heldLoads = allLoads.filter((load) => load.isHeld === true);

    // Further filter by driver if specified
    const filtered = args.driverId
      ? heldLoads.filter((load) => load.primaryDriverId === args.driverId)
      : heldLoads;

    // Enrich with driver names
    const enriched = await Promise.all(
      filtered.map(async (load) => {
        let driverName: string | undefined;
        if (load.primaryDriverId) {
          const driver = await ctx.db.get(load.primaryDriverId);
          if (driver) {
            driverName = `${driver.firstName} ${driver.lastName}`;
          }
        }

        return {
          _id: load._id,
          internalId: load.internalId,
          orderNumber: load.orderNumber,
          primaryDriverId: load.primaryDriverId,
          driverName,
          isHeld: load.isHeld ?? false,
          heldReason: load.heldReason,
          heldAt: load.heldAt,
          heldBy: load.heldBy,
          hasSignedPod: load.hasSignedPod,
          createdAt: load.createdAt,
        };
      })
    );

    return enriched.sort((a, b) => (b.heldAt ?? 0) - (a.heldAt ?? 0));
  },
});

/**
 * Check if a load can be held
 * Returns validation info
 */
export const canHoldLoad = query({
  args: {
    loadId: v.id('loadInformation'),
  },
  returns: v.object({
    canHold: v.boolean(),
    reason: v.optional(v.string()),
    hasPayables: v.boolean(),
    payablesInSettlement: v.boolean(),
    settlementStatus: v.optional(
      v.union(
        v.literal('DRAFT'),
        v.literal('PENDING'),
        v.literal('APPROVED'),
        v.literal('PAID'),
        v.literal('VOID')
      )
    ),
  }),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== callerOrgId) {
      return {
        canHold: false,
        reason: 'Load not found',
        hasPayables: false,
        payablesInSettlement: false,
      };
    }

    // Check if already held
    if (load.isHeld) {
      return {
        canHold: false,
        reason: 'Load is already held',
        hasPayables: false,
        payablesInSettlement: false,
      };
    }

    // Check if load has payables
    const payables = await ctx.db
      .query('loadPayables')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    if (payables.length === 0) {
      return {
        canHold: false,
        reason: 'Load has no payables to hold',
        hasPayables: false,
        payablesInSettlement: false,
      };
    }

    // Check if any payables are in a settlement
    const payableInSettlement = payables.find((p) => p.settlementId !== undefined);
    if (payableInSettlement) {
      const settlement = await ctx.db.get(payableInSettlement.settlementId!);
      if (settlement) {
        // Can only hold if settlement is DRAFT
        if (settlement.status !== 'DRAFT') {
          return {
            canHold: false,
            reason: `Cannot hold - payables are in ${settlement.status} settlement`,
            hasPayables: true,
            payablesInSettlement: true,
            settlementStatus: settlement.status,
          };
        }
      }
    }

    return {
      canHold: true,
      hasPayables: true,
      payablesInSettlement: payableInSettlement !== undefined,
      settlementStatus: payableInSettlement
        ? (await ctx.db.get(payableInSettlement.settlementId!))?.status
        : undefined,
    };
  },
});

// ============================================
// MUTATIONS
// ============================================

/**
 * Single-load hold core, shared by holdLoad and bulkHoldLoads so the bulk
 * path runs in the same transaction instead of dispatching per-load
 * mutations. Writes the load's audit row on success.
 */
async function holdLoadCore(
  ctx: MutationCtx,
  caller: CallerIdentity,
  loadId: Id<'loadInformation'>,
  reason: string,
): Promise<{ success: boolean; message: string; payablesUnassigned?: number }> {
  const load = await ctx.db.get(loadId);
  if (!load || load.workosOrgId !== caller.orgId) {
    return {
      success: false,
      message: 'Load not found',
    };
  }

  // Check if already held
  if (load.isHeld) {
    return {
      success: false,
      message: 'Load is already held',
    };
  }

  const now = Date.now();

  // Find all payables for this load
  const payables = await ctx.db
    .query('loadPayables')
    .withIndex('by_load', (q) => q.eq('loadId', loadId))
    .collect();

  // Check if any are in non-DRAFT settlements
  for (const payable of payables) {
    if (payable.settlementId) {
      const settlement = await ctx.db.get(payable.settlementId);
      if (settlement && settlement.status !== 'DRAFT') {
        return {
          success: false,
          message: `Cannot hold - payables are in ${settlement.status} settlement ${settlement.statementNumber}`,
        };
      }
    }
  }

  // Unassign all payables from their settlements
  let unassignedCount = 0;
  for (const payable of payables) {
    if (payable.settlementId) {
      await ctx.db.patch(payable._id, {
        settlementId: undefined,
        updatedAt: now,
      });
      unassignedCount++;
    }
  }

  // Mark load as held
  await ctx.db.patch(loadId, {
    isHeld: true,
    heldReason: reason,
    heldAt: now,
    heldBy: caller.userId,
    updatedAt: now,
  });

  await logAudit(ctx, {
    organizationId: caller.orgId,
    entityType: 'load',
    entityId: loadId,
    entityName: load.internalId,
    action: 'held',
    performedBy: caller.userId,
    performedByName: caller.userName,
    performedByEmail: caller.userEmail,
    description: `Held load ${load.internalId} from settlement: ${reason}`,
  });

  return {
    success: true,
    message: `Load ${load.internalId} held successfully`,
    payablesUnassigned: unassignedCount,
  };
}

/**
 * Single-load release core, shared by releaseLoad and bulkReleaseLoads.
 * Writes the load's audit row on success.
 */
async function releaseLoadCore(
  ctx: MutationCtx,
  caller: CallerIdentity,
  loadId: Id<'loadInformation'>,
): Promise<{ success: boolean; message: string }> {
  const load = await ctx.db.get(loadId);
  if (!load || load.workosOrgId !== caller.orgId) {
    return {
      success: false,
      message: 'Load not found',
    };
  }

  // Check if actually held
  if (!load.isHeld) {
    return {
      success: false,
      message: 'Load is not currently held',
    };
  }

  // Release the hold
  await ctx.db.patch(loadId, {
    isHeld: false,
    heldReason: undefined,
    heldAt: undefined,
    heldBy: undefined,
    updatedAt: Date.now(),
  });

  await logAudit(ctx, {
    organizationId: caller.orgId,
    entityType: 'load',
    entityId: loadId,
    entityName: load.internalId,
    action: 'released',
    performedBy: caller.userId,
    performedByName: caller.userName,
    performedByEmail: caller.userEmail,
    description: `Released hold on load ${load.internalId}`,
  });

  return {
    success: true,
    message: `Load ${load.internalId} released successfully`,
  };
}

/**
 * Hold a load (exclude from settlement)
 * This is the #1 Power User feature for accountants
 */
export const holdLoad = mutation({
  args: {
    loadId: v.id('loadInformation'),
    reason: v.string(),
    userId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    payablesUnassigned: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const caller = await requireCallerIdentity(ctx);
    return await holdLoadCore(ctx, caller, args.loadId, args.reason);
  },
});

/**
 * Release a held load (make it available for settlement)
 */
export const releaseLoad = mutation({
  args: {
    loadId: v.id('loadInformation'),
    userId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
  }),
  handler: async (ctx, args) => {
    const caller = await requireCallerIdentity(ctx);
    return await releaseLoadCore(ctx, caller, args.loadId);
  },
});

/**
 * Bulk hold multiple loads
 */
export const bulkHoldLoads = mutation({
  args: {
    loadIds: v.array(v.id('loadInformation')),
    reason: v.string(),
    userId: v.string(),
  },
  returns: v.object({
    successful: v.number(),
    failed: v.number(),
    errors: v.array(
      v.object({
        loadId: v.id('loadInformation'),
        error: v.string(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    const caller = await requireCallerIdentity(ctx);
    let successful = 0;
    let failed = 0;
    const errors: Array<{ loadId: Id<'loadInformation'>; error: string }> = [];

    for (const loadId of args.loadIds) {
      const result = await holdLoadCore(ctx, caller, loadId, args.reason);

      if (result.success) {
        successful++;
      } else {
        failed++;
        errors.push({
          loadId,
          error: result.message,
        });
      }
    }

    return {
      successful,
      failed,
      errors,
    };
  },
});

/**
 * Bulk release multiple loads
 */
export const bulkReleaseLoads = mutation({
  args: {
    loadIds: v.array(v.id('loadInformation')),
    userId: v.string(),
  },
  returns: v.object({
    successful: v.number(),
    failed: v.number(),
    errors: v.array(
      v.object({
        loadId: v.id('loadInformation'),
        error: v.string(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    const caller = await requireCallerIdentity(ctx);
    let successful = 0;
    let failed = 0;
    const errors: Array<{ loadId: Id<'loadInformation'>; error: string }> = [];

    for (const loadId of args.loadIds) {
      const result = await releaseLoadCore(ctx, caller, loadId);

      if (result.success) {
        successful++;
      } else {
        failed++;
        errors.push({
          loadId,
          error: result.message,
        });
      }
    }

    return {
      successful,
      failed,
      errors,
    };
  },
});

/**
 * Upload POD for a load (and optionally release hold)
 */
export const uploadPod = mutation({
  args: {
    loadId: v.id('loadInformation'),
    storageId: v.id('_storage'),
    userId: v.string(),
    autoRelease: v.optional(v.boolean()), // Auto-release if held for missing POD?
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    wasReleased: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== callerOrgId) {
      return {
        success: false,
        message: 'Load not found',
        wasReleased: false,
      };
    }

    const now = Date.now();

    // Update load with POD
    await ctx.db.patch(args.loadId, {
      podStorageId: args.storageId,
      podUploadedAt: now,
      hasSignedPod: true,
      updatedAt: now,
    });

    // Auto-release if requested and held for POD
    let wasReleased = false;
    if (
      args.autoRelease &&
      load.isHeld &&
      load.heldReason?.toLowerCase().includes('pod')
    ) {
      await ctx.db.patch(args.loadId, {
        isHeld: false,
        heldReason: undefined,
        heldAt: undefined,
        heldBy: undefined,
      });
      wasReleased = true;
    }

    await logAudit(ctx, {
      organizationId: callerOrgId,
      entityType: 'load',
      entityId: args.loadId,
      entityName: load.internalId,
      action: 'updated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: wasReleased
        ? `Uploaded POD document for load ${load.internalId} and released hold`
        : `Uploaded POD document for load ${load.internalId}`,
    });

    return {
      success: true,
      message: wasReleased
        ? 'POD uploaded and load released'
        : 'POD uploaded successfully',
      wasReleased,
    };
  },
});

