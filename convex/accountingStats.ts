/**
 * Accounting Period Statistics Recalculation (Drift Protection)
 *
 * Follows the same self-scheduling chain pattern as stats.ts.
 * Recalculates revenue-side metrics from source data and compares
 * against pre-computed accountingPeriodStats, correcting any drift.
 *
 * Architecture:
 * 1. recalculateAllOrgs -> for each org, schedule recalculateOrgAccountingStats
 * 2. recalculateOrgAccountingStats -> scan finalized invoices in batches
 * 3. Each batch accumulates totals by period key (YYYY-MM)
 * 4. Final step writes/patches accountingPeriodStats documents
 */

import { internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { getPeriodKey } from './accountingStatsHelpers';

const BATCH_SIZE = 2000;

// Statuses that contribute to revenue stats
const FINALIZED_STATUSES = ['BILLED', 'PENDING_PAYMENT', 'PAID'] as const;

/**
 * Scan invoices in batches and accumulate revenue totals per period.
 * Self-schedules for pagination within a status, then moves to next status.
 */
export const countAccountingStats = internalMutation({
  args: {
    workosOrgId: v.string(),
    statusIndex: v.number(),
    cursor: v.union(v.string(), v.null()),
    accumulated: v.string(), // JSON: Record<periodKey, { totalInvoiced, totalCollected, invoiceCount, paidInvoiceCount }>
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { workosOrgId, statusIndex, cursor } = args;
    const accumulated: Record<
      string,
      {
        totalInvoiced: number;
        totalCollected: number;
        invoiceCount: number;
        paidInvoiceCount: number;
      }
    > = JSON.parse(args.accumulated);

    const status = FINALIZED_STATUSES[statusIndex];

    const results = await ctx.db
      .query('loadInvoices')
      .withIndex('by_status', (q) => q.eq('workosOrgId', workosOrgId).eq('status', status))
      .paginate({ numItems: BATCH_SIZE, cursor });

    // Process this batch
    for (const invoice of results.page) {
      const totalAmount = invoice.totalAmount ?? 0;
      if (totalAmount === 0 && !invoice.paidAmount) continue; // Skip empty invoices

      const periodTimestamp = invoice.invoiceDateNumeric ?? invoice.createdAt;
      const periodKey = getPeriodKey(periodTimestamp);

      if (!accumulated[periodKey]) {
        accumulated[periodKey] = {
          totalInvoiced: 0,
          totalCollected: 0,
          invoiceCount: 0,
          paidInvoiceCount: 0,
        };
      }

      accumulated[periodKey].totalInvoiced += totalAmount;
      accumulated[periodKey].invoiceCount += 1;

      // Count payments from any finalized status that has paidAmount
      if (invoice.paidAmount !== undefined && invoice.paidAmount !== 0) {
        accumulated[periodKey].totalCollected += invoice.paidAmount;
        accumulated[periodKey].paidInvoiceCount += 1;
      }
    }

    // If more pages remain for this status, continue
    if (!results.isDone) {
      await ctx.scheduler.runAfter(0, internal.accountingStats.countAccountingStats, {
        workosOrgId,
        statusIndex,
        cursor: results.continueCursor,
        accumulated: JSON.stringify(accumulated),
      });
      return null;
    }

    // Move to next status
    const nextStatusIndex = statusIndex + 1;
    if (nextStatusIndex < FINALIZED_STATUSES.length) {
      await ctx.scheduler.runAfter(0, internal.accountingStats.countAccountingStats, {
        workosOrgId,
        statusIndex: nextStatusIndex,
        cursor: null,
        accumulated: JSON.stringify(accumulated),
      });
      return null;
    }

    // All statuses processed — write final results
    const now = Date.now();
    let driftDetected = false;

    for (const [periodKey, totals] of Object.entries(accumulated)) {
      const existing = await ctx.db
        .query('accountingPeriodStats')
        .withIndex('by_org_period', (q) => q.eq('workosOrgId', workosOrgId).eq('periodKey', periodKey))
        .first();

      if (existing) {
        // Check for drift
        if (
          Math.abs(existing.totalInvoiced - totals.totalInvoiced) > 0.01 ||
          Math.abs(existing.totalCollected - totals.totalCollected) > 0.01 ||
          existing.invoiceCount !== totals.invoiceCount ||
          existing.paidInvoiceCount !== totals.paidInvoiceCount
        ) {
          driftDetected = true;
          console.log(
            `Accounting drift detected for org ${workosOrgId} period ${periodKey}: ` +
              `invoiced ${existing.totalInvoiced} -> ${totals.totalInvoiced}, ` +
              `collected ${existing.totalCollected} -> ${totals.totalCollected}`,
          );
        }

        await ctx.db.patch(existing._id, {
          ...totals,
          lastRecalculated: now,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert('accountingPeriodStats', {
          workosOrgId,
          periodKey,
          ...totals,
          lastRecalculated: now,
          updatedAt: now,
        });
      }
    }

    // Zero out stale periods that no longer have any finalized invoices
    const allExistingStats = await ctx.db
      .query('accountingPeriodStats')
      .withIndex('by_org', (q) => q.eq('workosOrgId', workosOrgId))
      .collect();

    for (const existing of allExistingStats) {
      if (!accumulated[existing.periodKey]) {
        // This period has no finalized invoices — zero it out
        if (existing.totalInvoiced !== 0 || existing.totalCollected !== 0 || existing.invoiceCount !== 0) {
          driftDetected = true;
          console.log(`Accounting stale period zeroed for org ${workosOrgId} period ${existing.periodKey}`);
        }
        await ctx.db.patch(existing._id, {
          totalInvoiced: 0,
          totalCollected: 0,
          invoiceCount: 0,
          paidInvoiceCount: 0,
          lastRecalculated: now,
          updatedAt: now,
        });
      }
    }

    if (driftDetected) {
      console.log(`Accounting stats drift corrected for org ${workosOrgId}`);
    }
    console.log(`Accounting stats recalculated for org ${workosOrgId}: ${Object.keys(accumulated).length} periods`);
    return null;
  },
});

/**
 * Entry point for recalculating a single org's accounting stats.
 */
export const recalculateOrgAccountingStats = internalMutation({
  args: { workosOrgId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.accountingStats.countAccountingStats, {
      workosOrgId: args.workosOrgId,
      statusIndex: 0,
      cursor: null,
      accumulated: JSON.stringify({}),
    });
    return null;
  },
});

/**
 * Recalculate accounting stats for all organizations.
 * Called by cron job daily.
 */
export const recalculateAllOrgsAccounting = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    console.log('Starting daily accounting stats recalculation for all organizations');

    const orgs = await ctx.db.query('organizations').collect();
    let scheduled = 0;

    for (const org of orgs) {
      if (!org.workosOrgId) continue;
      await ctx.scheduler.runAfter(0, internal.accountingStats.recalculateOrgAccountingStats, {
        workosOrgId: org.workosOrgId,
      });
      scheduled++;
    }

    console.log(`Scheduled accounting stats recalculation for ${scheduled} organizations`);
    return null;
  },
});
