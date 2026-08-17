import { query } from '../_generated/server';
import { requirePlatformStaff } from '../lib/auth';
import { getPeriodKey } from '../accountingStatsHelpers';

/**
 * The four numbers at the top of the Overview: what the platform is doing
 * right now, in one query.
 *
 * Sourced from `orgHealthSnapshots`, which the snapshot cron rebuilds every 15
 * minutes. That staleness is real and the console says so rather than letting
 * a figure imply it is live — an operator who doesn't know a number's age
 * can't act on it.
 */
export const platformPulse = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    const now = Date.now();

    // One row per org, so this is bounded by the customer count.
    const snapshots = await ctx.db.query('orgHealthSnapshots').collect();
    const live = snapshots.filter((s) => !s.isDeleted);

    // How far through the billing cycle we are. This is the denominator that
    // makes "loads this cycle" mean something: 1,400 loads on the 2nd and
    // 1,400 loads on the 28th are very different numbers.
    const period = new Date(now);
    const startOfCycle = Date.UTC(period.getUTCFullYear(), period.getUTCMonth(), 1);
    const endOfCycle = Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 1, 1);
    const cycleProgress = (now - startOfCycle) / (endOfCycle - startOfCycle);

    const oldestSnapshot = live.reduce<number | null>(
      (oldest, s) => (oldest === null || s.updatedAt < oldest ? s.updatedAt : oldest),
      null,
    );

    return {
      periodKey: getPeriodKey(now),
      cycleProgress,
      // Null when no snapshot exists at all — the panel then says the cron has
      // never run rather than reporting a confident zero.
      snapshotAt: oldestSnapshot,
      orgCount: live.length,
      loadsThisCycle: live.reduce((sum, s) => sum + s.loadsThisCycle, 0),
      activeDriverShifts: live.reduce((sum, s) => sum + s.activeSessionCount, 0),
      driverCount: live.reduce((sum, s) => sum + s.driverCount, 0),
      openDispatchAlerts: live.reduce((sum, s) => sum + s.openDispatchAlerts, 0),
    };
  },
});
