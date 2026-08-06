import { query } from '../_generated/server';
import { requirePlatformStaff } from '../lib/auth';
import { DEFAULT_BILLING_RATE_PER_LOAD } from '../platformUsageHelpers';
import { getPeriodKey } from '../accountingStatsHelpers';

/**
 * Platform console — cross-org revenue overview. Staff-only. Reads
 * platformUsageStats (one row per org × month — small by construction)
 * plus the organizations table for names/rates. Amounts for CLOSED cycles
 * here are informational (usage × current rate); once platformInvoices
 * exist (Phase 3) closed cycles render from frozen invoices instead —
 * this query is explicit about that with `amountsAreDerived: true`.
 */

const MONTHS_BACK = 12;

export const revenueOverview = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);

    const orgs = await ctx.db.query('organizations').collect();
    const orgByWorkosId = new Map(
      orgs
        .filter((o) => typeof o.workosOrgId === 'string' && o.workosOrgId)
        .map((o) => [o.workosOrgId as string, o]),
    );

    const now = Date.now();
    const currentPeriod = getPeriodKey(now);

    // Window: the last MONTHS_BACK closed cycles + the open one.
    const periods: string[] = [];
    {
      const d = new Date(now);
      let y = d.getUTCFullYear();
      let m = d.getUTCMonth(); // 0-based
      for (let i = 0; i <= MONTHS_BACK; i++) {
        periods.unshift(`${y}-${String(m + 1).padStart(2, '0')}`);
        m -= 1;
        if (m < 0) {
          m = 11;
          y -= 1;
        }
      }
    }
    const windowStart = periods[0];

    const monthly = new Map<string, { loads: number; amount: number }>(
      periods.map((p) => [p, { loads: 0, amount: 0 }]),
    );
    const currentCycleByOrg: {
      organizationId: string;
      name: string;
      loads: number;
      rate: number;
      amount: number;
    }[] = [];

    for (const [workosOrgId, org] of orgByWorkosId) {
      const rate = org.billingRatePerLoad ?? DEFAULT_BILLING_RATE_PER_LOAD;
      const rows = await ctx.db
        .query('platformUsageStats')
        .withIndex('by_org', (q) => q.eq('workosOrgId', workosOrgId))
        .collect();

      for (const row of rows) {
        if (row.periodKey < windowStart || row.periodKey > currentPeriod) continue;
        const bucket = monthly.get(row.periodKey);
        if (bucket) {
          bucket.loads += row.loadsWritten;
          bucket.amount += row.loadsWritten * rate;
        }
        if (row.periodKey === currentPeriod && row.loadsWritten > 0) {
          currentCycleByOrg.push({
            organizationId: org._id,
            name: org.name,
            loads: row.loadsWritten,
            rate,
            amount: row.loadsWritten * rate,
          });
        }
      }
    }

    currentCycleByOrg.sort((a, b) => b.amount - a.amount);

    return {
      amountsAreDerived: true, // becomes false when Phase 3 invoices land
      currentPeriod,
      months: periods.map((p) => ({
        periodKey: p,
        isOpenCycle: p === currentPeriod,
        loads: monthly.get(p)!.loads,
        amount: Math.round(monthly.get(p)!.amount * 100) / 100,
      })),
      currentCycleTopOrgs: currentCycleByOrg.slice(0, 15),
      billableOrgCount: orgByWorkosId.size,
      defaultRate: DEFAULT_BILLING_RATE_PER_LOAD,
    };
  },
});
