import { v } from 'convex/values';
import { query } from '../_generated/server';
import { requirePlatformStaff } from '../lib/auth';

/**
 * Platform console — organization directory & detail. Staff-only
 * (requirePlatformStaff first in every function; see platform/access.ts
 * for the namespace contract).
 *
 * The directory reads ONLY orgHealthSnapshots (cron-built). The detail
 * page does targeted, index-scoped reads for ONE org — that's the
 * sanctioned shape for platform reads of operational tables.
 */

export const listOrgs = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    // Bounded: one row per org.
    return await ctx.db.query('orgHealthSnapshots').collect();
  },
});

export const getOrgDetail = query({
  args: { organizationId: v.id('organizations') },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);

    const org = await ctx.db.get(args.organizationId);
    if (!org) return null;

    const snapshot = await ctx.db
      .query('orgHealthSnapshots')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.organizationId))
      .unique();

    const workosOrgId = org.workosOrgId;

    const members = workosOrgId
      ? await ctx.db
          .query('orgMembers')
          .withIndex('by_org_user', (q) => q.eq('organizationId', workosOrgId))
          .take(100)
      : [];

    const identityLinks = await ctx.db
      .query('userIdentityLinks')
      .withIndex('by_org', (q) => q.eq('organizationId', args.organizationId))
      .take(100);

    const flags = workosOrgId
      ? await ctx.db
          .query('featureFlags')
          .withIndex('by_org', (q) => q.eq('workosOrgId', workosOrgId))
          .collect()
      : [];

    const usage = workosOrgId
      ? await ctx.db
          .query('platformUsageStats')
          .withIndex('by_org', (q) => q.eq('workosOrgId', workosOrgId))
          .collect()
      : [];
    usage.sort((a, b) => a.periodKey.localeCompare(b.periodKey));

    const recentAudit = workosOrgId
      ? await ctx.db
          .query('auditLog')
          .withIndex('by_organization', (q) => q.eq('organizationId', workosOrgId))
          .order('desc')
          .take(20)
      : [];

    const fkTickHealth = workosOrgId
      ? await ctx.db
          .query('fourKitesPushTickHealth')
          .withIndex('by_org', (q) => q.eq('workosOrgId', workosOrgId))
          .unique()
      : null;

    return {
      org: {
        _id: org._id,
        name: org.name,
        orgType: org.orgType,
        workosOrgId: org.workosOrgId,
        clerkOrgId: org.clerkOrgId,
        isDeleted: org.isDeleted === true,
        billingEmail: org.billingEmail,
        billingRatePerLoad: org.billingRatePerLoad,
        rateSchedule: org.rateSchedule,
        billingTerms: org.billingTerms,
        taxRatePercent: org.taxRatePercent,
        taxJurisdiction: org.taxJurisdiction,
        minimumMonthlyCharge: org.minimumMonthlyCharge,
        recurringCharges: org.recurringCharges,
        platformContractNumber: org.platformContractNumber,
        platformLicenseStart: org.platformLicenseStart,
        platformLicenseEnd: org.platformLicenseEnd,
        createdAt: org.createdAt,
      },
      snapshot,
      members: members.map((m) => ({
        workosUserId: m.workosUserId,
        firstName: m.firstName,
        lastName: m.lastName,
        email: m.email,
      })),
      identityLinks: identityLinks.map((l) => ({
        _id: l._id,
        clerkUserId: l.clerkUserId,
        workosUserId: l.workosUserId,
        role: l.role,
        phone: l.phone,
        email: l.email,
      })),
      flags,
      usage: usage.slice(-12),
      recentAudit: recentAudit.map((a) => ({
        _id: a._id,
        entityType: a.entityType,
        entityName: a.entityName,
        action: a.action,
        performedByName: a.performedByName,
        performedByEmail: a.performedByEmail,
        timestamp: a.timestamp,
      })),
      fkTickHealth,
    };
  },
});
