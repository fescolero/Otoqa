import { v } from 'convex/values';
import { query } from '../_generated/server';
import type { QueryCtx } from '../_generated/server';
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

/**
 * Who is OURS.
 *
 * `BROKER` and `BROKER_CARRIER` orgs are Otoqa's customers: they hold the
 * contract, they accrue metered usage, they get invoiced. A plain `CARRIER`
 * org is a carrier a broker onboarded — the broker's counterparty, on the
 * mobile app, billed by nobody here. Its name, driver count and load volume
 * are the BROKER'S client data, and this console has no business listing them
 * beside our own customers.
 *
 * Enforced server-side rather than filtered in the UI, so the rows never cross
 * the wire, and applied to getOrgDetail as well — a URL is not a permission,
 * and a directory filter alone would be decoration.
 */
const CLIENT_ORG_TYPES = new Set(['BROKER', 'BROKER_CARRIER']);

/**
 * The type field is the RULE, not the whole test.
 *
 * Two orgs must never be hidden regardless of what `orgType` says:
 *
 *  - One with **no type recorded**. Absent is not the same as `CARRIER`, and a
 *    missing type is a data gap staff need to see and fix. It renders with a
 *    `—` type, which is the signal.
 *  - One we have **actually billed**. If an invoice exists against an org then
 *    it is a paying customer whatever its label, and a mistyped row must not
 *    take a live account off the board — the account whose receivables the
 *    billing page is tracking would vanish from the directory while its
 *    outstanding balance kept showing up in aging.
 *
 * So the filter can only ever hide an org that is BOTH typed `CARRIER` AND has
 * never been invoiced, which is exactly the population meant.
 */
function isClientOrg(orgType: string | undefined, hasBeenInvoiced: boolean): boolean {
  if (orgType === undefined) return true;
  if (CLIENT_ORG_TYPES.has(orgType)) return true;
  return hasBeenInvoiced;
}

/** WorkOS org ids we have ever raised an invoice against. */
const INVOICE_SCAN = 2000;
async function invoicedOrgIds(ctx: QueryCtx): Promise<Set<string>> {
  const rows = await ctx.db.query('platformInvoices').take(INVOICE_SCAN);
  return new Set(rows.map((r) => r.workosOrgId));
}

export const listOrgs = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    // Bounded: one row per org.
    const all = await ctx.db.query('orgHealthSnapshots').collect();
    const invoiced = await invoicedOrgIds(ctx);
    const rows = all.filter((o) =>
      isClientOrg(o.orgType, o.workosOrgId != null && invoiced.has(o.workosOrgId)),
    );
    return {
      rows,
      // Said out loud rather than silently dropped: a directory that hides
      // rows without saying how many reads as a complete list.
      hiddenCarrierCount: all.length - rows.length,
    };
  },
});

export const getOrgDetail = query({
  args: { organizationId: v.id('organizations') },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);

    const org = await ctx.db.get(args.organizationId);
    if (!org) return null;
    // Same rule as the directory. Reached by URL, this is the only thing
    // standing between a broker's carrier and a staff screen.
    const everInvoiced =
      org.workosOrgId != null &&
      (await ctx.db
        .query('platformInvoices')
        .withIndex('by_org_period', (q) => q.eq('workosOrgId', org.workosOrgId!))
        .first()) !== null;
    if (!isClientOrg(org.orgType, everInvoiced)) return null;

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

    // Read-only "view as org" slice (Phase 4): the org's most recent loads
    // as the tenant would see them listed. Targeted, bounded, staff-gated —
    // NOT a reuse of tenant queries (those derive org from the caller).
    const recentLoads = workosOrgId
      ? (
          await ctx.db
            .query('loadInformation')
            .withIndex('by_organization', (q) => q.eq('workosOrgId', workosOrgId))
            .order('desc')
            .take(25)
        ).map((l) => ({
          _id: l._id,
          internalId: l.internalId,
          status: l.status,
          firstStopDate: l.firstStopDate,
          createdAt: l.createdAt ?? l._creationTime,
        }))
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
        // Contact fields are editable from the console's contract panel, so
        // they have to be readable there too.
        billingContactName: org.billingContactName,
        billingPhone: org.billingPhone,
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
      recentLoads,
    };
  },
});
