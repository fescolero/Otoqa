import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';

// Helper function to determine expiration status
const getExpirationStatus = (dateString?: string) => {
  if (!dateString) return 'unknown';
  
  const date = new Date(dateString);
  date.setHours(0, 0, 0, 0);
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const diffTime = date.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays < 0) return 'expired';
  if (diffDays <= 30) return 'expiring';
  return 'valid';
};

// Count carriers by status for tab badges
export const countCarriersByStatus = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const carriers = await ctx.db
      .query('carriers')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    const counts = {
      all: 0,
      active: 0,
      vetting: 0,
      insuranceExpiring: 0,
      suspended: 0,
      inactive: 0,
      deleted: 0,
    };

    carriers.forEach((carrier) => {
      if (carrier.isDeleted) {
        counts.deleted++;
      } else {
        counts.all++;
        if (carrier.status === 'Active') counts.active++;
        else if (carrier.status === 'Vetting') counts.vetting++;
        else if (carrier.status === 'Suspended') counts.suspended++;
        else if (carrier.status === 'Inactive') counts.inactive++;
        
        // Check if insurance is expiring
        const insuranceStatus = getExpirationStatus(carrier.insuranceExpiration);
        if (insuranceStatus === 'expired' || insuranceStatus === 'expiring') {
          counts.insuranceExpiring++;
        }
      }
    });

    return counts;
  },
});

// Get all carriers for an organization with filtering
export const list = query({
  args: {
    workosOrgId: v.string(),
    includeDeleted: v.optional(v.boolean()),
    includeSensitive: v.optional(v.boolean()),
    // Filters
    search: v.optional(v.string()),
    status: v.optional(v.string()),
    insuranceStatus: v.optional(v.string()),
    safetyRating: v.optional(v.string()),
    state: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let carriers = await ctx.db
      .query('carriers')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    // Filter out soft-deleted carriers unless explicitly requested
    if (!args.includeDeleted) {
      carriers = carriers.filter((carrier) => !carrier.isDeleted);
    }

    // Apply search filter
    if (args.search) {
      const searchLower = args.search.toLowerCase();
      carriers = carriers.filter(
        (carrier) =>
          carrier.companyName.toLowerCase().includes(searchLower) ||
          carrier.dba?.toLowerCase().includes(searchLower) ||
          carrier.email?.toLowerCase().includes(searchLower) ||
          carrier.mcNumber?.toLowerCase().includes(searchLower) ||
          carrier.usdotNumber?.toLowerCase().includes(searchLower)
      );
    }

    // Apply status filter
    if (args.status) {
      carriers = carriers.filter((carrier) => carrier.status === args.status);
    }

    // Apply insurance status filter
    if (args.insuranceStatus) {
      carriers = carriers.filter((carrier) => {
        const status = getExpirationStatus(carrier.insuranceExpiration);
        return status === args.insuranceStatus;
      });
    }

    // Apply safety rating filter
    if (args.safetyRating) {
      carriers = carriers.filter((carrier) => carrier.safetyRating === args.safetyRating);
    }

    // Apply state filter
    if (args.state) {
      carriers = carriers.filter((carrier) => carrier.state === args.state);
    }

    const filteredCarriers = carriers;

    // If sensitive data is not requested, return only non-sensitive data
    if (!args.includeSensitive) {
      return filteredCarriers;
    }

    // Fetch all sensitive info for this organization
    const sensitiveInfos = await ctx.db
      .query('carriers_sensitive_info')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    // Create a map for quick lookup
    const sensitiveMap = new Map(
      sensitiveInfos.map((info) => [info.carrierInternalId, info])
    );

    // Combine carriers with their sensitive info
    return filteredCarriers.map((carrier) => {
      const sensitiveInfo = sensitiveMap.get(carrier._id);
      return {
        ...carrier,
        ein: sensitiveInfo?.ein,
        insuranceCargoAmount: sensitiveInfo?.insuranceCargoAmount,
        insuranceLiabilityAmount: sensitiveInfo?.insuranceLiabilityAmount,
        paymentTerms: sensitiveInfo?.paymentTerms,
        factoringStatus: sensitiveInfo?.factoringStatus,
        remitToAddress: sensitiveInfo?.remitToAddress,
      };
    });
  },
});

// Get active carriers for dispatch planner (lightweight query)
export const getActiveCarriers = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    const carriers = await ctx.db
      .query('carriers')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .filter((q) =>
        q.and(
          q.neq(q.field('isDeleted'), true),
          q.eq(q.field('status'), 'Active')
        )
      )
      .collect();

    // Return only fields needed for dispatch planner
    return carriers.map((carrier) => ({
      _id: carrier._id,
      companyName: carrier.companyName,
      mcNumber: carrier.mcNumber,
      firstName: carrier.firstName,
      lastName: carrier.lastName,
      phoneNumber: carrier.phoneNumber,
      email: carrier.email,
      city: carrier.city,
      state: carrier.state,
      status: carrier.status,
    }));
  },
});

// Get a single carrier by ID
export const get = query({
  args: {
    id: v.id('carriers'),
    includeSensitive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const carrier = await ctx.db.get(args.id);
    if (!carrier) return null;

    // If sensitive data is not requested, return only non-sensitive data
    if (!args.includeSensitive) {
      return carrier;
    }

    // Fetch sensitive data
    const sensitiveInfo = await ctx.db
      .query('carriers_sensitive_info')
      .withIndex('by_carrier', (q) => q.eq('carrierInternalId', args.id))
      .first();

    // Combine carrier data with sensitive info
    return {
      ...carrier,
      ein: sensitiveInfo?.ein,
      insuranceCargoAmount: sensitiveInfo?.insuranceCargoAmount,
      insuranceLiabilityAmount: sensitiveInfo?.insuranceLiabilityAmount,
      paymentTerms: sensitiveInfo?.paymentTerms,
      factoringStatus: sensitiveInfo?.factoringStatus,
      remitToAddress: sensitiveInfo?.remitToAddress,
    };
  },
});

// Create a new carrier
export const create = mutation({
  args: {
    // Company Information
    companyName: v.string(),
    dba: v.optional(v.string()),
    // Contact Information
    firstName: v.string(),
    lastName: v.string(),
    email: v.string(),
    phoneNumber: v.string(),
    // Address
    addressLine: v.string(),
    addressLine2: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    country: v.optional(v.string()),
    // Operating Authority
    mcNumber: v.string(),
    usdotNumber: v.optional(v.string()),
    dotRegistration: v.optional(v.boolean()),
    operatingAuthorityActive: v.optional(v.boolean()),
    safetyRating: v.optional(v.string()),
    // Insurance
    insuranceProvider: v.string(),
    insuranceCoverage: v.boolean(),
    insuranceExpiration: v.string(),
    // Sensitive Information
    ein: v.optional(v.string()),
    insuranceCargoAmount: v.optional(v.number()),
    insuranceLiabilityAmount: v.optional(v.number()),
    paymentTerms: v.optional(v.string()),
    factoringStatus: v.optional(v.boolean()),
    remitToAddress: v.optional(v.string()),
    // Status & Metadata
    internalId: v.string(),
    status: v.string(),
    currency: v.optional(v.string()),
    // WorkOS Integration
    workosOrgId: v.string(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Separate sensitive and non-sensitive data
    const {
      ein,
      insuranceCargoAmount,
      insuranceLiabilityAmount,
      paymentTerms,
      factoringStatus,
      remitToAddress,
      ...nonSensitiveData
    } = args;

    // Insert non-sensitive data into carriers table
    const carrierId = await ctx.db.insert('carriers', {
      ...nonSensitiveData,
      createdAt: now,
      updatedAt: now,
    });

    // Insert sensitive data into carriers_sensitive_info table
    await ctx.db.insert('carriers_sensitive_info', {
      carrierInternalId: carrierId,
      ein,
      insuranceCargoAmount,
      insuranceLiabilityAmount,
      paymentTerms,
      factoringStatus,
      remitToAddress,
      workosOrgId: args.workosOrgId,
      createdAt: now,
      updatedAt: now,
    });

    // Log the creation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.workosOrgId,
      entityType: 'carrier',
      entityId: carrierId,
      entityName: args.companyName,
      action: 'created',
      performedBy: args.createdBy,
      description: `Created carrier ${args.companyName}`,
    });

    return carrierId;
  },
});

// Update a carrier
export const update = mutation({
  args: {
    id: v.id('carriers'),
    // Audit fields
    userId: v.optional(v.string()),
    userName: v.optional(v.string()),
    workosOrgId: v.optional(v.string()),
    // Company Information
    companyName: v.optional(v.string()),
    dba: v.optional(v.string()),
    // Contact Information
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
    phoneNumber: v.optional(v.string()),
    // Address
    addressLine: v.optional(v.string()),
    addressLine2: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    country: v.optional(v.string()),
    // Operating Authority
    mcNumber: v.optional(v.string()),
    usdotNumber: v.optional(v.string()),
    dotRegistration: v.optional(v.boolean()),
    operatingAuthorityActive: v.optional(v.boolean()),
    safetyRating: v.optional(v.string()),
    // Insurance
    insuranceProvider: v.optional(v.string()),
    insuranceCoverage: v.optional(v.boolean()),
    insuranceExpiration: v.optional(v.string()),
    // Sensitive Information
    ein: v.optional(v.string()),
    insuranceCargoAmount: v.optional(v.number()),
    insuranceLiabilityAmount: v.optional(v.number()),
    paymentTerms: v.optional(v.string()),
    factoringStatus: v.optional(v.boolean()),
    remitToAddress: v.optional(v.string()),
    // Status & Metadata
    internalId: v.optional(v.string()),
    status: v.optional(v.string()),
    currency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const {
      id,
      userId,
      userName,
      workosOrgId,
      ein,
      insuranceCargoAmount,
      insuranceLiabilityAmount,
      paymentTerms,
      factoringStatus,
      remitToAddress,
      ...updates
    } = args;

    // Get current carrier data for audit log
    const carrier = await ctx.db.get(id);
    if (!carrier) throw new Error('Carrier not found');

    const now = Date.now();

    // Separate sensitive and non-sensitive updates
    const sensitiveUpdates: {
      ein?: string;
      insuranceCargoAmount?: number;
      insuranceLiabilityAmount?: number;
      paymentTerms?: string;
      factoringStatus?: boolean;
      remitToAddress?: string;
      updatedAt: number;
    } = { updatedAt: now };

    const hasSensitiveUpdates =
      ein !== undefined ||
      insuranceCargoAmount !== undefined ||
      insuranceLiabilityAmount !== undefined ||
      paymentTerms !== undefined ||
      factoringStatus !== undefined ||
      remitToAddress !== undefined;

    if (ein !== undefined) sensitiveUpdates.ein = ein;
    if (insuranceCargoAmount !== undefined) sensitiveUpdates.insuranceCargoAmount = insuranceCargoAmount;
    if (insuranceLiabilityAmount !== undefined)
      sensitiveUpdates.insuranceLiabilityAmount = insuranceLiabilityAmount;
    if (paymentTerms !== undefined) sensitiveUpdates.paymentTerms = paymentTerms;
    if (factoringStatus !== undefined) sensitiveUpdates.factoringStatus = factoringStatus;
    if (remitToAddress !== undefined) sensitiveUpdates.remitToAddress = remitToAddress;

    // Update non-sensitive data in carriers table
    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(id, {
        ...updates,
        updatedAt: now,
      });
    }

    // Update sensitive data in carriers_sensitive_info table
    if (hasSensitiveUpdates) {
      const sensitiveInfo = await ctx.db
        .query('carriers_sensitive_info')
        .withIndex('by_carrier', (q) => q.eq('carrierInternalId', id))
        .first();

      if (sensitiveInfo) {
        await ctx.db.patch(sensitiveInfo._id, sensitiveUpdates);
      }
    }

    // Log the update if audit info provided
    if (userId && workosOrgId) {
      const allUpdates = { ...updates, ...sensitiveUpdates };
      const changedFields = Object.keys(allUpdates).filter((key) => key !== 'updatedAt');
      await ctx.runMutation(internal.auditLog.logAction, {
        organizationId: workosOrgId,
        entityType: 'carrier',
        entityId: id,
        entityName: carrier.companyName,
        action: 'updated',
        performedBy: userId,
        performedByName: userName,
        description: `Updated carrier ${carrier.companyName}`,
        changedFields,
        changesAfter: JSON.stringify(allUpdates),
      });
    }

    return id;
  },
});

// Soft delete (deactivate) a carrier
export const deactivate = mutation({
  args: {
    id: v.id('carriers'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get carrier data before deactivation
    const carrier = await ctx.db.get(args.id);
    if (!carrier) throw new Error('Carrier not found');

    await ctx.db.patch(args.id, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: args.userId,
      status: 'Inactive',
      updatedAt: Date.now(),
    });

    // Log the deactivation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: carrier.workosOrgId,
      entityType: 'carrier',
      entityId: args.id,
      entityName: carrier.companyName,
      action: 'deactivated',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Deactivated carrier ${carrier.companyName}`,
    });

    return args.id;
  },
});

// Restore a soft-deleted carrier
export const restore = mutation({
  args: {
    id: v.id('carriers'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get carrier data before restoration
    const carrier = await ctx.db.get(args.id);
    if (!carrier) throw new Error('Carrier not found');

    await ctx.db.patch(args.id, {
      isDeleted: false,
      deletedAt: undefined,
      deletedBy: undefined,
      status: 'Active',
      updatedAt: Date.now(),
    });

    // Log the restoration
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: carrier.workosOrgId,
      entityType: 'carrier',
      entityId: args.id,
      entityName: carrier.companyName,
      action: 'restored',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Restored carrier ${carrier.companyName}`,
    });

    return args.id;
  },
});

// Permanent delete a carrier
export const permanentDelete = mutation({
  args: {
    id: v.id('carriers'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get carrier data before deletion
    const carrier = await ctx.db.get(args.id);
    if (!carrier) throw new Error('Carrier not found');

    // Delete sensitive info first
    const sensitiveInfo = await ctx.db
      .query('carriers_sensitive_info')
      .withIndex('by_carrier', (q) => q.eq('carrierInternalId', args.id))
      .first();

    if (sensitiveInfo) {
      await ctx.db.delete(sensitiveInfo._id);
    }

    // Log the deletion BEFORE removing from database
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: carrier.workosOrgId,
      entityType: 'carrier',
      entityId: args.id,
      entityName: carrier.companyName,
      action: 'deleted',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Permanently deleted carrier ${carrier.companyName}`,
      changesBefore: JSON.stringify(carrier),
    });

    await ctx.db.delete(args.id);
    return args.id;
  },
});

// Bulk deactivate carriers
export const bulkDeactivate = mutation({
  args: {
    ids: v.array(v.id('carriers')),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const results = [];

    for (const id of args.ids) {
      try {
        const carrier = await ctx.db.get(id);
        if (!carrier) throw new Error('Carrier not found');

        await ctx.db.patch(id, {
          isDeleted: true,
          deletedAt: Date.now(),
          deletedBy: args.userId,
          status: 'Inactive',
          updatedAt: Date.now(),
        });

        // Log the deactivation
        await ctx.runMutation(internal.auditLog.logAction, {
          organizationId: carrier.workosOrgId,
          entityType: 'carrier',
          entityId: id,
          entityName: carrier.companyName,
          action: 'deactivated',
          performedBy: args.userId,
          performedByName: args.userName,
          description: `Deactivated carrier ${carrier.companyName}`,
        });

        results.push({ id, success: true });
      } catch (error) {
        results.push({ id, success: false, error: String(error) });
      }
    }

    return results;
  },
});
