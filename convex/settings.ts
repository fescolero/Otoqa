import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { assertCallerOwnsOrg, requireCallerOrgId } from './lib/auth';
import { logAudit } from './lib/audit';
import { seedChargeComponentsLogic } from './payEngine/seedChargeComponents';

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
      billingAddress: v.optional(
        v.object({
          addressLine1: v.string(),
          addressLine2: v.optional(v.string()),
          city: v.string(),
          state: v.string(),
          zip: v.string(),
          country: v.string(),
        }),
      ),
      logoStorageId: v.optional(v.id('_storage')),
      subscriptionPlan: v.optional(v.string()),
      subscriptionStatus: v.optional(v.string()),
      billingCycle: v.optional(v.string()),
      nextBillingDate: v.optional(v.string()),
      defaultTimezone: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    // assertCallerOwnsOrg already throws on unauthenticated, so identity is non-null
    const identity = (await ctx.auth.getUserIdentity())!;

    const existing = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .unique();

    if (!existing) {
      // Create new organization record with defaults
      // Web TMS users are BROKER type by default (WorkOS auth)
      const orgId = await ctx.db.insert('organizations', {
        workosOrgId: args.workosOrgId,
        orgType: 'BROKER', // Default for web TMS (WorkOS) users
        name: args.updates.name ?? 'Unnamed Organization',
        industry: args.updates.industry,
        domain: args.updates.domain,
        logoStorageId: args.updates.logoStorageId,
        billingEmail: args.updates.billingEmail ?? identity.email ?? '',
        billingPhone: args.updates.billingPhone,
        billingAddress: args.updates.billingAddress ?? {
          addressLine1: '',
          city: '',
          state: '',
          zip: '',
          country: 'USA',
        },
        subscriptionPlan: args.updates.subscriptionPlan ?? 'Enterprise',
        subscriptionStatus: args.updates.subscriptionStatus ?? 'Active',
        billingCycle: args.updates.billingCycle ?? 'Annual',
        nextBillingDate: args.updates.nextBillingDate,
        defaultTimezone: args.updates.defaultTimezone ?? 'America/New_York',
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
      ...args.updates,
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
