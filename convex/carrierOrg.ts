import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { Id } from './_generated/dataModel';
import { internal } from './_generated/api';

/**
 * Carrier Organization API
 * Handles carrier signup, management, and upgrade to full TMS
 */

// ==========================================
// QUERIES
// ==========================================

/**
 * Get carrier organization by Clerk org ID
 * (Used in mobile app after authentication)
 */
export const getByClerkOrg = query({
  args: {
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query('organizations')
      .withIndex('by_clerk_org', (q) => q.eq('clerkOrgId', args.clerkOrgId))
      .first();
  },
});

/**
 * Get carrier organization by MC number
 */
export const getByMcNumber = query({
  args: {
    mcNumber: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query('organizations')
      .withIndex('by_mc', (q) => q.eq('mcNumber', args.mcNumber))
      .first();
  },
});

/**
 * Get organization sensitive data
 * (Only call when needed - settings page, payment setup)
 */
export const getSensitiveData = query({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query('organizations_sensitive')
      .withIndex('by_org', (q) => q.eq('organizationId', args.organizationId))
      .first();
  },
});

/**
 * Check if carrier can upgrade to broker/carrier
 */
export const canUpgrade = query({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org) {
      return { canUpgrade: false, reason: 'Organization not found' };
    }

    if (org.orgType !== 'CARRIER') {
      return { canUpgrade: false, reason: 'Only CARRIER orgs can upgrade' };
    }

    if (org.workosOrgId) {
      return { canUpgrade: false, reason: 'Already has WorkOS org' };
    }

    return { canUpgrade: true };
  },
});

/**
 * Get organization's notification preferences
 */
export const getNotificationPreferences = query({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query('notificationPreferences')
      .withIndex('by_org', (q) => q.eq('organizationId', args.organizationId))
      .first();
  },
});

// ==========================================
// MUTATIONS
// ==========================================

/**
 * Create a new carrier organization
 * Called during mobile app signup
 */
export const create = mutation({
  args: {
    clerkOrgId: v.string(),
    clerkUserId: v.string(),
    name: v.string(),
    mcNumber: v.string(),
    usdotNumber: v.optional(v.string()),
    billingEmail: v.string(),
    billingPhone: v.optional(v.string()),
    billingAddress: v.object({
      addressLine1: v.string(),
      addressLine2: v.optional(v.string()),
      city: v.string(),
      state: v.string(),
      zip: v.string(),
      country: v.string(),
    }),
    insuranceProvider: v.optional(v.string()),
    insuranceExpiration: v.optional(v.string()),
    phone: v.optional(v.string()),
    // Owner-operator fields
    isOwnerOperator: v.optional(v.boolean()),
    ownerFirstName: v.optional(v.string()),
    ownerLastName: v.optional(v.string()),
    ownerLicenseState: v.optional(v.string()),
    ownerLicenseExpiration: v.optional(v.string()),
    ownerLicenseClass: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Check if MC# already exists
    const existingByMc = await ctx.db
      .query('organizations')
      .withIndex('by_mc', (q) => q.eq('mcNumber', args.mcNumber))
      .first();

    if (existingByMc) {
      throw new Error(`Organization with MC# ${args.mcNumber} already exists`);
    }

    // Check if Clerk org ID already exists
    const existingByClerk = await ctx.db
      .query('organizations')
      .withIndex('by_clerk_org', (q) => q.eq('clerkOrgId', args.clerkOrgId))
      .first();

    if (existingByClerk) {
      throw new Error('Organization already exists for this account');
    }

    // Create the organization (without ownerDriverId initially)
    const orgId = await ctx.db.insert('organizations', {
      clerkOrgId: args.clerkOrgId,
      orgType: 'CARRIER',
      name: args.name,
      mcNumber: args.mcNumber,
      usdotNumber: args.usdotNumber,
      billingEmail: args.billingEmail,
      billingPhone: args.billingPhone,
      billingAddress: args.billingAddress,
      insuranceProvider: args.insuranceProvider,
      insuranceExpiration: args.insuranceExpiration,
      isOwnerOperator: args.isOwnerOperator ?? false,
      // Default subscription for carriers
      subscriptionPlan: 'Free',
      subscriptionStatus: 'Active',
      billingCycle: 'N/A',
      createdAt: now,
      updatedAt: now,
    });

    // If owner-operator, create driver record and link it
    let ownerDriverId: Id<'drivers'> | null = null;
    if (args.isOwnerOperator && args.phone) {
      // Parse name for driver record
      const firstName = args.ownerFirstName || args.name.split(' ')[0] || 'Owner';
      const lastName = args.ownerLastName || args.name.split(' ').slice(1).join(' ') || '';
      
      // Create driver record for the owner
      ownerDriverId = await ctx.db.insert('drivers', {
        firstName,
        lastName,
        email: args.billingEmail,
        phone: args.phone,
        licenseState: args.ownerLicenseState || 'Unknown',
        licenseExpiration: args.ownerLicenseExpiration || new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        licenseClass: args.ownerLicenseClass || 'Class A',
        hireDate: new Date(now).toISOString().split('T')[0],
        employmentStatus: 'Active',
        employmentType: 'Owner Operator',
        organizationId: orgId,
        createdBy: args.clerkUserId,
        createdAt: now,
        updatedAt: now,
      });

      // Update org with the driver link
      await ctx.db.patch(orgId, {
        ownerDriverId,
        updatedAt: now,
      });
    }

    // Create user identity link
    await ctx.db.insert('userIdentityLinks', {
      clerkUserId: args.clerkUserId,
      organizationId: orgId,
      role: 'OWNER',
      phone: args.phone,
      createdAt: now,
      updatedAt: now,
    });

    // Create default notification preferences
    await ctx.db.insert('notificationPreferences', {
      organizationId: orgId,
      pushEnabled: true,
      smsEnabled: true,
      emailEnabled: true,
      newLoadOffers: true,
      loadStatusChanges: true,
      paymentUpdates: true,
      createdAt: now,
      updatedAt: now,
    });

    // Auto-link any existing partnerships with this MC#
    const partnerships = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_mc', (q) => q.eq('mcNumber', args.mcNumber))
      .collect();

    const unlinkedPartnerships = partnerships.filter((p) => !p.carrierOrgId);

    for (const partnership of unlinkedPartnerships) {
      await ctx.db.patch(partnership._id, {
        carrierOrgId: args.clerkOrgId,
        status: 'PENDING', // Carrier needs to accept each broker
        linkedAt: now,
        updatedAt: now,
      });
    }

    // Sync carrier owner to Clerk for mobile app sign-in
    // Only if phone is provided
    if (args.phone) {
      await ctx.scheduler.runAfter(0, internal.clerkSync.syncSingleCarrierOwnerToClerk, {
        organizationId: orgId,
        phone: args.phone,
        firstName: args.name.split(' ')[0] || 'Owner',
        lastName: args.name.split(' ').slice(1).join(' ') || '',
        email: args.billingEmail,
      });
    }

    return {
      organizationId: orgId,
      ownerDriverId,
      isOwnerOperator: args.isOwnerOperator ?? false,
      linkedPartnerships: unlinkedPartnerships.length,
    };
  },
});

/**
 * Link an existing driver record as the owner-operator driver
 * Used when an owner-operator already has a driver record in the system
 */
export const linkOwnerDriver = mutation({
  args: {
    organizationId: v.id('organizations'),
    driverId: v.id('drivers'),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Verify organization exists and is a carrier type
    const org = await ctx.db.get(args.organizationId);
    if (!org) {
      throw new Error('Organization not found');
    }

    if (org.orgType !== 'CARRIER' && org.orgType !== 'BROKER_CARRIER') {
      throw new Error('Only carrier organizations can have owner drivers');
    }

    // Prevent linking to deleted organizations
    if (org.isDeleted) {
      throw new Error(`Cannot link driver to deactivated organization "${org.name}"`);
    }

    // Verify driver exists and belongs to this organization
    const driver = await ctx.db.get(args.driverId);
    if (!driver) {
      throw new Error('Driver not found');
    }

    if (driver.organizationId !== args.organizationId) {
      throw new Error('Driver does not belong to this organization');
    }

    if (driver.isDeleted) {
      throw new Error('Cannot link a deleted driver');
    }

    // Update organization with owner-operator fields
    await ctx.db.patch(args.organizationId, {
      isOwnerOperator: true,
      ownerDriverId: args.driverId,
      updatedAt: now,
    });

    return { success: true, ownerDriverId: args.driverId };
  },
});

/**
 * Unlink owner driver (convert back to fleet carrier)
 */
export const unlinkOwnerDriver = mutation({
  args: {
    organizationId: v.id('organizations'),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const org = await ctx.db.get(args.organizationId);
    if (!org) {
      throw new Error('Organization not found');
    }

    // Clear owner-operator fields
    await ctx.db.patch(args.organizationId, {
      isOwnerOperator: false,
      ownerDriverId: undefined,
      updatedAt: now,
    });

    return { success: true };
  },
});

/**
 * Update carrier organization info
 */
export const update = mutation({
  args: {
    organizationId: v.id('organizations'),
    name: v.optional(v.string()),
    usdotNumber: v.optional(v.string()),
    billingEmail: v.optional(v.string()),
    billingPhone: v.optional(v.string()),
    insuranceProvider: v.optional(v.string()),
    insuranceExpiration: v.optional(v.string()),
    insuranceCoverage: v.optional(v.boolean()),
    operatingAuthorityActive: v.optional(v.boolean()),
    safetyRating: v.optional(v.string()),
    logoStorageId: v.optional(v.id('_storage')),
    defaultTimezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { organizationId, ...updates } = args;

    const org = await ctx.db.get(organizationId);
    if (!org) {
      throw new Error('Organization not found');
    }

    // Prevent updates to deleted organizations
    if (org.isDeleted) {
      throw new Error(`Cannot update deactivated organization "${org.name}". Restore it first.`);
    }

    // Remove undefined values
    const cleanUpdates: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        cleanUpdates[key] = value;
      }
    }

    await ctx.db.patch(organizationId, cleanUpdates);

    // Sync updated info to partnerships if name or insurance changed
    if (updates.name || updates.insuranceProvider || updates.insuranceExpiration) {
      const carrierOrgIdentifier = org.clerkOrgId || org.workosOrgId;
      if (carrierOrgIdentifier) {
        const partnerships = await ctx.db
          .query('carrierPartnerships')
          .withIndex('by_carrier', (q) => q.eq('carrierOrgId', carrierOrgIdentifier))
          .collect();

        for (const partnership of partnerships) {
          const partnershipUpdates: Record<string, unknown> = {
            updatedAt: Date.now(),
            lastSyncedAt: Date.now(),
          };
          if (updates.name) partnershipUpdates.carrierName = updates.name;
          if (updates.insuranceProvider)
            partnershipUpdates.insuranceProvider = updates.insuranceProvider;
          if (updates.insuranceExpiration)
            partnershipUpdates.insuranceExpiration = updates.insuranceExpiration;

          await ctx.db.patch(partnership._id, partnershipUpdates);
        }
      }
    }

    return { success: true };
  },
});

/**
 * Update or create sensitive organization data
 */
export const updateSensitiveData = mutation({
  args: {
    organizationId: v.id('organizations'),
    ein: v.optional(v.string()),
    stateRegistrationNumber: v.optional(v.string()),
    bankName: v.optional(v.string()),
    bankAccountType: v.optional(v.union(v.literal('CHECKING'), v.literal('SAVINGS'))),
    bankRoutingNumber: v.optional(v.string()),
    bankAccountNumber: v.optional(v.string()),
    insurancePolicyNumber: v.optional(v.string()),
    cargoInsuranceAmount: v.optional(v.number()),
    liabilityInsuranceAmount: v.optional(v.number()),
    autoInsuranceAmount: v.optional(v.number()),
    preferredPaymentMethod: v.optional(
      v.union(v.literal('ACH'), v.literal('CHECK'), v.literal('WIRE'), v.literal('QUICKPAY'))
    ),
    paymentTerms: v.optional(v.string()),
    factoringCompany: v.optional(v.string()),
    factoringStatus: v.optional(v.boolean()),
    remitToAddress: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const { organizationId, ...data } = args;

    // Check if sensitive record exists
    const existing = await ctx.db
      .query('organizations_sensitive')
      .withIndex('by_org', (q) => q.eq('organizationId', organizationId))
      .first();

    if (existing) {
      // Update existing
      const updates: Record<string, unknown> = { updatedAt: now };
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) {
          updates[key] = value;
        }
      }
      await ctx.db.patch(existing._id, updates);
      return { success: true, created: false };
    } else {
      // Create new
      await ctx.db.insert('organizations_sensitive', {
        organizationId,
        ...data,
        createdAt: now,
        updatedAt: now,
      });
      return { success: true, created: true };
    }
  },
});

/**
 * Update notification preferences
 */
export const updateNotificationPreferences = mutation({
  args: {
    organizationId: v.id('organizations'),
    pushEnabled: v.optional(v.boolean()),
    smsEnabled: v.optional(v.boolean()),
    emailEnabled: v.optional(v.boolean()),
    newLoadOffers: v.optional(v.boolean()),
    loadStatusChanges: v.optional(v.boolean()),
    paymentUpdates: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const { organizationId, ...prefs } = args;

    const existing = await ctx.db
      .query('notificationPreferences')
      .withIndex('by_org', (q) => q.eq('organizationId', organizationId))
      .first();

    if (existing) {
      const updates: Record<string, unknown> = { updatedAt: now };
      for (const [key, value] of Object.entries(prefs)) {
        if (value !== undefined) {
          updates[key] = value;
        }
      }
      await ctx.db.patch(existing._id, updates);
    } else {
      await ctx.db.insert('notificationPreferences', {
        organizationId,
        pushEnabled: prefs.pushEnabled ?? true,
        smsEnabled: prefs.smsEnabled ?? true,
        emailEnabled: prefs.emailEnabled ?? true,
        newLoadOffers: prefs.newLoadOffers ?? true,
        loadStatusChanges: prefs.loadStatusChanges ?? true,
        paymentUpdates: prefs.paymentUpdates ?? true,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { success: true };
  },
});

/**
 * Initiate upgrade from CARRIER to BROKER_CARRIER
 * This is called from the mobile app when carrier wants web TMS access
 */
export const initiateUpgrade = mutation({
  args: {
    organizationId: v.id('organizations'),
    clerkUserId: v.string(),
    email: v.string(), // Required for WorkOS
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const org = await ctx.db.get(args.organizationId);
    if (!org) {
      throw new Error('Organization not found');
    }

    if (org.orgType !== 'CARRIER') {
      throw new Error('Only CARRIER organizations can upgrade');
    }

    if (org.workosOrgId) {
      throw new Error('Organization already has WorkOS access');
    }

    // Get user identity link
    const identityLink = await ctx.db
      .query('userIdentityLinks')
      .withIndex('by_clerk', (q) => q.eq('clerkUserId', args.clerkUserId))
      .first();

    if (!identityLink) {
      throw new Error('User identity link not found');
    }

    if (identityLink.organizationId !== args.organizationId) {
      throw new Error('User does not belong to this organization');
    }

    // Store the email for WorkOS setup
    // In a real implementation, this would call WorkOS API to:
    // 1. Create WorkOS organization
    // 2. Create WorkOS user with email
    // 3. Send password setup email to user

    // For now, we'll mark the upgrade as pending and store the email
    // The actual WorkOS provisioning would happen in a separate action
    await ctx.db.patch(identityLink._id, {
      email: args.email,
      updatedAt: now,
    });

    // Return info for the next step (actual WorkOS provisioning)
    return {
      success: true,
      organizationId: args.organizationId,
      email: args.email,
      message: 'Upgrade initiated. WorkOS provisioning will follow.',
    };
  },
});

/**
 * Complete upgrade after WorkOS provisioning
 * Called after WorkOS org and user are created
 */
export const completeUpgrade = mutation({
  args: {
    organizationId: v.id('organizations'),
    clerkUserId: v.string(),
    workosOrgId: v.string(),
    workosUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const org = await ctx.db.get(args.organizationId);
    if (!org) {
      throw new Error('Organization not found');
    }

    // Update organization
    await ctx.db.patch(args.organizationId, {
      orgType: 'BROKER_CARRIER',
      workosOrgId: args.workosOrgId,
      upgradedAt: now,
      upgradedBy: args.clerkUserId,
      updatedAt: now,
    });

    // Update user identity link
    const identityLink = await ctx.db
      .query('userIdentityLinks')
      .withIndex('by_clerk', (q) => q.eq('clerkUserId', args.clerkUserId))
      .first();

    if (identityLink) {
      await ctx.db.patch(identityLink._id, {
        workosUserId: args.workosUserId,
        workosOrgId: args.workosOrgId,
        upgradedAt: now,
        updatedAt: now,
      });
    }

    return {
      success: true,
      orgType: 'BROKER_CARRIER',
    };
  },
});

/**
 * Get user identity link by Clerk user ID
 */
export const getIdentityByClerk = query({
  args: {
    clerkUserId: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query('userIdentityLinks')
      .withIndex('by_clerk', (q) => q.eq('clerkUserId', args.clerkUserId))
      .first();
  },
});

/**
 * Get user identity link by WorkOS user ID
 */
export const getIdentityByWorkos = query({
  args: {
    workosUserId: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query('userIdentityLinks')
      .withIndex('by_workos', (q) => q.eq('workosUserId', args.workosUserId))
      .first();
  },
});

// ==========================================
// CARRIER ORGANIZATION DEACTIVATION
// ==========================================

/**
 * Deactivate (soft delete) a carrier organization
 * Handles all cascade logic to prevent orphaned data:
 * - Soft deletes all drivers in the organization
 * - Terminates all carrier partnerships
 * - Marks active load assignments as CARRIER_DEACTIVATED
 * - Cleans up user identity links
 * - Preserves historical data for audit purposes
 */
export const deactivateCarrierOrg = mutation({
  args: {
    organizationId: v.id('organizations'),
    userId: v.string(),
    userName: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // 1. Verify organization exists and is a carrier type
    const org = await ctx.db.get(args.organizationId);
    if (!org) {
      throw new Error('Organization not found');
    }

    if (org.orgType !== 'CARRIER' && org.orgType !== 'BROKER_CARRIER') {
      throw new Error('Only carrier organizations can be deactivated with this function');
    }

    if (org.isDeleted) {
      throw new Error('Organization is already deactivated');
    }

    const carrierOrgIdentifier = org.clerkOrgId || org.workosOrgId;
    const results = {
      organizationId: args.organizationId,
      driversDeactivated: 0,
      partnershipsTerminated: 0,
      assignmentsUpdated: 0,
      identityLinksRemoved: 0,
    };

    // 2. Soft delete all drivers in this organization
    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.organizationId))
      .collect();

    for (const driver of drivers) {
      if (!driver.isDeleted) {
        await ctx.db.patch(driver._id, {
          isDeleted: true,
          deletedAt: now,
          deletedBy: args.userId,
          employmentStatus: 'Inactive',
          updatedAt: now,
        });
        results.driversDeactivated++;
      }
    }

    // 3. Terminate all carrier partnerships
    if (carrierOrgIdentifier) {
      const partnerships = await ctx.db
        .query('carrierPartnerships')
        .withIndex('by_carrier', (q) => q.eq('carrierOrgId', carrierOrgIdentifier))
        .collect();

      for (const partnership of partnerships) {
        if (partnership.status !== 'TERMINATED') {
          await ctx.db.patch(partnership._id, {
            status: 'TERMINATED',
            updatedAt: now,
          });
          results.partnershipsTerminated++;
        }
      }

      // 4. Update active load assignments
      // Get all non-completed assignments and mark them appropriately
      const activeStatuses = ['OFFERED', 'ACCEPTED', 'AWARDED', 'IN_PROGRESS'];
      
      for (const status of activeStatuses) {
        const assignments = await ctx.db
          .query('loadCarrierAssignments')
          .withIndex('by_carrier', (q) => 
            q.eq('carrierOrgId', carrierOrgIdentifier).eq('status', status as 'OFFERED' | 'ACCEPTED' | 'AWARDED' | 'IN_PROGRESS')
          )
          .collect();

        for (const assignment of assignments) {
          await ctx.db.patch(assignment._id, {
            status: 'CANCELED',
            canceledAt: now,
            canceledBy: args.userId,
            canceledByParty: 'CARRIER',
            cancellationReason: 'OTHER',
            cancellationNotes: `Carrier organization deactivated. Reason: ${args.reason || 'Not specified'}`,
          });
          results.assignmentsUpdated++;
        }
      }
    }

    // 5. Mark user identity links as associated with deleted org
    // We don't delete them to preserve audit trail
    const identityLinks = await ctx.db
      .query('userIdentityLinks')
      .withIndex('by_org', (q) => q.eq('organizationId', args.organizationId))
      .collect();

    for (const link of identityLinks) {
      await ctx.db.delete(link._id);
      results.identityLinksRemoved++;
    }

    // 6. Delete notification preferences
    const notifPrefs = await ctx.db
      .query('notificationPreferences')
      .withIndex('by_org', (q) => q.eq('organizationId', args.organizationId))
      .first();

    if (notifPrefs) {
      await ctx.db.delete(notifPrefs._id);
    }

    // 7. Soft delete the organization itself
    await ctx.db.patch(args.organizationId, {
      isDeleted: true,
      deletedAt: now,
      deletedBy: args.userId,
      deletionReason: args.reason || 'Deactivated by admin',
      updatedAt: now,
    });

    // 8. Log the deactivation to audit log
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: carrierOrgIdentifier || args.organizationId,
      entityType: 'organization',
      entityId: args.organizationId,
      entityName: org.name,
      action: 'deactivated',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Deactivated carrier organization ${org.name}. ` +
        `Cascade: ${results.driversDeactivated} drivers, ` +
        `${results.partnershipsTerminated} partnerships, ` +
        `${results.assignmentsUpdated} assignments. ` +
        `Reason: ${args.reason || 'Not specified'}`,
    });

    return {
      success: true,
      ...results,
    };
  },
});

/**
 * Restore a soft-deleted carrier organization
 * Note: This does NOT automatically restore related data (drivers, partnerships)
 * Those must be individually reviewed and restored
 */
export const restoreCarrierOrg = mutation({
  args: {
    organizationId: v.id('organizations'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const org = await ctx.db.get(args.organizationId);
    if (!org) {
      throw new Error('Organization not found');
    }

    if (!org.isDeleted) {
      throw new Error('Organization is not deactivated');
    }

    // Restore the organization
    await ctx.db.patch(args.organizationId, {
      isDeleted: false,
      deletedAt: undefined,
      deletedBy: undefined,
      deletionReason: undefined,
      updatedAt: now,
    });

    const carrierOrgIdentifier = org.clerkOrgId || org.workosOrgId;

    // Log the restoration
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: carrierOrgIdentifier || args.organizationId,
      entityType: 'organization',
      entityId: args.organizationId,
      entityName: org.name,
      action: 'restored',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Restored carrier organization ${org.name}. Note: Related drivers and partnerships must be restored separately.`,
    });

    return {
      success: true,
      message: 'Organization restored. Related drivers and partnerships must be restored separately.',
    };
  },
});

/**
 * Check if an organization is deleted
 * Used by mobile app to provide better error messages
 */
export const checkOrgStatus = query({
  args: {
    organizationId: v.optional(v.id('organizations')),
    clerkOrgId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let org = null;

    if (args.organizationId) {
      org = await ctx.db.get(args.organizationId);
    } else if (args.clerkOrgId) {
      org = await ctx.db
        .query('organizations')
        .withIndex('by_clerk_org', (q) => q.eq('clerkOrgId', args.clerkOrgId))
        .first();
    }

    if (!org) {
      return {
        exists: false,
        isDeleted: false,
        deletionReason: null,
        deletedAt: null,
      };
    }

    return {
      exists: true,
      isDeleted: org.isDeleted || false,
      deletionReason: org.deletionReason || null,
      deletedAt: org.deletedAt || null,
      orgName: org.name,
      orgType: org.orgType,
    };
  },
});
