import { v } from 'convex/values';
import { mutation, query } from './_generated/server';

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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Unauthenticated');
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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Unauthenticated');

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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Unauthenticated');

    const existing = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .unique();

    if (!existing) {
      // Create new organization record with defaults
      const orgId = await ctx.db.insert('organizations', {
        workosOrgId: args.workosOrgId,
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
      await ctx.db.insert('auditLog', {
        organizationId: args.workosOrgId,
        entityType: 'organization',
        entityId: orgId,
        action: 'created',
        description: 'Created organization settings',
        performedBy: identity.subject,
        performedByEmail: identity.email ?? undefined,
        performedByName: identity.name ?? undefined,
        timestamp: Date.now(),
      });

      return orgId;
    }

    // Update existing organization
    await ctx.db.patch(existing._id, {
      ...args.updates,
      updatedAt: Date.now(),
    });

    // Audit Log Entry
    await ctx.db.insert('auditLog', {
      organizationId: args.workosOrgId,
      entityType: 'organization',
      entityId: existing._id,
      action: 'updated',
      description: 'Updated organization settings',
      performedBy: identity.subject,
      performedByEmail: identity.email ?? undefined,
      performedByName: identity.name ?? undefined,
      changedFields: Object.keys(args.updates),
      timestamp: Date.now(),
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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Unauthenticated');

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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Unauthenticated');

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
