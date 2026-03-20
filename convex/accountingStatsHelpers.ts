/**
 * Helper functions for maintaining accountingPeriodStats aggregate table
 *
 * Revenue-only pre-computed stats following the same pattern as stats_helpers.ts.
 * Cost-side metrics (driver pay, carrier pay, fuel) are computed on-demand
 * from settlements and payable tables to avoid churn from frequent recalculations.
 *
 * Period key format: "YYYY-MM" (monthly granularity)
 */

import { MutationCtx } from './_generated/server';

/**
 * Derive the period key (YYYY-MM) from a Unix timestamp
 */
export function getPeriodKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Get or create an accounting period stats document for a given org + period
 */
async function getOrCreatePeriodStats(ctx: MutationCtx, orgId: string, periodKey: string) {
  const existing = await ctx.db
    .query('accountingPeriodStats')
    .withIndex('by_org_period', (q) => q.eq('workosOrgId', orgId).eq('periodKey', periodKey))
    .first();

  if (existing) return existing;

  const id = await ctx.db.insert('accountingPeriodStats', {
    workosOrgId: orgId,
    periodKey,
    totalInvoiced: 0,
    totalCollected: 0,
    invoiceCount: 0,
    paidInvoiceCount: 0,
    updatedAt: Date.now(),
  });

  return (await ctx.db.get(id))!;
}

/**
 * Record revenue when an invoice is finalized (BILLED or frozen during payment).
 * Called when an invoice transitions from non-finalized to finalized and totalAmount is frozen.
 *
 * @param ctx - Mutation context
 * @param orgId - Organization ID
 * @param totalAmount - The frozen invoice total amount
 * @param timestamp - The timestamp to determine which period (invoiceDateNumeric or now)
 */
export async function recordInvoiceFinalized(
  ctx: MutationCtx,
  orgId: string,
  totalAmount: number,
  timestamp: number,
): Promise<void> {
  const periodKey = getPeriodKey(timestamp);
  const stats = await getOrCreatePeriodStats(ctx, orgId, periodKey);

  await ctx.db.patch(stats._id, {
    totalInvoiced: stats.totalInvoiced + totalAmount,
    invoiceCount: stats.invoiceCount + 1,
    updatedAt: Date.now(),
  });
}

/**
 * Record a payment collection.
 * Handles delta updates when a payment overwrites a previous one.
 *
 * @param ctx - Mutation context
 * @param orgId - Organization ID
 * @param paidAmount - The new paid amount
 * @param previousPaidAmount - The previous paid amount (0 if first payment)
 * @param timestamp - The timestamp to determine which period
 */
export async function recordPaymentCollected(
  ctx: MutationCtx,
  orgId: string,
  paidAmount: number,
  previousPaidAmount: number,
  timestamp: number,
): Promise<void> {
  const periodKey = getPeriodKey(timestamp);
  const stats = await getOrCreatePeriodStats(ctx, orgId, periodKey);

  const delta = paidAmount - previousPaidAmount;
  const isNewPayment = previousPaidAmount === 0;

  await ctx.db.patch(stats._id, {
    totalCollected: stats.totalCollected + delta,
    paidInvoiceCount: isNewPayment ? stats.paidInvoiceCount + 1 : stats.paidInvoiceCount,
    updatedAt: Date.now(),
  });
}

/**
 * Reverse revenue when an invoice is voided from a finalized state.
 *
 * @param ctx - Mutation context
 * @param orgId - Organization ID
 * @param totalAmount - The amount to reverse
 * @param wasPaid - Whether the invoice was previously paid
 * @param paidAmount - The paid amount to reverse (if was paid)
 * @param timestamp - The timestamp of the original period
 */
export async function reverseInvoice(
  ctx: MutationCtx,
  orgId: string,
  totalAmount: number,
  wasPaid: boolean,
  paidAmount: number,
  timestamp: number,
): Promise<void> {
  const periodKey = getPeriodKey(timestamp);
  const stats = await getOrCreatePeriodStats(ctx, orgId, periodKey);

  await ctx.db.patch(stats._id, {
    totalInvoiced: Math.max(0, stats.totalInvoiced - totalAmount),
    invoiceCount: Math.max(0, stats.invoiceCount - 1),
    totalCollected: wasPaid ? Math.max(0, stats.totalCollected - paidAmount) : stats.totalCollected,
    paidInvoiceCount: wasPaid ? Math.max(0, stats.paidInvoiceCount - 1) : stats.paidInvoiceCount,
    updatedAt: Date.now(),
  });
}

/**
 * Reverse a payment when an invoice is reset from PAID to DRAFT.
 *
 * @param ctx - Mutation context
 * @param orgId - Organization ID
 * @param paidAmount - The paid amount to reverse
 * @param totalAmount - The invoiced amount to reverse (amounts are cleared on reset)
 * @param timestamp - The timestamp of the original period
 */
export async function reversePaymentAndInvoice(
  ctx: MutationCtx,
  orgId: string,
  paidAmount: number,
  totalAmount: number,
  timestamp: number,
): Promise<void> {
  const periodKey = getPeriodKey(timestamp);
  const stats = await getOrCreatePeriodStats(ctx, orgId, periodKey);

  await ctx.db.patch(stats._id, {
    totalInvoiced: Math.max(0, stats.totalInvoiced - totalAmount),
    totalCollected: Math.max(0, stats.totalCollected - paidAmount),
    invoiceCount: Math.max(0, stats.invoiceCount - 1),
    paidInvoiceCount: Math.max(0, stats.paidInvoiceCount - 1),
    updatedAt: Date.now(),
  });
}
