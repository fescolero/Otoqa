/**
 * Platform Usage Metering — recalculation (drift protection) + read API.
 *
 * Otoqa bills each org a flat rate per load written into the system,
 * invoiced monthly. platformUsageStats rows are maintained event-driven by
 * platformUsageHelpers.recordLoadWritten on every loadInformation insert;
 * this module rebuilds them from source nightly (same self-scheduling chain
 * pattern as stats.ts / accountingStats.ts) so drift from bugs or historical
 * loads created before metering existed is corrected automatically. The
 * first cron run doubles as the backfill.
 *
 * Read side: getBillingOverview powers Settings → Billing & usage.
 */

import { internalMutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { getPeriodKey } from './accountingStatsHelpers';
import { DEFAULT_BILLING_RATE_PER_LOAD } from './platformUsageHelpers';
import { assertCallerOwnsOrg } from './lib/auth';
import { queryByOrg } from './_helpers/queryByOrg';

const BATCH_SIZE = 2000;

/**
 * Scan an org's loads in batches and accumulate created-per-period counts.
 * Self-schedules for pagination; the final batch writes the results and
 * zeroes stale periods.
 */
export const countPlatformUsage = internalMutation({
  args: {
    workosOrgId: v.string(),
    cursor: v.union(v.string(), v.null()),
    accumulated: v.string(), // JSON: Record<periodKey, loadsWritten>
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { workosOrgId, cursor } = args;
    const accumulated: Record<string, number> = JSON.parse(args.accumulated);

    const results = await ctx.db
      .query('loadInformation')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', workosOrgId))
      .paginate({ numItems: BATCH_SIZE, cursor });

    for (const load of results.page) {
      // Loads written before createdAt existed fall back to _creationTime.
      const periodKey = getPeriodKey(load.createdAt ?? load._creationTime);
      accumulated[periodKey] = (accumulated[periodKey] ?? 0) + 1;
    }

    if (!results.isDone) {
      await ctx.scheduler.runAfter(0, internal.platformUsage.countPlatformUsage, {
        workosOrgId,
        cursor: results.continueCursor,
        accumulated: JSON.stringify(accumulated),
      });
      return null;
    }

    // All loads scanned — write final results
    const now = Date.now();
    let driftDetected = false;

    for (const [periodKey, loadsWritten] of Object.entries(accumulated)) {
      const existing = await ctx.db
        .query('platformUsageStats')
        .withIndex('by_org_period', (q) => q.eq('workosOrgId', workosOrgId).eq('periodKey', periodKey))
        .first();

      if (existing) {
        if (existing.loadsWritten !== loadsWritten) {
          driftDetected = true;
          console.log(
            `Platform usage drift detected for org ${workosOrgId} period ${periodKey}: ` +
              `${existing.loadsWritten} -> ${loadsWritten}`,
          );
        }
        await ctx.db.patch(existing._id, {
          loadsWritten,
          lastRecalculated: now,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert('platformUsageStats', {
          workosOrgId,
          periodKey,
          loadsWritten,
          lastRecalculated: now,
          updatedAt: now,
        });
      }
    }

    // Zero out stale periods that no longer have any loads
    const allExisting = await ctx.db
      .query('platformUsageStats')
      .withIndex('by_org', (q) => q.eq('workosOrgId', workosOrgId))
      .collect();

    for (const existing of allExisting) {
      if (accumulated[existing.periodKey] === undefined) {
        if (existing.loadsWritten !== 0) {
          driftDetected = true;
          console.log(`Platform usage stale period zeroed for org ${workosOrgId} period ${existing.periodKey}`);
        }
        await ctx.db.patch(existing._id, {
          loadsWritten: 0,
          lastRecalculated: now,
          updatedAt: now,
        });
      }
    }

    if (driftDetected) {
      console.log(`Platform usage drift corrected for org ${workosOrgId}`);
    }
    console.log(`Platform usage recalculated for org ${workosOrgId}: ${Object.keys(accumulated).length} periods`);
    return null;
  },
});

/**
 * Entry point for recalculating a single org's platform usage.
 */
export const recalculateOrgPlatformUsage = internalMutation({
  args: { workosOrgId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.platformUsage.countPlatformUsage, {
      workosOrgId: args.workosOrgId,
      cursor: null,
      accumulated: JSON.stringify({}),
    });
    return null;
  },
});

/**
 * Recalculate platform usage for all organizations.
 * Called by cron job daily; the first run backfills history from source.
 */
export const recalculateAllOrgsPlatformUsage = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    console.log('Starting daily platform usage recalculation for all organizations');

    const orgs = await ctx.db.query('organizations').collect();
    let scheduled = 0;

    for (const org of orgs) {
      if (!org.workosOrgId) continue;
      await ctx.scheduler.runAfter(0, internal.platformUsage.recalculateOrgPlatformUsage, {
        workosOrgId: org.workosOrgId,
      });
      scheduled++;
    }

    console.log(`Scheduled platform usage recalculation for ${scheduled} organizations`);
    return null;
  },
});

// ─── Read API ──────────────────────────────────────────────────────────────

/**
 * Everything Settings → Billing & usage needs in one query:
 * the org's rate + billing contact, the open (accruing) cycle, and the
 * closed cycles newest-last with derived amounts.
 *
 * Invoice status/dates are DERIVED PLACEHOLDERS until a payment processor
 * is integrated: each closed cycle is treated as invoiced on the 1st of the
 * following month and due on the 15th; the most recent closed cycle is
 * "due" and older ones "paid". Usage counts and amounts are real.
 */
export const getBillingOverview = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const org = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .unique();

    const rate = org?.billingRatePerLoad ?? DEFAULT_BILLING_RATE_PER_LOAD;

    // Bounded: one row per org × month.
    const usageRows = await queryByOrg(ctx, 'platformUsageStats', args.workosOrgId).collect();
    const byPeriod = new Map(usageRows.map((r) => [r.periodKey, r.loadsWritten]));

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth(); // 0-based
    const currentPeriodKey = getPeriodKey(now.getTime());

    const daysInCycle = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const currentCycle = {
      periodKey: currentPeriodKey,
      loadsWritten: byPeriod.get(currentPeriodKey) ?? 0,
      dayOfCycle: now.getUTCDate(),
      daysInCycle,
      periodStartMs: Date.UTC(year, month, 1),
      periodEndMs: Date.UTC(year, month + 1, 0),
      nextInvoiceMs: Date.UTC(year, month + 1, 1),
    };

    // Closed cycles, oldest → newest. Statuses/dates are placeholders (see
    // docstring); amounts are loads × rate so table/chart/KPIs reconcile.
    // Months with no usage between the first recorded cycle and now are
    // filled with zero-load cycles so the timeline reads continuously.
    // Bounded to the most recent 24 closed cycles.
    const recordedKeys = usageRows
      .map((r) => r.periodKey)
      .filter((k) => k < currentPeriodKey)
      .sort();

    const closedKeys: string[] = [];
    if (recordedKeys.length > 0) {
      const [firstY, firstM] = recordedKeys[0].split('-').map(Number);
      for (let d = new Date(Date.UTC(firstY, firstM - 1, 1)); ; d.setUTCMonth(d.getUTCMonth() + 1)) {
        const key = getPeriodKey(d.getTime());
        if (key >= currentPeriodKey) break;
        closedKeys.push(key);
      }
    }
    while (closedKeys.length > 24) closedKeys.shift();

    const closedCycles = closedKeys.map((key, i) => {
      const [y, m] = key.split('-').map(Number); // m is 1-based
      const issuedMs = Date.UTC(y, m, 1); // 1st of following month
      const dueMs = Date.UTC(y, m, 15);
      const isLatest = i === closedKeys.length - 1;
      const loadsWritten = byPeriod.get(key) ?? 0;
      return {
        periodKey: key,
        loadsWritten,
        amount: loadsWritten * rate,
        status: (isLatest ? 'due' : 'paid') as 'due' | 'paid',
        issuedMs,
        dueMs,
        // Placeholder settlement date for display until real payments exist.
        paidMs: isLatest ? undefined : Date.UTC(y, m, 3),
      };
    });

    return {
      rate,
      billingEmail: org?.billingEmail ?? '',
      companyName: org?.name ?? '',
      currentCycle,
      closedCycles,
    };
  },
});
