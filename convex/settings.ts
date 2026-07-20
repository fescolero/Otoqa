import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { assertCallerOwnsOrg, requireCallerOrgId } from './lib/auth';
import { logAudit } from './lib/audit';
import { seedChargeComponentsLogic } from './payEngine/seedChargeComponents';
import { getPeriodKey } from './accountingStatsHelpers';
import { DEFAULT_BILLING_RATE_PER_LOAD } from './platformUsageHelpers';

const addressValidator = v.object({
  addressLine1: v.string(),
  addressLine2: v.optional(v.string()),
  city: v.string(),
  state: v.string(),
  zip: v.string(),
  country: v.string(),
});

const contactValidator = v.object({
  id: v.string(),
  role: v.string(),
  name: v.string(),
  email: v.string(),
  phone: v.string(),
});

/**
 * Settings Management for Multi-Tenant Organizations
 * Handles organization-level settings and user-specific preferences
 * Uses secure authentication via ctx.auth.getUserIdentity()
 */

/**
 * Step 1: Generate a signed URL for the frontend to upload the logo
 * The frontend will POST the file to this URL to get a storageId
 */
export const generateUploadUrl = mutation({
  handler: async (ctx) => {
    await requireCallerOrgId(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Fetch Organization Settings & Billing
 * Includes generating a temporary URL for the logo storage ID
 */
export const getOrgSettings = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const org = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .unique();

    if (!org) return null;

    // Convert storageId to a viewable URL
    let logoUrl = null;
    if (org.logoStorageId) {
      logoUrl = await ctx.storage.getUrl(org.logoStorageId);
    }

    return { ...org, logoUrl };
  },
});

/**
 * Update Org Info, Billing, and Logo storageId
 * Creates a new organization record if it doesn't exist
 * Logs all changes to the audit log
 */
export const updateOrgSettings = mutation({
  args: {
    workosOrgId: v.string(),
    updates: v.object({
      name: v.optional(v.string()),
      industry: v.optional(v.string()),
      domain: v.optional(v.string()),
      billingEmail: v.optional(v.string()),
      billingPhone: v.optional(v.string()),
      billingAddress: v.optional(addressValidator),
      // v.null() clears the stored value (Convex patch removes fields set
      // to undefined; args can't carry undefined, so null is the wire form).
      logoStorageId: v.optional(v.union(v.id('_storage'), v.null())),
      subscriptionPlan: v.optional(v.string()),
      subscriptionStatus: v.optional(v.string()),
      billingCycle: v.optional(v.string()),
      nextBillingDate: v.optional(v.string()),
      defaultTimezone: v.optional(v.string()),
      defaultCurrency: v.optional(
        v.union(v.literal('USD'), v.literal('CAD'), v.literal('MXN')),
      ),
      // Company profile (Settings → General)
      dba: v.optional(v.string()),
      entityType: v.optional(v.string()),
      usdotNumber: v.optional(v.string()),
      mcNumber: v.optional(v.string()),
      scacCode: v.optional(v.string()),
      mailingAddress: v.optional(v.union(addressValidator, v.null())),
      billingContactName: v.optional(v.string()),
      contacts: v.optional(v.array(contactValidator)),
      dateFormat: v.optional(v.string()),
      distanceUnit: v.optional(v.string()),
      weekStart: v.optional(v.string()),
      numberFormat: v.optional(v.string()),
      // Empty string / null reverts to the default "INV-" prefix.
      invoicePrefix: v.optional(v.union(v.string(), v.null())),
    }),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    // assertCallerOwnsOrg already throws on unauthenticated, so identity is non-null
    const identity = (await ctx.auth.getUserIdentity())!;

    // null means "clear this field" — Convex removes fields patched to
    // undefined. Only rewrite keys the caller actually sent; materializing
    // absent keys as undefined would silently clear them on every save.
    const { logoStorageId, mailingAddress, invoicePrefix, ...restUpdates } = args.updates;

    let normalizedPrefix: string | undefined;
    if (typeof invoicePrefix === 'string' && invoicePrefix.trim() !== '') {
      normalizedPrefix = invoicePrefix.trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(normalizedPrefix)) {
        throw new Error('Invoice prefix must be 1–12 letters, numbers, or dashes');
      }
    }

    const updates = {
      ...restUpdates,
      ...(logoStorageId !== undefined
        ? { logoStorageId: logoStorageId === null ? undefined : logoStorageId }
        : {}),
      ...(mailingAddress !== undefined
        ? { mailingAddress: mailingAddress === null ? undefined : mailingAddress }
        : {}),
      ...(invoicePrefix !== undefined ? { invoicePrefix: normalizedPrefix } : {}),
    };

    const existing = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .unique();

    if (!existing) {
      // Create new organization record with defaults
      // Web TMS users are BROKER type by default (WorkOS auth)
      const orgId = await ctx.db.insert('organizations', {
        ...updates,
        workosOrgId: args.workosOrgId,
        orgType: 'BROKER', // Default for web TMS (WorkOS) users
        name: updates.name ?? 'Unnamed Organization',
        billingEmail: updates.billingEmail ?? identity.email ?? '',
        billingAddress: updates.billingAddress ?? {
          addressLine1: '',
          city: '',
          state: '',
          zip: '',
          country: 'USA',
        },
        subscriptionPlan: updates.subscriptionPlan ?? 'Enterprise',
        subscriptionStatus: updates.subscriptionStatus ?? 'Active',
        billingCycle: updates.billingCycle ?? 'Annual',
        defaultTimezone: updates.defaultTimezone ?? 'America/New_York',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Audit Log Entry
      await logAudit(ctx, {
        organizationId: args.workosOrgId,
        entityType: 'organization',
        entityId: orgId,
        action: 'created',
        description: 'Created organization settings',
        performedBy: identity.subject,
        performedByEmail: identity.email ?? undefined,
        performedByName: identity.name ?? undefined,
      });

      // Seed pay-engine chargeComponents catalog. Idempotent — re-runs skip
      // existing rows by templateId — so this is safe even if the seeder is
      // also invoked later via the admin refresh path.
      await seedChargeComponentsLogic(ctx, {
        workosOrgId: args.workosOrgId,
        createdBy: identity.subject,
      });

      return orgId;
    }

    // Update existing organization
    await ctx.db.patch(existing._id, {
      ...updates,
      updatedAt: Date.now(),
    });

    // Audit Log Entry
    await logAudit(ctx, {
      organizationId: args.workosOrgId,
      entityType: 'organization',
      entityId: existing._id,
      action: 'updated',
      description: 'Updated organization settings',
      performedBy: identity.subject,
      performedByEmail: identity.email ?? undefined,
      performedByName: identity.name ?? undefined,
      changedFields: Object.keys(args.updates),
    });

    return existing._id;
  },
});

/**
 * Workspace-at-a-glance for Settings → General: fleet counts, loads written
 * this billing cycle, the org's metered rate, and the next invoice number
 * the numbering sequence will issue (INV-YYYY-NNNN, per convex/invoices.ts
 * claimInvoiceNumber).
 */
export const getWorkspaceSummary = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const org = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .unique();

    // Fleet counts — bounded by real fleet sizes (dozens–hundreds of rows).
    const [drivers, trucks] = await Promise.all([
      ctx.db
        .query('drivers')
        .withIndex('by_organization', (q) => q.eq('organizationId', args.workosOrgId))
        .collect(),
      ctx.db
        .query('trucks')
        .withIndex('by_organization', (q) => q.eq('organizationId', args.workosOrgId))
        .collect(),
    ]);

    const now = Date.now();
    const currentPeriodKey = getPeriodKey(now);
    const usage = await ctx.db
      .query('platformUsageStats')
      .withIndex('by_org_period', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('periodKey', currentPeriodKey),
      )
      .first();

    const year = new Date(now).getUTCFullYear();
    const counter = await ctx.db
      .query('invoiceCounters')
      .withIndex('by_org_year', (q) => q.eq('workosOrgId', args.workosOrgId).eq('year', year))
      .first();
    const nextSeq = counter?.nextSeq ?? 1;
    const prefix = org?.invoicePrefix ?? 'INV-';

    return {
      driverCount: drivers.filter((d) => !d.isDeleted).length,
      truckCount: trucks.filter((t) => !t.isDeleted).length,
      loadsThisCycle: usage?.loadsWritten ?? 0,
      ratePerLoad: org?.billingRatePerLoad ?? DEFAULT_BILLING_RATE_PER_LOAD,
      invoicePrefix: prefix,
      nextInvoiceNumber: `${prefix}${year}-${String(nextSeq).padStart(4, '0')}`,
    };
  },
});

/**
 * Get User-Specific Preferences (Theme, Language, Units, Timezone)
 * Returns null if no preferences are set (frontend should use defaults)
 */
export const getUserPreferences = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const identity = (await ctx.auth.getUserIdentity())!;

    return await ctx.db
      .query('userPreferences')
      .withIndex('by_user_org', (q) =>
        q.eq('userId', identity.subject).eq('workosOrgId', args.workosOrgId),
      )
      .unique();
  },
});

/**
 * Update User Preferences (Upsert)
 * Creates a new record if it doesn't exist, otherwise updates
 */
export const updateUserPreferences = mutation({
  args: {
    workosOrgId: v.string(),
    theme: v.union(v.literal('light'), v.literal('dark'), v.literal('system')),
    language: v.string(),
    unitSystem: v.union(v.literal('Imperial'), v.literal('Metric')),
    timezone: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const identity = (await ctx.auth.getUserIdentity())!;

    const existing = await ctx.db
      .query('userPreferences')
      .withIndex('by_user_org', (q) =>
        q.eq('userId', identity.subject).eq('workosOrgId', args.workosOrgId),
      )
      .unique();

    const data = {
      userId: identity.subject,
      workosOrgId: args.workosOrgId,
      theme: args.theme,
      language: args.language,
      unitSystem: args.unitSystem,
      timezone: args.timezone,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, data);
      return existing._id;
    } else {
      return await ctx.db.insert('userPreferences', data);
    }
  },
});

/**
 * Update UI Shell Preferences (theme / density / sidebar mode).
 *
 * Granular partner to updateUserPreferences — used by the Otoqa Web shell
 * (Topbar density toggle, Sidebar pin/rail). Each field is optional so the
 * caller can patch one without supplying the others. Creates a row with
 * sensible defaults if none exists yet.
 */
export const updateUiPreferences = mutation({
  args: {
    workosOrgId: v.string(),
    theme: v.optional(v.union(v.literal('light'), v.literal('dark'), v.literal('system'))),
    density: v.optional(v.union(v.literal('compact'), v.literal('comfortable'))),
    sidebarMode: v.optional(
      v.union(v.literal('hover'), v.literal('pinned'), v.literal('rail')),
    ),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const identity = (await ctx.auth.getUserIdentity())!;

    const existing = await ctx.db
      .query('userPreferences')
      .withIndex('by_user_org', (q) =>
        q.eq('userId', identity.subject).eq('workosOrgId', args.workosOrgId),
      )
      .unique();

    if (existing) {
      const patch: Record<string, unknown> = { updatedAt: Date.now() };
      if (args.theme !== undefined) patch.theme = args.theme;
      if (args.density !== undefined) patch.density = args.density;
      if (args.sidebarMode !== undefined) patch.sidebarMode = args.sidebarMode;
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert('userPreferences', {
      userId: identity.subject,
      workosOrgId: args.workosOrgId,
      // Defaults for required fields when no row exists yet — caller can
      // refine via updateUserPreferences. These match the shell's default
      // appearance.
      language: 'English',
      unitSystem: 'Imperial',
      timezone: 'America/Los_Angeles',
      theme: args.theme ?? 'light',
      density: args.density ?? 'compact',
      sidebarMode: args.sidebarMode ?? 'pinned',
      updatedAt: Date.now(),
    });
  },
});
