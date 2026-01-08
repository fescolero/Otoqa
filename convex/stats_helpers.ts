/**
 * Helper functions for maintaining organizationStats aggregate table
 * 
 * Industry Standard Pattern: Event-Driven Aggregates
 * - Never count items in a query (expensive reads)
 * - Maintain counters that update with entity changes (cheap writes)
 * - Use Transaction Pattern: update stats atomically with entity changes
 */

import { MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * Get or create organization stats document
 * Uses .first() since stats might not exist yet (before migration or first mutation)
 */
async function getOrCreateStats(ctx: MutationCtx, orgId: string): Promise<Id<"organizationStats">> {
  let stats = await ctx.db
    .query("organizationStats")
    .withIndex("by_org", (q) => q.eq("workosOrgId", orgId))
    .first();
  
  if (!stats) {
    // Initialize stats with zeros for new organization
    const statsId = await ctx.db.insert("organizationStats", {
      workosOrgId: orgId,
      loadCounts: {
        Open: 0,
        Assigned: 0,
        Completed: 0,
        Canceled: 0,
      },
      invoiceCounts: {
        MISSING_DATA: 0,
        DRAFT: 0,
        BILLED: 0,
        PENDING_PAYMENT: 0,
        PAID: 0,
        VOID: 0,
      },
      updatedAt: Date.now(),
    });
    return statsId;
  }
  
  return stats._id;
}

/**
 * Update load count when status changes
 * 
 * @param ctx - Mutation context
 * @param orgId - Organization ID
 * @param oldStatus - Previous load status (undefined for new loads)
 * @param newStatus - New load status
 * @param amount - Amount to change (default: 1)
 * 
 * @example
 * // Creating new load with status "Open"
 * await updateLoadCount(ctx, orgId, undefined, "Open", 1);
 * 
 * @example
 * // Changing load from "Open" to "Assigned"
 * await updateLoadCount(ctx, orgId, "Open", "Assigned", 1);
 */
export async function updateLoadCount(
  ctx: MutationCtx,
  orgId: string,
  oldStatus: string | undefined,
  newStatus: string,
  amount: number = 1
): Promise<void> {
  const statsId = await getOrCreateStats(ctx, orgId);
  const stats = await ctx.db.get(statsId);
  
  if (!stats) return; // Should never happen, but TypeScript safety

  const newLoadCounts = { ...stats.loadCounts };
  
  // Decrement old status (if status changed)
  if (oldStatus && oldStatus in newLoadCounts) {
    newLoadCounts[oldStatus as keyof typeof newLoadCounts] = 
      Math.max(0, (newLoadCounts[oldStatus as keyof typeof newLoadCounts] || 0) - amount);
  }
  
  // Increment new status
  if (newStatus in newLoadCounts) {
    newLoadCounts[newStatus as keyof typeof newLoadCounts] = 
      (newLoadCounts[newStatus as keyof typeof newLoadCounts] || 0) + amount;
  }

  await ctx.db.patch(stats._id, {
    loadCounts: newLoadCounts,
    updatedAt: Date.now(),
  });
}

/**
 * Update invoice count when status changes
 * 
 * @param ctx - Mutation context
 * @param orgId - Organization ID
 * @param oldStatus - Previous invoice status (undefined for new invoices)
 * @param newStatus - New invoice status
 * @param amount - Amount to change (default: 1)
 * 
 * @example
 * // Creating new invoice with status "DRAFT"
 * await updateInvoiceCount(ctx, orgId, undefined, "DRAFT", 1);
 * 
 * @example
 * // Changing invoice from "DRAFT" to "PAID"
 * await updateInvoiceCount(ctx, orgId, "DRAFT", "PAID", 1);
 */
export async function updateInvoiceCount(
  ctx: MutationCtx,
  orgId: string,
  oldStatus: string | undefined,
  newStatus: string,
  amount: number = 1
): Promise<void> {
  const statsId = await getOrCreateStats(ctx, orgId);
  const stats = await ctx.db.get(statsId);
  
  if (!stats) return; // Should never happen, but TypeScript safety

  const newInvoiceCounts = { ...stats.invoiceCounts };
  
  // Decrement old status (if status changed)
  if (oldStatus && oldStatus in newInvoiceCounts) {
    newInvoiceCounts[oldStatus as keyof typeof newInvoiceCounts] = 
      Math.max(0, (newInvoiceCounts[oldStatus as keyof typeof newInvoiceCounts] || 0) - amount);
  }
  
  // Increment new status
  if (newStatus in newInvoiceCounts) {
    newInvoiceCounts[newStatus as keyof typeof newInvoiceCounts] = 
      (newInvoiceCounts[newStatus as keyof typeof newInvoiceCounts] || 0) + amount;
  }

  await ctx.db.patch(stats._id, {
    invoiceCounts: newInvoiceCounts,
    updatedAt: Date.now(),
  });
}

/**
 * Decrement load count (for deletions)
 * 
 * @param ctx - Mutation context
 * @param orgId - Organization ID
 * @param status - Load status being decremented
 * @param amount - Amount to decrease (default: 1)
 */
export async function decrementLoadCount(
  ctx: MutationCtx,
  orgId: string,
  status: string,
  amount: number = 1
): Promise<void> {
  const statsId = await getOrCreateStats(ctx, orgId);
  const stats = await ctx.db.get(statsId);
  
  if (!stats) return;

  const newLoadCounts = { ...stats.loadCounts };
  
  if (status in newLoadCounts) {
    newLoadCounts[status as keyof typeof newLoadCounts] = 
      Math.max(0, (newLoadCounts[status as keyof typeof newLoadCounts] || 0) - amount);
  }

  await ctx.db.patch(stats._id, {
    loadCounts: newLoadCounts,
    updatedAt: Date.now(),
  });
}

/**
 * Decrement invoice count (for deletions)
 * 
 * @param ctx - Mutation context
 * @param orgId - Organization ID
 * @param status - Invoice status being decremented
 * @param amount - Amount to decrease (default: 1)
 */
export async function decrementInvoiceCount(
  ctx: MutationCtx,
  orgId: string,
  status: string,
  amount: number = 1
): Promise<void> {
  const statsId = await getOrCreateStats(ctx, orgId);
  const stats = await ctx.db.get(statsId);
  
  if (!stats) return;

  const newInvoiceCounts = { ...stats.invoiceCounts };
  
  if (status in newInvoiceCounts) {
    newInvoiceCounts[status as keyof typeof newInvoiceCounts] = 
      Math.max(0, (newInvoiceCounts[status as keyof typeof newInvoiceCounts] || 0) - amount);
  }

  await ctx.db.patch(stats._id, {
    invoiceCounts: newInvoiceCounts,
    updatedAt: Date.now(),
  });
}

