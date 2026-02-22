import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { Id } from './_generated/dataModel';

// Helper function to check if a date is expiring or expired
function getDateStatus(dateString?: string): 'expired' | 'expiring' | 'warning' | 'valid' {
  if (!dateString) return 'valid';
  
  const date = new Date(dateString);
  date.setHours(0, 0, 0, 0);
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const diffTime = date.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays < 0) return 'expired';
  if (diffDays <= 30) return 'expiring';
  if (diffDays <= 60) return 'warning';
  return 'valid';
}

// Count drivers by status for tab badges
export const countDriversByStatus = query({
  args: {
    organizationId: v.string(),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller is authenticated
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const allDrivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.organizationId))
      .collect();

    const counts = {
      all: 0,
      active: 0,
      needsAttention: 0,
      onLeave: 0,
      inactive: 0,
      deleted: 0,
    };

    allDrivers.forEach((driver) => {
      // Count deleted
      if (driver.isDeleted) {
        counts.deleted++;
        return; // Don't count in other categories
      }

      // Count all non-deleted
      counts.all++;

      // Count by employment status
      if (driver.employmentStatus === 'Active') {
        counts.active++;
      } else if (driver.employmentStatus === 'On Leave') {
        counts.onLeave++;
      } else if (driver.employmentStatus === 'Inactive') {
        counts.inactive++;
      }

      // Count needs attention (expiring/expired documents)
      const licenseStatus = getDateStatus(driver.licenseExpiration);
      const medicalStatus = getDateStatus(driver.medicalExpiration);
      const badgeStatus = getDateStatus(driver.badgeExpiration);
      const twicStatus = getDateStatus(driver.twicExpiration);

      if (
        licenseStatus === 'expired' ||
        licenseStatus === 'expiring' ||
        medicalStatus === 'expired' ||
        medicalStatus === 'expiring' ||
        badgeStatus === 'expired' ||
        badgeStatus === 'expiring' ||
        twicStatus === 'expired' ||
        twicStatus === 'expiring'
      ) {
        counts.needsAttention++;
      }
    });

    return counts;
  },
});

// Get all drivers for an organization (excluding soft-deleted)
export const list = query({
  args: {
    organizationId: v.string(),
    includeDeleted: v.optional(v.boolean()),
    includeSensitive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller is authenticated
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.organizationId))
      .collect();

    // Filter out soft-deleted drivers unless explicitly requested
    const filteredDrivers = args.includeDeleted
      ? drivers
      : drivers.filter((driver) => !driver.isDeleted);

    // If sensitive data is not requested, return only non-sensitive data
    if (!args.includeSensitive) {
      return filteredDrivers.map((driver) => ({
        ...driver,
        ssn: undefined,
        licenseNumber: undefined,
        dateOfBirth: undefined,
      }));
    }

    // Fetch all sensitive info for this organization
    const sensitiveInfos = await ctx.db
      .query('drivers_sensitive_info')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.organizationId))
      .collect();

    // Create a map for quick lookup
    const sensitiveMap = new Map(
      sensitiveInfos.map((info) => [info.driverInternalId, info])
    );

    // Combine drivers with their sensitive info
    return filteredDrivers.map((driver) => {
      const sensitiveInfo = sensitiveMap.get(driver._id);
      return {
        ...driver,
        ssn: sensitiveInfo?.ssn,
        licenseNumber: sensitiveInfo?.licenseNumber,
        dateOfBirth: sensitiveInfo?.dateOfBirth,
      };
    });
  },
});

// Get a single driver by ID
export const get = query({
  args: {
    id: v.id('drivers'),
    includeSensitive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller is authenticated
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const driver = await ctx.db.get(args.id);
    if (!driver) return null;

    // If sensitive data is not requested, return only non-sensitive data
    if (!args.includeSensitive) {
      return {
        ...driver,
        ssn: undefined,
        licenseNumber: undefined,
        dateOfBirth: undefined,
      };
    }

    // Fetch sensitive data
    const sensitiveInfo = await ctx.db
      .query('drivers_sensitive_info')
      .withIndex('by_driver', (q) => q.eq('driverInternalId', args.id))
      .first();

    // Combine driver data with sensitive info
    return {
      ...driver,
      ssn: sensitiveInfo?.ssn,
      licenseNumber: sensitiveInfo?.licenseNumber,
      dateOfBirth: sensitiveInfo?.dateOfBirth,
    };
  },
});

// Create a new driver
export const create = mutation({
  args: {
    // Personal Information
    firstName: v.string(),
    middleName: v.optional(v.string()),
    lastName: v.string(),
    email: v.string(),
    phone: v.string(),
    // Sensitive Information (will be stored separately)
    dateOfBirth: v.optional(v.string()),
    ssn: v.optional(v.string()),
    licenseNumber: v.string(),
    // License Information (non-sensitive)
    licenseState: v.string(),
    licenseExpiration: v.string(),
    licenseClass: v.string(),
    // Medical
    medicalExpiration: v.optional(v.string()),
    // Security Access
    badgeExpiration: v.optional(v.string()),
    twicExpiration: v.optional(v.string()),
    // Employment
    hireDate: v.string(),
    employmentStatus: v.string(),
    employmentType: v.string(),
    terminationDate: v.optional(v.string()),
    preEmploymentCheckDate: v.optional(v.string()),
    // Address
    address: v.optional(v.string()),
    address2: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zipCode: v.optional(v.string()),
    country: v.optional(v.string()),
    // Emergency Contact
    emergencyContactName: v.optional(v.string()),
    emergencyContactRelationship: v.optional(v.string()),
    emergencyContactPhone: v.optional(v.string()),
    // WorkOS Integration
    organizationId: v.string(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller is authenticated
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const now = Date.now();

    // Separate sensitive and non-sensitive data
    const { ssn, licenseNumber, dateOfBirth, ...nonSensitiveData } = args;

    // Insert non-sensitive data into drivers table
    const driverId = await ctx.db.insert('drivers', {
      ...nonSensitiveData,
      createdAt: now,
      updatedAt: now,
    });

    // Insert sensitive data into drivers_sensitive_info table
    await ctx.db.insert('drivers_sensitive_info', {
      driverInternalId: driverId,
      licenseNumber,
      ssn,
      dateOfBirth,
      organizationId: args.organizationId,
      createdAt: now,
      updatedAt: now,
    });

    // Auto-assign org default pay profile if one exists
    const orgDefaultProfile = await ctx.db
      .query('rateProfiles')
      .withIndex('by_org_type', (q) =>
        q.eq('workosOrgId', args.organizationId).eq('profileType', 'DRIVER')
      )
      .filter((q) =>
        q.and(
          q.eq(q.field('isDefault'), true),
          q.eq(q.field('isActive'), true)
        )
      )
      .first();

    if (orgDefaultProfile) {
      await ctx.db.insert('driverProfileAssignments', {
        driverId,
        profileId: orgDefaultProfile._id,
        workosOrgId: args.organizationId,
        isDefault: true, // First and only assignment, so it's the default
      });
    }

    // Auto-assign org default pay plan if one exists
    const orgDefaultPayPlan = await ctx.db
      .query('payPlans')
      .withIndex('by_org_active', (q) =>
        q.eq('workosOrgId', args.organizationId).eq('isActive', true)
      )
      .first();

    if (orgDefaultPayPlan) {
      await ctx.db.patch(driverId, {
        payPlanId: orgDefaultPayPlan._id,
      });
    }

    // Log the creation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.organizationId,
      entityType: 'driver',
      entityId: driverId,
      entityName: `${args.firstName} ${args.lastName}`,
      action: 'created',
      performedBy: args.createdBy,
      description: `Created driver ${args.firstName} ${args.lastName}`,
    });

    // Create Clerk user for mobile app authentication (async, non-blocking)
    ctx.scheduler.runAfter(0, internal.clerkSync.createClerkUserForDriver, {
      phone: args.phone,
      firstName: args.firstName,
      lastName: args.lastName,
    });

    return driverId;
  },
});

// Update a driver
export const update = mutation({
  args: {
    id: v.id('drivers'),
    // Audit fields
    userId: v.optional(v.string()),
    userName: v.optional(v.string()),
    organizationId: v.optional(v.string()),
    // Personal Information
    firstName: v.optional(v.string()),
    middleName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    dateOfBirth: v.optional(v.string()),
    ssn: v.optional(v.string()),
    // License Information
    licenseNumber: v.optional(v.string()),
    licenseState: v.optional(v.string()),
    licenseExpiration: v.optional(v.string()),
    licenseClass: v.optional(v.string()),
    // Medical
    medicalExpiration: v.optional(v.string()),
    // Security Access
    badgeExpiration: v.optional(v.string()),
    twicExpiration: v.optional(v.string()),
    // Employment
    hireDate: v.optional(v.string()),
    employmentStatus: v.optional(v.string()),
    employmentType: v.optional(v.string()),
    terminationDate: v.optional(v.string()),
    preEmploymentCheckDate: v.optional(v.string()),
    // Pay Plan Assignment
    payPlanId: v.optional(v.id('payPlans')),
    // Address
    address: v.optional(v.string()),
    address2: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zipCode: v.optional(v.string()),
    country: v.optional(v.string()),
    // Emergency Contact
    emergencyContactName: v.optional(v.string()),
    emergencyContactRelationship: v.optional(v.string()),
    emergencyContactPhone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, userId, userName, organizationId, ssn, licenseNumber, dateOfBirth, payPlanId, ...updates } = args;

    // Get current driver data for audit log
    const driver = await ctx.db.get(id);
    if (!driver) throw new Error('Driver not found');

    // Handle payPlanId separately (it's an Id type, not a string)
    if (payPlanId !== undefined) {
      (updates as any).payPlanId = payPlanId;
    }

    const now = Date.now();

    // Separate sensitive and non-sensitive updates
    const sensitiveUpdates: { ssn?: string; licenseNumber?: string; dateOfBirth?: string; updatedAt: number } = { updatedAt: now };
    const hasSensitiveUpdates = ssn !== undefined || licenseNumber !== undefined || dateOfBirth !== undefined;

    if (ssn !== undefined) sensitiveUpdates.ssn = ssn;
    if (licenseNumber !== undefined) sensitiveUpdates.licenseNumber = licenseNumber;
    if (dateOfBirth !== undefined) sensitiveUpdates.dateOfBirth = dateOfBirth;

    // Update non-sensitive data in drivers table
    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(id, {
        ...updates,
        updatedAt: now,
      });
    }

    // Update sensitive data in drivers_sensitive_info table
    if (hasSensitiveUpdates) {
      const sensitiveInfo = await ctx.db
        .query('drivers_sensitive_info')
        .withIndex('by_driver', (q) => q.eq('driverInternalId', id))
        .first();

      if (sensitiveInfo) {
        await ctx.db.patch(sensitiveInfo._id, sensitiveUpdates);
      }
    }

    // Log the update if audit info provided
    if (userId && organizationId) {
      const allUpdates = { ...updates, ...sensitiveUpdates };
      const changedFields = Object.keys(allUpdates).filter((key) => key !== 'updatedAt');
      await ctx.runMutation(internal.auditLog.logAction, {
        organizationId,
        entityType: 'driver',
        entityId: id,
        entityName: `${driver.firstName} ${driver.lastName}`,
        action: 'updated',
        performedBy: userId,
        performedByName: userName,
        description: `Updated driver ${driver.firstName} ${driver.lastName}`,
        changedFields,
        changesAfter: JSON.stringify(allUpdates),
      });
    }

    // If phone number changed, update Clerk user (async, non-blocking)
    if (updates.phone && updates.phone !== driver.phone) {
      ctx.scheduler.runAfter(0, internal.clerkSync.updateClerkUserPhone, {
        oldPhone: driver.phone,
        newPhone: updates.phone,
        firstName: updates.firstName || driver.firstName,
        lastName: updates.lastName || driver.lastName,
      });
    }

    // === DRIVER → PARTNERSHIP SYNC: Update partnerships when owner-driver changes ===
    // Check if this driver is the owner-driver of their organization
    // Query the organization to get proper typing
    const driverOrgId = driver.organizationId as Id<'organizations'>;
    const driverOrg = await ctx.db
      .query('organizations')
      .filter((q) => q.eq(q.field('_id'), driverOrgId))
      .first();
    
    if (driverOrg?.isOwnerOperator && driverOrg.ownerDriverId === id) {
      // Find all partnerships linked to this carrier org
      const partnerships = await ctx.db
        .query('carrierPartnerships')
        .withIndex('by_carrier', (q) => q.eq('carrierOrgId', driverOrg.clerkOrgId || driverOrg.workosOrgId || driverOrg._id))
        .collect();
      
      // Also check by Convex ID directly
      const partnershipsByConvexId = await ctx.db
        .query('carrierPartnerships')
        .filter((q) => q.eq(q.field('carrierOrgId'), driverOrg._id))
        .collect();
      
      const allPartnerships = [...partnerships, ...partnershipsByConvexId];
      const seenIds = new Set<string>();
      
      for (const partnership of allPartnerships) {
        if (seenIds.has(partnership._id)) continue;
        seenIds.add(partnership._id);
        
        // Build partnership updates from driver changes
        const partnershipUpdates: Record<string, unknown> = { updatedAt: Date.now() };
        
        if (updates.firstName !== undefined) partnershipUpdates.ownerDriverFirstName = updates.firstName;
        if (updates.lastName !== undefined) partnershipUpdates.ownerDriverLastName = updates.lastName;
        if (updates.phone !== undefined) partnershipUpdates.ownerDriverPhone = updates.phone;
        if (updates.email !== undefined) partnershipUpdates.ownerDriverEmail = updates.email;
        if (dateOfBirth !== undefined) partnershipUpdates.ownerDriverDOB = dateOfBirth;
        if (licenseNumber !== undefined) partnershipUpdates.ownerDriverLicenseNumber = licenseNumber;
        if (updates.licenseState !== undefined) partnershipUpdates.ownerDriverLicenseState = updates.licenseState;
        if (updates.licenseClass !== undefined) partnershipUpdates.ownerDriverLicenseClass = updates.licenseClass;
        if (updates.licenseExpiration !== undefined) partnershipUpdates.ownerDriverLicenseExpiration = updates.licenseExpiration;
        
        // Only patch if there are actual partnership field updates
        if (Object.keys(partnershipUpdates).length > 1) {
          await ctx.db.patch(partnership._id, partnershipUpdates);
        }
      }
    }

    return id;
  },
});

// Soft delete (deactivate) a driver
export const deactivate = mutation({
  args: {
    id: v.id('drivers'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get driver data before deactivation
    const driver = await ctx.db.get(args.id);
    if (!driver) throw new Error('Driver not found');

    await ctx.db.patch(args.id, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: args.userId,
      employmentStatus: 'Inactive',
      updatedAt: Date.now(),
    });

    // Log the deactivation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: driver.organizationId,
      entityType: 'driver',
      entityId: args.id,
      entityName: `${driver.firstName} ${driver.lastName}`,
      action: 'deactivated',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Deactivated driver ${driver.firstName} ${driver.lastName}`,
    });

    return args.id;
  },
});

// Restore a soft-deleted driver
export const restore = mutation({
  args: {
    id: v.id('drivers'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get driver data before restoration
    const driver = await ctx.db.get(args.id);
    if (!driver) throw new Error('Driver not found');

    await ctx.db.patch(args.id, {
      isDeleted: false,
      deletedAt: undefined,
      deletedBy: undefined,
      employmentStatus: 'Active',
      updatedAt: Date.now(),
    });

    // Log the restoration
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: driver.organizationId,
      entityType: 'driver',
      entityId: args.id,
      entityName: `${driver.firstName} ${driver.lastName}`,
      action: 'restored',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Restored driver ${driver.firstName} ${driver.lastName}`,
    });

    return args.id;
  },
});

// Update driver's current truck assignment (for dispatch planning)
export const updateCurrentTruck = mutation({
  args: {
    driverId: v.id('drivers'),
    truckId: v.id('trucks'),
    workosOrgId: v.string(),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const driver = await ctx.db.get(args.driverId);
    if (!driver) throw new Error('Driver not found');

    const truck = await ctx.db.get(args.truckId);
    if (!truck) throw new Error('Truck not found');

    // Update driver with current truck
    await ctx.db.patch(args.driverId, {
      currentTruckId: args.truckId,
      updatedAt: Date.now(),
    });

    // Log the assignment
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.workosOrgId,
      entityType: 'driver',
      entityId: args.driverId,
      entityName: `${driver.firstName} ${driver.lastName}`,
      action: 'updated',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Assigned truck ${truck.unitId} to driver ${driver.firstName} ${driver.lastName}`,
      changedFields: ['currentTruckId'],
      changesAfter: JSON.stringify({ currentTruckId: args.truckId }),
    });

    return args.driverId;
  },
});

// Permanent delete a driver
export const permanentDelete = mutation({
  args: {
    id: v.id('drivers'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get driver data before deletion
    const driver = await ctx.db.get(args.id);
    if (!driver) throw new Error('Driver not found');

    // Delete sensitive info first
    const sensitiveInfo = await ctx.db
      .query('drivers_sensitive_info')
      .withIndex('by_driver', (q) => q.eq('driverInternalId', args.id))
      .first();

    if (sensitiveInfo) {
      await ctx.db.delete(sensitiveInfo._id);
    }

    // Log the deletion BEFORE removing from database
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: driver.organizationId,
      entityType: 'driver',
      entityId: args.id,
      entityName: `${driver.firstName} ${driver.lastName}`,
      action: 'deleted',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Permanently deleted driver ${driver.firstName} ${driver.lastName}`,
      changesBefore: JSON.stringify(driver),
    });

    // Delete Clerk user (async, non-blocking)
    if (driver.phone) {
      ctx.scheduler.runAfter(0, internal.clerkSync.deleteClerkUser, {
        phone: driver.phone,
      });
    }

    await ctx.db.delete(args.id);
    return args.id;
  },
});
