import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { getPeriodKey } from '../accountingStatsHelpers';

/**
 * orgHealthSnapshots builder — one row per organization, rebuilt every 15
 * minutes by the org-health-snapshots cron. The console's org directory
 * reads ONLY the snapshot table; this is the single place that touches
 * operational tables cross-org.
 *
 * Batched with cursor-based self-scheduling (same pattern as
 * platformUsage.recalculateAllOrgsPlatformUsage) so the transaction stays
 * bounded no matter how many orgs exist. Per-org reads are all
 * index-scoped; counts are capped at COUNT_CAP — the console displays
 * "500+" beyond that, which is all a health chip needs.
 */

const ORGS_PER_BATCH = 25;
const COUNT_CAP = 500;

export const rebuildAllOrgHealthSnapshots = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('organizations')
      .paginate({ cursor: args.cursor ?? null, numItems: ORGS_PER_BATCH });

    const now = Date.now();
    const currentPeriod = getPeriodKey(now);

    for (const org of page.page) {
      const workosOrgId = org.workosOrgId;

      const capped = async (n: Promise<unknown[]>) => Math.min((await n).length, COUNT_CAP);

      const memberCount = workosOrgId
        ? await capped(
            ctx.db
              .query('orgMembers')
              .withIndex('by_org_user', (q) => q.eq('organizationId', workosOrgId))
              .take(COUNT_CAP),
          )
        : 0;

      const driverCount = workosOrgId
        ? await capped(
            ctx.db
              .query('drivers')
              .withIndex('by_organization', (q) => q.eq('organizationId', workosOrgId))
              .take(COUNT_CAP),
          )
        : 0;

      // driverSessions.organizationId carries the same external org id
      // spelling the session was created under; workosOrgId covers the
      // web/dispatch-created population.
      const activeSessionCount = workosOrgId
        ? await capped(
            ctx.db
              .query('driverSessions')
              .withIndex('by_org_active', (q) =>
                q.eq('organizationId', workosOrgId).eq('status', 'active'),
              )
              .take(COUNT_CAP),
          )
        : 0;

      const usageRow = workosOrgId
        ? await ctx.db
            .query('platformUsageStats')
            .withIndex('by_org_period', (q) =>
              q.eq('workosOrgId', workosOrgId).eq('periodKey', currentPeriod),
            )
            .first()
        : null;

      const openDispatchAlerts = workosOrgId
        ? await capped(
            ctx.db
              .query('dispatchAlerts')
              .withIndex('by_org_status', (q) =>
                q.eq('orgExternalId', workosOrgId).eq('status', 'open'),
              )
              .take(COUNT_CAP),
          )
        : 0;

      const flagOverrideCount = workosOrgId
        ? await capped(
            ctx.db
              .query('featureFlags')
              .withIndex('by_org', (q) => q.eq('workosOrgId', workosOrgId))
              .take(COUNT_CAP),
          )
        : 0;

      const identityLinkCount = await capped(
        ctx.db
          .query('userIdentityLinks')
          .withIndex('by_org', (q) => q.eq('organizationId', org._id))
          .take(COUNT_CAP),
      );

      const snapshot = {
        organizationId: org._id,
        workosOrgId,
        name: org.name,
        orgType: org.orgType,
        isDeleted: org.isDeleted === true,
        memberCount,
        driverCount,
        activeSessionCount,
        loadsThisCycle: usageRow?.loadsWritten ?? 0,
        openDispatchAlerts,
        flagOverrideCount,
        identityLinkCount,
        updatedAt: now,
      };

      const existing = await ctx.db
        .query('orgHealthSnapshots')
        .withIndex('by_organization', (q) => q.eq('organizationId', org._id))
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, snapshot);
      } else {
        await ctx.db.insert('orgHealthSnapshots', snapshot);
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.platform.snapshots.rebuildAllOrgHealthSnapshots, {
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});
