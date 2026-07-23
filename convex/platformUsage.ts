/**
 * Platform Usage Metering — recalculation (undercount correction) + read API.
 *
 * Otoqa bills each org a flat rate per load written into the system,
 * invoiced monthly. platformUsageStats rows are maintained event-driven by
 * platformUsageHelpers.recordLoadWritten on every loadInformation insert;
 * this module recounts from source nightly (same self-scheduling chain
 * pattern as stats.ts / accountingStats.ts) so undercounts — bugs, missed
 * insert paths, historical loads created before metering existed — are
 * corrected automatically. The first cron run doubles as the backfill.
 *
 * Cycle attribution (see METERING_CUTOVER_MS):
 *   - Loads created ON/AFTER the metering cutover → entry month (createdAt).
 *     Immutable and auditable — the contractual billing basis.
 *   - Loads created BEFORE the cutover (pre-metering history) → service
 *     month (firstStopDate, falling back to createdAt). Their createdAt is
 *     bulk-import/sync noise, so entry-month attribution would show fake
 *     spikes on import months and near-empty months in between.
 *
 * IMPORTANT: the recalc only ever RAISES a period's count (max of recorded
 * vs recounted) and never zeroes recorded periods. Loads are billed for the
 * cycle they were written in, and loads.deleteLoad hard-deletes rows — a
 * recount from surviving rows must not retroactively erase charges on
 * closed (already invoiced) cycles, and must not clobber increments that
 * land while a multi-batch scan is in flight. To rebuild history from
 * scratch (e.g. after an attribution change), run rebaselinePlatformUsage
 * from the dashboard — safe only while no cycle has actually been invoiced.
 *
 * Read side: getBillingOverview powers Settings → Billing & usage.
 */

import { internalAction, internalMutation, internalQuery, query } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { getPeriodKey } from './accountingStatsHelpers';
import { DEFAULT_BILLING_RATE_PER_LOAD, METERING_CUTOVER_MS } from './platformUsageHelpers';
import { assertCallerOwnsOrg } from './lib/auth';
import { queryByOrg } from './_helpers/queryByOrg';

const BATCH_SIZE = 2000;

/**
 * Scan an org's loads in batches and accumulate created-per-period counts.
 * Self-schedules for pagination; the final batch writes the results
 * (raise-only — see module docstring).
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
      const created = load.createdAt ?? load._creationTime;
      let periodKey: string;
      if (created >= METERING_CUTOVER_MS) {
        // Metered load — billed for the month it was entered.
        periodKey = getPeriodKey(created);
      } else {
        // Pre-metering history — attribute to the service month so import
        // batches don't masquerade as usage spikes. firstStopDate is
        // 'YYYY-MM-DD'; malformed/missing values fall back to entry month.
        const serviceKey = load.firstStopDate?.slice(0, 7);
        periodKey = serviceKey && /^\d{4}-\d{2}$/.test(serviceKey) ? serviceKey : getPeriodKey(created);
      }
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

    // All loads scanned — write final results. Raise-only: charges are
    // permanent (see module docstring), so a recount below the recorded
    // value (hard-deleted loads, or increments racing this scan) keeps the
    // recorded value. Periods absent from the recount are left untouched
    // for the same reason.
    const now = Date.now();
    let undercountCorrected = false;

    for (const [periodKey, counted] of Object.entries(accumulated)) {
      const existing = await ctx.db
        .query('platformUsageStats')
        .withIndex('by_org_period', (q) => q.eq('workosOrgId', workosOrgId).eq('periodKey', periodKey))
        .first();

      if (existing) {
        if (counted > existing.loadsWritten) {
          undercountCorrected = true;
          console.log(
            `Platform usage undercount corrected for org ${workosOrgId} period ${periodKey}: ` +
              `${existing.loadsWritten} -> ${counted}`,
          );
        }
        await ctx.db.patch(existing._id, {
          loadsWritten: Math.max(existing.loadsWritten, counted),
          lastRecalculated: now,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert('platformUsageStats', {
          workosOrgId,
          periodKey,
          loadsWritten: counted,
          lastRecalculated: now,
          updatedAt: now,
        });
      }
    }

    if (undercountCorrected) {
      console.log(`Platform usage undercounts corrected for org ${workosOrgId}`);
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

// ─── Rebaseline (one-time history rebuild) ─────────────────────────────────

/**
 * Delete an org's platformUsageStats rows and rebuild them from source.
 *
 * The nightly recalc is raise-only, so it can never LOWER counts — after an
 * attribution change (e.g. the pre-cutover service-month fix) the old
 * inflated rows would stick. This clears the slate and lets the recount
 * write fresh values. ONLY safe while no cycle has actually been invoiced:
 * it discards recorded charges for hard-deleted loads.
 */
export const rebaselineOrgPlatformUsage = internalMutation({
  args: { workosOrgId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('platformUsageStats')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    console.log(`Platform usage rebaseline: cleared ${rows.length} periods for org ${args.workosOrgId}`);
    await ctx.scheduler.runAfter(0, internal.platformUsage.countPlatformUsage, {
      workosOrgId: args.workosOrgId,
      cursor: null,
      accumulated: JSON.stringify({}),
    });
    return null;
  },
});

/**
 * Rebaseline every org. Run once from the dashboard after deploying an
 * attribution change; the nightly cron stays raise-only afterwards.
 */
export const rebaselinePlatformUsage = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const orgs = await ctx.db.query('organizations').collect();
    let scheduled = 0;
    for (const org of orgs) {
      if (!org.workosOrgId) continue;
      await ctx.scheduler.runAfter(0, internal.platformUsage.rebaselineOrgPlatformUsage, {
        workosOrgId: org.workosOrgId,
      });
      scheduled++;
    }
    console.log(`Scheduled platform usage rebaseline for ${scheduled} organizations`);
    return null;
  },
});

// ─── Diagnostics ───────────────────────────────────────────────────────────

/**
 * One page of the attribution diagnostic: tallies this batch of loads by
 * creation month (what billing uses) and by service month (firstStopDate).
 */
export const diagnoseUsageAttributionPage = internalQuery({
  args: {
    workosOrgId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query('loadInformation')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .paginate({ numItems: BATCH_SIZE, cursor: args.cursor });

    const byCreatedMonth: Record<string, number> = {};
    const byServiceMonth: Record<string, number> = {};
    for (const load of results.page) {
      const createdKey = getPeriodKey(load.createdAt ?? load._creationTime);
      byCreatedMonth[createdKey] = (byCreatedMonth[createdKey] ?? 0) + 1;
      // firstStopDate is 'YYYY-MM-DD'; loads without one bucket as 'no-date'.
      const serviceKey = load.firstStopDate ? load.firstStopDate.slice(0, 7) : 'no-date';
      byServiceMonth[serviceKey] = (byServiceMonth[serviceKey] ?? 0) + 1;
    }

    return {
      byCreatedMonth,
      byServiceMonth,
      continueCursor: results.continueCursor,
      isDone: results.isDone,
    };
  },
});

/**
 * Dashboard diagnostic — run with { workosOrgId } from the Convex dashboard.
 *
 * Answers "why does cycle X show so few/many loads?": returns each month's
 * load count attributed two ways —
 *   byCreatedMonth: month the record was written into Otoqa (createdAt).
 *     THIS is what platform billing uses.
 *   byServiceMonth: month of the load's firstStopDate (when the route ran).
 * Bulk imports / sync backfills show up as spikes in byCreatedMonth on the
 * import month while byServiceMonth stays smooth.
 */
export const diagnoseUsageAttribution = internalAction({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    const byCreatedMonth: Record<string, number> = {};
    const byServiceMonth: Record<string, number> = {};
    let cursor: string | null = null;
    let scanned = 0;

    for (;;) {
      const page: {
        byCreatedMonth: Record<string, number>;
        byServiceMonth: Record<string, number>;
        continueCursor: string;
        isDone: boolean;
      } = await ctx.runQuery(internal.platformUsage.diagnoseUsageAttributionPage, {
        workosOrgId: args.workosOrgId,
        cursor,
      });
      for (const [k, n] of Object.entries(page.byCreatedMonth)) {
        byCreatedMonth[k] = (byCreatedMonth[k] ?? 0) + n;
        scanned += n;
      }
      for (const [k, n] of Object.entries(page.byServiceMonth)) {
        byServiceMonth[k] = (byServiceMonth[k] ?? 0) + n;
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    const sortObj = (o: Record<string, number>) =>
      Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

    return {
      totalLoads: scanned,
      byCreatedMonth: sortObj(byCreatedMonth),
      byServiceMonth: sortObj(byServiceMonth),
    };
  },
});

// ─── Read API ──────────────────────────────────────────────────────────────

/**
 * Deterministic platform invoice number: INV-<ORG6>-<SEQ>.
 *
 * ORG6 is the last 6 alphanumerics of the WorkOS org id (uppercased) —
 * stable per org, unique across orgs. SEQ is a 4-digit sequence in a
 * monthly series anchored at Jan 2024 (0001), so consecutive cycles get
 * consecutive numbers like a real invoice series, the same cycle always
 * reproduces the same number (no invoice storage needed yet), and a
 * history rebuild can never renumber anything. Server-side so the page,
 * CSV export, and PDF can never disagree.
 */
const INVOICE_SERIES_EPOCH_YEAR = 2024; // Jan 2024 = 0001

export function platformInvoiceNumber(workosOrgId: string, periodKey: string): string {
  const frag = workosOrgId.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
  const [y, m] = periodKey.split('-').map(Number);
  const seq = Math.max(1, (y - INVOICE_SERIES_EPOCH_YEAR) * 12 + m);
  return `INV-${frag}-${String(seq).padStart(4, '0')}`;
}

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
    // Bounded to the most recent 24 closed cycles — the window bound also
    // caps the fill loop, so one row with a corrupt ancient periodKey
    // (e.g. "1970-01" from a bad createdAt) can't blow up the query.
    const MAX_CLOSED_CYCLES = 24;
    const recordedKeys = usageRows
      .map((r) => r.periodKey)
      .filter((k) => k < currentPeriodKey)
      .sort();

    const closedKeys: string[] = [];
    if (recordedKeys.length > 0) {
      const [firstY, firstM] = recordedKeys[0].split('-').map(Number);
      // Months (0-based index from year 0) of the earliest recorded cycle
      // and the current cycle; start no earlier than the window allows.
      const firstMonthIdx = firstY * 12 + (firstM - 1);
      const currentMonthIdx = year * 12 + month;
      const startIdx = Math.max(firstMonthIdx, currentMonthIdx - MAX_CLOSED_CYCLES);
      for (let idx = startIdx; idx < currentMonthIdx; idx++) {
        closedKeys.push(getPeriodKey(Date.UTC(Math.floor(idx / 12), idx % 12, 1)));
      }
    }

    const closedCycles = closedKeys.map((key, i) => {
      const [y, m] = key.split('-').map(Number); // m is 1-based
      const issuedMs = Date.UTC(y, m, 1); // 1st of following month
      const dueMs = Date.UTC(y, m, 15);
      const isLatest = i === closedKeys.length - 1;
      const loadsWritten = byPeriod.get(key) ?? 0;
      return {
        periodKey: key,
        invoiceNo: platformInvoiceNumber(args.workosOrgId, key),
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
      // For the invoice BILL TO block.
      billingAddress: org?.billingAddress ?? null,
      billingPhone: org?.billingPhone ?? null,
      // Contract identity for the invoice details panel.
      contractNumber: org?.platformContractNumber ?? null,
      licenseStart: org?.platformLicenseStart ?? null,
      licenseEnd: org?.platformLicenseEnd ?? null,
      currentCycle,
      closedCycles,
    };
  },
});
