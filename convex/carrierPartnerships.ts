import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { Id } from './_generated/dataModel';
import { internal } from './_generated/api';

/**
 * Carrier Partnerships API
 * Manages broker-carrier relationships in the marketplace model
 */

// ==========================================
// QUERIES
// ==========================================

/**
 * List all carrier partnerships for a broker
 */
export const listForBroker = query({
  args: {
    brokerOrgId: v.string(),
    status: v.optional(
      v.union(
        v.literal('ACTIVE'),
        v.literal('INVITED'),
        v.literal('PENDING'),
        v.literal('SUSPENDED'),
        v.literal('TERMINATED')
      )
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let query = ctx.db
      .query('carrierPartnerships')
      .withIndex('by_broker', (q) => {
        if (args.status) {
          return q.eq('brokerOrgId', args.brokerOrgId).eq('status', args.status);
        }
        return q.eq('brokerOrgId', args.brokerOrgId);
      });

    const partnerships = await query.collect();

    // If status wasn't specified in index, filter for non-terminated by default
    const filtered = args.status
      ? partnerships
      : partnerships.filter((p) => p.status !== 'TERMINATED');

    // Apply limit
    const limited = args.limit ? filtered.slice(0, args.limit) : filtered;

    // Enrich with carrier org info if linked
    return Promise.all(
      limited.map(async (partnership) => {
        let carrierOrg = null;
        if (partnership.carrierOrgId) {
          // Try finding by clerkOrgId first (mobile carriers), then workosOrgId
          carrierOrg = await ctx.db
            .query('organizations')
            .withIndex('by_clerk_org', (q) => q.eq('clerkOrgId', partnership.carrierOrgId!))
            .first();
          
          if (!carrierOrg) {
            carrierOrg = await ctx.db
              .query('organizations')
              .withIndex('by_organization', (q) =>
                q.eq('workosOrgId', partnership.carrierOrgId!)
              )
              .first();
          }
        }
        return {
          ...partnership,
          carrierOrg: carrierOrg ? {
            _id: carrierOrg._id,
            name: carrierOrg.name,
            orgType: carrierOrg.orgType,
            isOwnerOperator: carrierOrg.isOwnerOperator,
          } : null,
        };
      })
    );
  },
});

/**
 * Count partnerships by status for a broker
 * Used for tab counts in the carrier list UI
 */
export const countPartnershipsByStatus = query({
  args: {
    brokerOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const partnerships = await ctx.db
      .query('carrierPartnerships')
      .filter((q) => q.eq(q.field('brokerOrgId'), args.brokerOrgId))
      .collect();

    const counts = {
      active: 0,
      pending: 0,
      invited: 0,
      suspended: 0,
      terminated: 0,
      total: partnerships.length,
    };

    for (const p of partnerships) {
      switch (p.status) {
        case 'ACTIVE':
          counts.active++;
          break;
        case 'PENDING':
          counts.pending++;
          break;
        case 'INVITED':
          counts.invited++;
          break;
        case 'SUSPENDED':
          counts.suspended++;
          break;
        case 'TERMINATED':
          counts.terminated++;
          break;
      }
    }

    return counts;
  },
});

/**
 * Get active partnerships for dispatch planner
 * Lightweight query returning only what's needed for carrier selection
 */
export const getActiveForDispatch = query({
  args: {
    brokerOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const partnerships = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_broker', (q) =>
        q.eq('brokerOrgId', args.brokerOrgId).eq('status', 'ACTIVE')
      )
      .collect();

    // Return minimal data needed for dispatch planner carrier selection
    return partnerships.map((p) => ({
      _id: p._id,
      carrierOrgId: p.carrierOrgId,
      carrierName: p.carrierName,
      mcNumber: p.mcNumber,
      contactFirstName: p.contactFirstName,
      contactLastName: p.contactLastName,
      contactPhone: p.contactPhone,
      contactEmail: p.contactEmail,
      city: p.city,
      state: p.state,
      // Rate info for direct assignment
      hasDefaultRate: p.defaultRate !== undefined && p.defaultRate !== null,
      defaultRate: p.defaultRate,
      defaultRateType: p.defaultRateType,
      defaultCurrency: p.defaultCurrency,
      // Owner-operator info
      isOwnerOperator: p.isOwnerOperator,
      ownerDriverFirstName: p.ownerDriverFirstName,
      ownerDriverLastName: p.ownerDriverLastName,
      ownerDriverPhone: p.ownerDriverPhone,
    }));
  },
});

/**
 * List all broker partnerships for a carrier
 * (Used in carrier's mobile app to see who they work with)
 */
export const listForCarrier = query({
  args: {
    carrierOrgId: v.string(),
    status: v.optional(
      v.union(
        v.literal('ACTIVE'),
        v.literal('INVITED'),
        v.literal('PENDING'),
        v.literal('SUSPENDED'),
        v.literal('TERMINATED')
      )
    ),
  },
  handler: async (ctx, args) => {
    const partnerships = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_carrier', (q) => q.eq('carrierOrgId', args.carrierOrgId))
      .collect();

    // Filter by status if provided
    const filtered = args.status
      ? partnerships.filter((p) => p.status === args.status)
      : partnerships.filter((p) => p.status !== 'TERMINATED');

    // Enrich with broker org info
    return Promise.all(
      filtered.map(async (partnership) => {
        const brokerOrg = await ctx.db
          .query('organizations')
          .withIndex('by_organization', (q) =>
            q.eq('workosOrgId', partnership.brokerOrgId)
          )
          .first();
        return {
          ...partnership,
          brokerOrg,
        };
      })
    );
  },
});

/**
 * Get a single partnership by ID
 * Includes linked carrier org info and owner-operator data
 */
export const get = query({
  args: {
    partnershipId: v.id('carrierPartnerships'),
  },
  handler: async (ctx, args) => {
    const partnership = await ctx.db.get(args.partnershipId);
    if (!partnership) return null;

    // Enrich with carrier org info if linked
    let carrierOrg = null;
    let ownerDriver = null;
    
    if (partnership.carrierOrgId) {
      // Try finding by clerkOrgId first (mobile carriers), then workosOrgId
      carrierOrg = await ctx.db
        .query('organizations')
        .withIndex('by_clerk_org', (q) => q.eq('clerkOrgId', partnership.carrierOrgId!))
        .first();
      
      if (!carrierOrg) {
        carrierOrg = await ctx.db
          .query('organizations')
          .withIndex('by_organization', (q) => q.eq('workosOrgId', partnership.carrierOrgId!))
          .first();
      }

      // If carrier is owner-operator, get the linked driver
      if (carrierOrg?.isOwnerOperator && carrierOrg?.ownerDriverId) {
        ownerDriver = await ctx.db.get(carrierOrg.ownerDriverId);
      }
    }

    return {
      ...partnership,
      carrierOrg: carrierOrg ? {
        _id: carrierOrg._id,
        name: carrierOrg.name,
        orgType: carrierOrg.orgType,
        isOwnerOperator: carrierOrg.isOwnerOperator,
        ownerDriverId: carrierOrg.ownerDriverId,
      } : null,
      ownerDriver: ownerDriver ? {
        _id: ownerDriver._id,
        firstName: ownerDriver.firstName,
        lastName: ownerDriver.lastName,
        phone: ownerDriver.phone,
        email: ownerDriver.email,
        employmentStatus: ownerDriver.employmentStatus,
        licenseState: ownerDriver.licenseState,
        licenseExpiration: ownerDriver.licenseExpiration,
        licenseClass: ownerDriver.licenseClass,
      } : null,
    };
  },
});

/**
 * Find partnership by broker and MC number
 */
export const getByBrokerAndMc = query({
  args: {
    brokerOrgId: v.string(),
    mcNumber: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query('carrierPartnerships')
      .withIndex('by_broker_mc', (q) =>
        q.eq('brokerOrgId', args.brokerOrgId).eq('mcNumber', args.mcNumber)
      )
      .first();
  },
});

/**
 * Find all partnerships for an MC number
 * (Used when carrier signs up to auto-link existing partnerships)
 */
export const findByMcNumber = query({
  args: {
    mcNumber: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query('carrierPartnerships')
      .withIndex('by_mc', (q) => q.eq('mcNumber', args.mcNumber))
      .collect();
  },
});

// ==========================================
// MUTATIONS
// ==========================================

/**
 * Create a new carrier partnership
 * Called by broker when adding a carrier
 */
export const create = mutation({
  args: {
    brokerOrgId: v.string(),
    mcNumber: v.string(),
    carrierName: v.string(),
    usdotNumber: v.optional(v.string()),
    carrierDba: v.optional(v.string()),
    contactFirstName: v.optional(v.string()),
    contactLastName: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    insuranceProvider: v.optional(v.string()),
    insuranceExpiration: v.optional(v.string()),
    addressLine: v.optional(v.string()),
    addressLine2: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    country: v.optional(v.string()),
    defaultPaymentTerms: v.optional(v.string()),
    internalNotes: v.optional(v.string()),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Check if partnership already exists for this broker + MC#
    const existing = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_broker_mc', (q) =>
        q.eq('brokerOrgId', args.brokerOrgId).eq('mcNumber', args.mcNumber)
      )
      .first();

    if (existing) {
      throw new Error(
        `Partnership already exists for MC# ${args.mcNumber}. Use update instead.`
      );
    }

    // Check if carrier org exists with this MC#
    const carrierOrg = await ctx.db
      .query('organizations')
      .withIndex('by_mc', (q) => q.eq('mcNumber', args.mcNumber))
      .first();

    // Determine initial status and carrierOrgId
    let carrierOrgId: string | undefined = undefined;
    let status: 'ACTIVE' | 'PENDING' = 'ACTIVE';
    let linkedAt: number | undefined = undefined;

    if (carrierOrg) {
      // Carrier has an account - link and set to PENDING for carrier to accept
      carrierOrgId = carrierOrg.workosOrgId ?? carrierOrg.clerkOrgId;
      status = 'PENDING';
      linkedAt = now;
    }
    // If no carrier org, status stays ACTIVE (reference-only mode)

    // If no carrier org exists and we have contact info, create one for mobile access
    let newCarrierOrgId: Id<'organizations'> | undefined = undefined;
    let clerkUserCreated = false;

    if (!carrierOrg && args.contactPhone) {
      // Create a carrier organization for this carrier
      newCarrierOrgId = await ctx.db.insert('organizations', {
        orgType: 'CARRIER',
        name: args.carrierName,
        mcNumber: args.mcNumber,
        usdotNumber: args.usdotNumber,
        billingEmail: args.contactEmail || `${args.mcNumber}@placeholder.carrier`,
        billingPhone: args.contactPhone,
        billingAddress: {
          addressLine1: args.addressLine || '',
          addressLine2: args.addressLine2,
          city: args.city || '',
          state: args.state || '',
          zip: args.zip || '',
          country: args.country || 'USA',
        },
        insuranceProvider: args.insuranceProvider,
        insuranceExpiration: args.insuranceExpiration,
        subscriptionPlan: 'Free',
        subscriptionStatus: 'Active',
        billingCycle: 'N/A',
        createdAt: now,
        updatedAt: now,
      });

      // Use the new org ID as the carrier org identifier
      carrierOrgId = newCarrierOrgId;
      linkedAt = now;

      // Create userIdentityLinks for the carrier owner
      // We'll use a placeholder clerkUserId until they actually sign in
      // The phone-based matching in getUserRoles will find them
      await ctx.db.insert('userIdentityLinks', {
        clerkUserId: `pending_${args.contactPhone.replace(/\D/g, '')}`,
        organizationId: newCarrierOrgId,
        role: 'OWNER',
        phone: args.contactPhone,
        createdAt: now,
        updatedAt: now,
      });

      // Schedule Clerk user creation for mobile app access (uses syncSingleCarrierOwnerToClerk which updates the userIdentityLinks record)
      await ctx.scheduler.runAfter(0, internal.clerkSync.syncSingleCarrierOwnerToClerk, {
        organizationId: newCarrierOrgId,
        phone: args.contactPhone,
        firstName: args.contactFirstName || args.carrierName.split(' ')[0] || 'Owner',
        lastName: args.contactLastName || args.carrierName.split(' ').slice(1).join(' ') || '',
      });
      clerkUserCreated = true;
    }

    const partnershipId = await ctx.db.insert('carrierPartnerships', {
      brokerOrgId: args.brokerOrgId,
      carrierOrgId,
      mcNumber: args.mcNumber,
      usdotNumber: args.usdotNumber,
      carrierName: args.carrierName,
      carrierDba: args.carrierDba,
      contactFirstName: args.contactFirstName,
      contactLastName: args.contactLastName,
      contactEmail: args.contactEmail,
      contactPhone: args.contactPhone,
      insuranceProvider: args.insuranceProvider,
      insuranceExpiration: args.insuranceExpiration,
      addressLine: args.addressLine,
      addressLine2: args.addressLine2,
      city: args.city,
      state: args.state,
      zip: args.zip,
      country: args.country,
      status,
      defaultPaymentTerms: args.defaultPaymentTerms,
      internalNotes: args.internalNotes,
      createdAt: now,
      updatedAt: now,
      createdBy: args.createdBy,
      linkedAt,
    });

    return {
      partnershipId,
      status,
      isLinked: !!carrierOrgId,
      carrierOrgCreated: !!newCarrierOrgId,
      clerkUserCreated,
    };
  },
});

/**
 * Update carrier partnership info
 */
export const update = mutation({
  args: {
    partnershipId: v.id('carrierPartnerships'),
    // Carrier identification
    mcNumber: v.optional(v.string()),
    usdotNumber: v.optional(v.string()),
    // Company info
    carrierName: v.optional(v.string()),
    carrierDba: v.optional(v.string()),
    // Contact
    contactFirstName: v.optional(v.string()),
    contactLastName: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    // Insurance
    insuranceProvider: v.optional(v.string()),
    insuranceExpiration: v.optional(v.string()),
    insuranceCoverageVerified: v.optional(v.boolean()),
    // Address
    addressLine: v.optional(v.string()),
    addressLine2: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    country: v.optional(v.string()),
    // Broker preferences
    defaultPaymentTerms: v.optional(v.string()),
    internalNotes: v.optional(v.string()),
    preferredLanes: v.optional(v.array(v.string())),
    rating: v.optional(v.number()),
    // Owner-operator fields
    isOwnerOperator: v.optional(v.boolean()),
    ownerDriverFirstName: v.optional(v.string()),
    ownerDriverLastName: v.optional(v.string()),
    ownerDriverPhone: v.optional(v.string()),
    ownerDriverEmail: v.optional(v.string()),
    ownerDriverDOB: v.optional(v.string()),
    ownerDriverLicenseNumber: v.optional(v.string()),
    ownerDriverLicenseState: v.optional(v.string()),
    ownerDriverLicenseClass: v.optional(v.string()),
    ownerDriverLicenseExpiration: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { partnershipId, ...updates } = args;

    const partnership = await ctx.db.get(partnershipId);
    if (!partnership) {
      throw new Error('Partnership not found');
    }
    const now = Date.now();
    const previousOwnerPhone = partnership.ownerDriverPhone || partnership.contactPhone || null;

    // Remove undefined values
    const cleanUpdates: Record<string, unknown> = { updatedAt: now };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        cleanUpdates[key] = value;
      }
    }

    await ctx.db.patch(partnershipId, cleanUpdates);

    // If marking as owner-operator and there's a linked carrier org, create/link driver record
    const isNowOwnerOperator = updates.isOwnerOperator === true;
    const hasDriverInfo = updates.ownerDriverFirstName || updates.ownerDriverPhone;
    
    if (isNowOwnerOperator && partnership.carrierOrgId && (hasDriverInfo || partnership.ownerDriverFirstName)) {
      const carrierOrgId = partnership.carrierOrgId as Id<'organizations'>;
      const carrierOrg = await ctx.db.get(carrierOrgId);
      
      if (carrierOrg && !carrierOrg.ownerDriverId) {
        // Get phone for driver
        const driverPhone = (updates.ownerDriverPhone as string) || partnership.ownerDriverPhone || partnership.contactPhone;
        
        if (driverPhone) {
          // Check if driver already exists with this phone
          const existingDrivers = await ctx.db
            .query('drivers')
            .collect();
          
          const normalizedPhone = driverPhone.replace(/\D/g, '');
          const existingDriver = existingDrivers.find(d => {
            if (d.isDeleted) return false;
            const dPhone = d.phone.replace(/\D/g, '');
            return dPhone === normalizedPhone || 
                   dPhone.endsWith(normalizedPhone) || 
                   normalizedPhone.endsWith(dPhone);
          });

          if (!existingDriver) {
            // Create new driver record
            const driverId = await ctx.db.insert('drivers', {
              organizationId: carrierOrgId,
              firstName: (updates.ownerDriverFirstName as string) || partnership.ownerDriverFirstName || partnership.contactFirstName || 'Owner',
              lastName: (updates.ownerDriverLastName as string) || partnership.ownerDriverLastName || partnership.contactLastName || 'Operator',
              email: (updates.ownerDriverEmail as string) || partnership.ownerDriverEmail || partnership.contactEmail || '',
              phone: driverPhone,
              dateOfBirth: (updates.ownerDriverDOB as string) || partnership.ownerDriverDOB,
              employmentStatus: 'Active',
              employmentType: 'Owner-Operator',
              licenseNumber: (updates.ownerDriverLicenseNumber as string) || partnership.ownerDriverLicenseNumber,
              licenseState: (updates.ownerDriverLicenseState as string) || partnership.ownerDriverLicenseState || 'N/A',
              licenseClass: (updates.ownerDriverLicenseClass as string) || partnership.ownerDriverLicenseClass || 'Class A',
              licenseExpiration: (updates.ownerDriverLicenseExpiration as string) || partnership.ownerDriverLicenseExpiration || '2030-12-31',
              hireDate: new Date().toISOString().split('T')[0],
              createdBy: 'system',
              isDeleted: false,
              createdAt: now,
              updatedAt: now,
            });

            // Link driver to organization
            await ctx.db.patch(carrierOrgId, {
              ownerDriverId: driverId,
              isOwnerOperator: true,
              updatedAt: now,
            });
          } else {
            // Link existing driver to organization
            await ctx.db.patch(carrierOrgId, {
              ownerDriverId: existingDriver._id,
              isOwnerOperator: true,
              updatedAt: now,
            });
          }
        }
      }
    }
    // === BROKER → DRIVER SYNC: Update linked driver when partnership fields change ===
    if (partnership.carrierOrgId) {
      const carrierOrgId = partnership.carrierOrgId as Id<'organizations'>;
      const carrierOrg = await ctx.db.get(carrierOrgId);
      const nextOwnerPhone = updates.ownerDriverPhone ?? updates.contactPhone ?? previousOwnerPhone;
      
      // If org has a linked owner-driver, sync the updated fields
      if (carrierOrg?.ownerDriverId) {
        const ownerDriver = await ctx.db.get(carrierOrg.ownerDriverId);
        if (ownerDriver && !ownerDriver.isDeleted) {
          // Build driver updates from partnership changes
          const driverUpdates: Record<string, unknown> = { updatedAt: now };
          
          if (updates.ownerDriverFirstName !== undefined) driverUpdates.firstName = updates.ownerDriverFirstName;
          if (updates.ownerDriverLastName !== undefined) driverUpdates.lastName = updates.ownerDriverLastName;
          if (updates.ownerDriverPhone !== undefined) driverUpdates.phone = updates.ownerDriverPhone;
          if (updates.ownerDriverEmail !== undefined) driverUpdates.email = updates.ownerDriverEmail;
          if (updates.ownerDriverDOB !== undefined) driverUpdates.dateOfBirth = updates.ownerDriverDOB;
          if (updates.ownerDriverLicenseNumber !== undefined) driverUpdates.licenseNumber = updates.ownerDriverLicenseNumber;
          if (updates.ownerDriverLicenseState !== undefined) driverUpdates.licenseState = updates.ownerDriverLicenseState;
          if (updates.ownerDriverLicenseClass !== undefined) driverUpdates.licenseClass = updates.ownerDriverLicenseClass;
          if (updates.ownerDriverLicenseExpiration !== undefined) driverUpdates.licenseExpiration = updates.ownerDriverLicenseExpiration;
          
          // Only patch if there are actual driver field updates
          if (Object.keys(driverUpdates).length > 1) {
            await ctx.db.patch(carrierOrg.ownerDriverId, driverUpdates);
          }

          // Keep Clerk auth phone in sync when owner/operator phone changes from broker edit.
          if (
            typeof nextOwnerPhone === 'string' &&
            nextOwnerPhone.trim().length > 0 &&
            typeof ownerDriver.phone === 'string' &&
            nextOwnerPhone !== ownerDriver.phone
          ) {
            const identityLinks = await ctx.db
              .query('userIdentityLinks')
              .withIndex('by_org', (q) => q.eq('organizationId', carrierOrgId))
              .collect();
            const targetIdentityLink = identityLinks.find(
              (link) =>
                (link.role === 'OWNER' || link.role === 'ADMIN') &&
                !!link.clerkUserId &&
                !link.clerkUserId.startsWith('pending_')
            );

            await ctx.scheduler.runAfter(0, internal.clerkSync.updateClerkUserPhone, {
              oldPhone: ownerDriver.phone,
              newPhone: nextOwnerPhone,
              firstName: (updates.ownerDriverFirstName as string) || ownerDriver.firstName,
              lastName: (updates.ownerDriverLastName as string) || ownerDriver.lastName,
              targetClerkUserId: targetIdentityLink?.clerkUserId,
            });

            // Keep OWNER/ADMIN identity links aligned for phone-based role lookup.
            for (const link of identityLinks) {
              if (link.role === 'OWNER' || link.role === 'ADMIN') {
                await ctx.db.patch(link._id, {
                  phone: nextOwnerPhone,
                  updatedAt: now,
                });
              }
            }
          }
        }
      }
    }

    return { success: true };
  },
});

/**
 * Update partnership status
 * When reactivating (to ACTIVE), creates org and syncs to Clerk if missing
 */
export const updateStatus = mutation({
  args: {
    partnershipId: v.id('carrierPartnerships'),
    status: v.union(
      v.literal('ACTIVE'),
      v.literal('INVITED'),
      v.literal('PENDING'),
      v.literal('SUSPENDED'),
      v.literal('TERMINATED')
    ),
  },
  handler: async (ctx, args) => {
    const partnership = await ctx.db.get(args.partnershipId);
    if (!partnership) {
      throw new Error('Partnership not found');
    }

    const now = Date.now();
    let carrierOrgCreated = false;
    let clerkSyncScheduled = false;

    // When reactivating to ACTIVE and no carrierOrgId exists, create org and sync to Clerk
    if (args.status === 'ACTIVE' && !partnership.carrierOrgId) {
      // Get phone from owner-operator fields or contact info
      const phone = partnership.ownerDriverPhone || partnership.contactPhone;
      
      if (phone) {
        // Check if org already exists by MC#
        const existingOrg = await ctx.db
          .query('organizations')
          .withIndex('by_mc', (q) => q.eq('mcNumber', partnership.mcNumber))
          .first();

        let newCarrierOrgId: Id<'organizations'>;
        
        if (existingOrg) {
          // Link to existing org
          newCarrierOrgId = existingOrg._id;
        } else {
          // Create new carrier organization
          newCarrierOrgId = await ctx.db.insert('organizations', {
            orgType: 'CARRIER',
            name: partnership.carrierName,
            mcNumber: partnership.mcNumber,
            usdotNumber: partnership.usdotNumber,
            billingEmail: partnership.contactEmail || `${partnership.mcNumber}@placeholder.carrier`,
            billingPhone: phone,
            billingAddress: {
              addressLine1: partnership.addressLine || '',
              addressLine2: partnership.addressLine2,
              city: partnership.city || '',
              state: partnership.state || '',
              zip: partnership.zip || '',
              country: partnership.country || 'USA',
            },
            insuranceProvider: partnership.insuranceProvider,
            insuranceExpiration: partnership.insuranceExpiration,
            // Set owner-operator if applicable
            isOwnerOperator: partnership.isOwnerOperator,
            subscriptionPlan: 'Free',
            subscriptionStatus: 'Active',
            billingCycle: 'N/A',
            createdAt: now,
            updatedAt: now,
          });
          carrierOrgCreated = true;
        }

        // Check if userIdentityLinks already exists for this org
        const existingLink = await ctx.db
          .query('userIdentityLinks')
          .withIndex('by_org', (q) => q.eq('organizationId', newCarrierOrgId))
          .first();

        if (!existingLink) {
          // Create userIdentityLinks for the carrier owner
          await ctx.db.insert('userIdentityLinks', {
            clerkUserId: `pending_${phone.replace(/\D/g, '')}`,
            organizationId: newCarrierOrgId,
            role: 'OWNER',
            phone: phone,
            createdAt: now,
            updatedAt: now,
          });
        }

        // Update partnership with the carrierOrgId
        await ctx.db.patch(args.partnershipId, {
          carrierOrgId: newCarrierOrgId,
          linkedAt: now,
        });

        // Schedule Clerk user creation for mobile app access
        const firstName = partnership.ownerDriverFirstName || partnership.contactFirstName || partnership.carrierName.split(' ')[0] || 'Owner';
        const lastName = partnership.ownerDriverLastName || partnership.contactLastName || partnership.carrierName.split(' ').slice(1).join(' ') || '';
        
        await ctx.scheduler.runAfter(0, internal.clerkSync.syncSingleCarrierOwnerToClerk, {
          organizationId: newCarrierOrgId,
          phone: phone,
          firstName,
          lastName,
          // Note: email removed - Clerk instance uses phone-only auth
        });
        clerkSyncScheduled = true;

        // Create driver record for owner-operators
        if (partnership.isOwnerOperator) {
          // Check if driver already exists with this phone
          const existingDrivers = await ctx.db
            .query('drivers')
            .collect();
          
          const normalizedPhone = phone.replace(/\D/g, '');
          const existingDriver = existingDrivers.find(d => {
            if (d.isDeleted) return false;
            const driverPhone = d.phone.replace(/\D/g, '');
            return driverPhone === normalizedPhone || 
                   driverPhone.endsWith(normalizedPhone) || 
                   normalizedPhone.endsWith(driverPhone);
          });

          if (!existingDriver) {
            // Create new driver record for owner-operator
            const driverId = await ctx.db.insert('drivers', {
              organizationId: newCarrierOrgId,
              firstName: partnership.ownerDriverFirstName || partnership.contactFirstName || 'Owner',
              lastName: partnership.ownerDriverLastName || partnership.contactLastName || 'Operator',
              email: partnership.ownerDriverEmail || partnership.contactEmail || '',
              phone: partnership.ownerDriverPhone || phone,
              dateOfBirth: partnership.ownerDriverDOB,
              employmentStatus: 'Active',
              employmentType: 'Owner-Operator',
              licenseNumber: partnership.ownerDriverLicenseNumber,
              licenseState: partnership.ownerDriverLicenseState || 'N/A',
              licenseClass: partnership.ownerDriverLicenseClass || 'Class A',
              licenseExpiration: partnership.ownerDriverLicenseExpiration || '2030-12-31',
              hireDate: new Date().toISOString().split('T')[0],
              createdBy: 'system',
              isDeleted: false,
              createdAt: now,
              updatedAt: now,
            });

            // Link driver to organization as owner-operator
            await ctx.db.patch(newCarrierOrgId, {
              ownerDriverId: driverId,
              isOwnerOperator: true,
              updatedAt: now,
            });
          } else {
            // Link existing driver to organization
            await ctx.db.patch(newCarrierOrgId, {
              ownerDriverId: existingDriver._id,
              isOwnerOperator: true,
              updatedAt: now,
            });
          }
        }
      }
    }

    // If terminating, release all active load assignments
    let releasedAssignments = 0;
    let loadsReopened = 0;
    if (args.status === 'TERMINATED' && partnership.status !== 'TERMINATED') {
      const releaseResult = await releasePartnershipAssignments(
        ctx,
        partnership,
        'system',
        'System - Partnership Terminated'
      );
      releasedAssignments = releaseResult.releasedCount;
      loadsReopened = releaseResult.loadsReopened;
    }

    // Build the patch object
    const patchData: Record<string, unknown> = {
      status: args.status,
      updatedAt: now,
    };

    // IMPORTANT: If we created/linked a carrier org, save the carrierOrgId to the partnership
    if (args.status === 'ACTIVE' && !partnership.carrierOrgId) {
      // Find the org we created/linked earlier in this handler
      const phone = partnership.ownerDriverPhone || partnership.contactPhone;
      if (phone) {
        // Re-query to get the org ID (it was created earlier in this handler)
        const linkedOrg = await ctx.db
          .query('organizations')
          .withIndex('by_mc', (q) => q.eq('mcNumber', partnership.mcNumber))
          .first();
        
        if (linkedOrg && !linkedOrg.isDeleted) {
          patchData.carrierOrgId = linkedOrg._id;
          patchData.linkedAt = now;
        }
      }
    }

    await ctx.db.patch(args.partnershipId, patchData);

    return { 
      success: true,
      carrierOrgCreated,
      clerkSyncScheduled,
      releasedAssignments,
      loadsReopened,
    };
  },
});

/**
 * Retry Clerk sync for an existing partnership
 * Used when the initial sync failed or needs to be re-triggered
 */
export const retryClerkSync = mutation({
  args: {
    partnershipId: v.id('carrierPartnerships'),
  },
  handler: async (ctx, args) => {
    const partnership = await ctx.db.get(args.partnershipId);
    if (!partnership) {
      throw new Error('Partnership not found');
    }

    if (!partnership.carrierOrgId) {
      throw new Error('Partnership has no linked organization');
    }

    // Get the organization
    const org = await ctx.db.get(partnership.carrierOrgId as Id<'organizations'>);
    if (!org) {
      throw new Error('Linked organization not found');
    }

    // Get phone from owner-operator fields or contact info
    const phone = partnership.ownerDriverPhone || partnership.contactPhone;
    if (!phone) {
      throw new Error('No phone number available for Clerk sync');
    }

    const firstName = partnership.ownerDriverFirstName || partnership.contactFirstName || partnership.carrierName.split(' ')[0] || 'Owner';
    const lastName = partnership.ownerDriverLastName || partnership.contactLastName || partnership.carrierName.split(' ').slice(1).join(' ') || '';

    // Schedule Clerk user creation
    await ctx.scheduler.runAfter(0, internal.clerkSync.syncSingleCarrierOwnerToClerk, {
      organizationId: partnership.carrierOrgId as Id<'organizations'>,
      phone: phone,
      firstName,
      lastName,
    });

    return { success: true, phone, firstName, lastName };
  },
});

/**
 * Create driver record for existing owner-operator partnerships
 * Used to fix owner-operators that were created before driver auto-creation was implemented
 */
export const createOwnerDriverRecord = mutation({
  args: {
    partnershipId: v.id('carrierPartnerships'),
  },
  handler: async (ctx, args) => {
    const partnership = await ctx.db.get(args.partnershipId);
    if (!partnership) {
      throw new Error('Partnership not found');
    }

    if (!partnership.isOwnerOperator) {
      throw new Error('Partnership is not marked as owner-operator');
    }

    if (!partnership.carrierOrgId) {
      throw new Error('Partnership has no linked organization');
    }

    const org = await ctx.db.get(partnership.carrierOrgId as Id<'organizations'>);
    if (!org) {
      throw new Error('Linked organization not found');
    }

    // Check if driver already linked
    if (org.ownerDriverId) {
      const existingDriver = await ctx.db.get(org.ownerDriverId);
      if (existingDriver && !existingDriver.isDeleted) {
        return { success: true, driverExists: true, driverId: existingDriver._id };
      }
    }

    const now = Date.now();
    const phone = partnership.ownerDriverPhone || partnership.contactPhone;
    
    if (!phone) {
      throw new Error('No phone number available for driver record');
    }

    // Check if driver already exists with this phone
    const existingDrivers = await ctx.db.query('drivers').collect();
    const normalizedPhone = phone.replace(/\D/g, '');
    const existingDriver = existingDrivers.find(d => {
      if (d.isDeleted) return false;
      const driverPhone = d.phone.replace(/\D/g, '');
      return driverPhone === normalizedPhone || 
             driverPhone.endsWith(normalizedPhone) || 
             normalizedPhone.endsWith(driverPhone);
    });

    let driverId: Id<'drivers'>;

    if (existingDriver) {
      // Link existing driver to organization
      driverId = existingDriver._id;
    } else {
      // Create new driver record
      driverId = await ctx.db.insert('drivers', {
        organizationId: partnership.carrierOrgId as Id<'organizations'>,
        firstName: partnership.ownerDriverFirstName || partnership.contactFirstName || 'Owner',
        lastName: partnership.ownerDriverLastName || partnership.contactLastName || 'Operator',
        email: partnership.ownerDriverEmail || partnership.contactEmail || '',
        phone: phone,
        dateOfBirth: partnership.ownerDriverDOB,
        employmentStatus: 'Active',
        employmentType: 'Owner-Operator',
        licenseNumber: partnership.ownerDriverLicenseNumber,
        licenseState: partnership.ownerDriverLicenseState || 'N/A',
        licenseClass: partnership.ownerDriverLicenseClass || 'Class A',
        licenseExpiration: partnership.ownerDriverLicenseExpiration || '2030-12-31',
        hireDate: new Date().toISOString().split('T')[0],
        createdBy: 'system',
        isDeleted: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Link driver to organization
    await ctx.db.patch(partnership.carrierOrgId as Id<'organizations'>, {
      ownerDriverId: driverId,
      isOwnerOperator: true,
      updatedAt: now,
    });

    return { success: true, driverCreated: !existingDriver, driverId };
  },
});

/**
 * Carrier accepts a pending partnership
 * (Called from carrier's mobile app)
 */
export const accept = mutation({
  args: {
    partnershipId: v.id('carrierPartnerships'),
    carrierOrgId: v.string(), // Carrier's org ID for verification
  },
  handler: async (ctx, args) => {
    const partnership = await ctx.db.get(args.partnershipId);
    if (!partnership) {
      throw new Error('Partnership not found');
    }

    if (partnership.carrierOrgId !== args.carrierOrgId) {
      throw new Error('Partnership does not belong to this carrier');
    }

    if (partnership.status !== 'PENDING') {
      throw new Error('Partnership is not pending acceptance');
    }

    await ctx.db.patch(args.partnershipId, {
      status: 'ACTIVE',
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Carrier declines a pending partnership
 */
export const decline = mutation({
  args: {
    partnershipId: v.id('carrierPartnerships'),
    carrierOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const partnership = await ctx.db.get(args.partnershipId);
    if (!partnership) {
      throw new Error('Partnership not found');
    }

    if (partnership.carrierOrgId !== args.carrierOrgId) {
      throw new Error('Partnership does not belong to this carrier');
    }

    if (partnership.status !== 'PENDING') {
      throw new Error('Partnership is not pending');
    }

    await ctx.db.patch(args.partnershipId, {
      status: 'TERMINATED',
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Link existing partnerships when carrier signs up
 * Called during carrier org creation
 */
export const linkToCarrierOrg = mutation({
  args: {
    mcNumber: v.string(),
    carrierOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Find all unlinked partnerships with this MC#
    const partnerships = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_mc', (q) => q.eq('mcNumber', args.mcNumber))
      .collect();

    const unlinked = partnerships.filter((p) => !p.carrierOrgId);

    // Link each partnership
    const linked: Id<'carrierPartnerships'>[] = [];
    for (const partnership of unlinked) {
      await ctx.db.patch(partnership._id, {
        carrierOrgId: args.carrierOrgId,
        status: 'PENDING', // Carrier needs to accept each broker
        linkedAt: now,
        updatedAt: now,
      });
      linked.push(partnership._id);
    }

    return {
      linkedCount: linked.length,
      partnershipIds: linked,
    };
  },
});

/**
 * Sync carrier info from org to partnerships
 * Called when carrier updates their org info
 */
export const syncFromCarrierOrg = mutation({
  args: {
    carrierOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Get carrier org
    const carrierOrg = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.carrierOrgId))
      .first();

    if (!carrierOrg) {
      // Try clerkOrgId
      const carrierOrgByClerk = await ctx.db
        .query('organizations')
        .withIndex('by_clerk_org', (q) => q.eq('clerkOrgId', args.carrierOrgId))
        .first();

      if (!carrierOrgByClerk) {
        throw new Error('Carrier organization not found');
      }
    }

    const org = carrierOrg;
    if (!org) {
      throw new Error('Carrier organization not found');
    }

    // Find all partnerships for this carrier
    const partnerships = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_carrier', (q) => q.eq('carrierOrgId', args.carrierOrgId))
      .collect();

    // Update each partnership with current org info
    for (const partnership of partnerships) {
      await ctx.db.patch(partnership._id, {
        carrierName: org.name,
        insuranceProvider: org.insuranceProvider,
        insuranceExpiration: org.insuranceExpiration,
        updatedAt: now,
      });
    }

    return {
      syncedCount: partnerships.length,
    };
  },
});

/**
 * Helper: Release all active load assignments for a terminated partnership
 * Cancels OFFERED, ACCEPTED, AWARDED, IN_PROGRESS assignments and reopens loads
 */
async function releasePartnershipAssignments(
  ctx: { db: any; runMutation: any },
  partnership: { brokerOrgId: string; carrierOrgId?: string; carrierName: string; mcNumber: string; _id?: any },
  userId: string,
  userName?: string
): Promise<{ releasedCount: number; loadsReopened: number }> {
  if (!partnership.carrierOrgId) {
    return { releasedCount: 0, loadsReopened: 0 };
  }

  const now = Date.now();
  let releasedCount = 0;
  let loadsReopened = 0;

  // Find all active assignments for this partnership
  // Try TWO approaches: by carrierOrgId AND by partnershipId
  const activeStatuses = ['OFFERED', 'ACCEPTED', 'AWARDED', 'IN_PROGRESS'] as const;
  
  for (const status of activeStatuses) {
    // Method 1: Query by carrierOrgId (original)
    let assignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier', (q: any) => 
        q.eq('carrierOrgId', partnership.carrierOrgId).eq('status', status)
      )
      .collect();

    // Filter to only assignments from this broker
    let brokerAssignments = assignments.filter(
      (a: any) => a.brokerOrgId === partnership.brokerOrgId
    );
    
    // Method 2: If no results, try finding by partnershipId (scan all broker assignments)
    if (brokerAssignments.length === 0 && partnership._id) {
      const allBrokerAssignments = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_broker', (q: any) => q.eq('brokerOrgId', partnership.brokerOrgId).eq('status', status))
        .collect();
      
      brokerAssignments = allBrokerAssignments.filter(
        (a: any) => String(a.partnershipId) === String(partnership._id)
      );
    }

    for (const assignment of brokerAssignments) {
      // Cancel the assignment
      await ctx.db.patch(assignment._id, {
        status: 'CANCELED',
        canceledAt: now,
        canceledBy: userId,
        canceledByParty: 'BROKER',
        cancellationReason: 'OTHER',
        cancellationNotes: `Partnership terminated with ${partnership.carrierName}`,
      });
      releasedCount++;

      // If this was an AWARDED or IN_PROGRESS assignment, reopen the load
      if (status === 'AWARDED' || status === 'IN_PROGRESS') {
        const load = await ctx.db.get(assignment.loadId);
        if (load && load.status === 'Assigned') {
          await ctx.db.patch(assignment.loadId, {
            status: 'Open',
            trackingStatus: 'Pending',
            updatedAt: now,
          });
          loadsReopened++;
        }
      }
    }
  }

  return { releasedCount, loadsReopened };
}

/**
 * Bulk terminate partnerships
 * Used for bulk deactivation from the carrier list
 * Also releases all active load assignments and reopens affected loads
 */
export const bulkTerminate = mutation({
  args: {
    partnershipIds: v.array(v.id('carrierPartnerships')),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const results: { id: string; success: boolean; error?: string; releasedAssignments?: number; loadsReopened?: number }[] = [];
    let totalReleasedAssignments = 0;
    let totalLoadsReopened = 0;

    for (const partnershipId of args.partnershipIds) {
      try {
        const partnership = await ctx.db.get(partnershipId);
        if (!partnership) {
          results.push({ id: partnershipId, success: false, error: 'Partnership not found' });
          continue;
        }

        if (partnership.status === 'TERMINATED') {
          results.push({ id: partnershipId, success: true, releasedAssignments: 0, loadsReopened: 0 }); // Already terminated
          continue;
        }

        // Release all active load assignments for this partnership
        const { releasedCount, loadsReopened } = await releasePartnershipAssignments(
          ctx,
          { ...partnership, _id: partnershipId },
          args.userId,
          args.userName
        );
        totalReleasedAssignments += releasedCount;
        totalLoadsReopened += loadsReopened;

        // Terminate the partnership
        await ctx.db.patch(partnershipId, {
          status: 'TERMINATED',
          updatedAt: now,
        });
        
        // === CASCADE: Soft-delete carrier organization and drivers ===
        let driversDeactivated = 0;
        let orgDeactivated = false;
        
        if (partnership.carrierOrgId) {
          // Try to find the carrier organization by the carrierOrgId
          // It could be a Convex ID, clerkOrgId, or workosOrgId
          let carrierOrg = null;
          
          // Try as Convex ID first
          try {
            carrierOrg = await ctx.db.get(partnership.carrierOrgId as Id<'organizations'>);
          } catch {
            // Not a valid Convex ID, try as clerkOrgId
            carrierOrg = await ctx.db
              .query('organizations')
              .withIndex('by_clerk_org', (q) => q.eq('clerkOrgId', partnership.carrierOrgId!))
              .first();
          }
          
          if (carrierOrg && !carrierOrg.isDeleted) {
            // Soft-delete all drivers in this organization
            const drivers = await ctx.db
              .query('drivers')
              .withIndex('by_organization', (q) => q.eq('organizationId', carrierOrg!._id))
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
                driversDeactivated++;
              }
            }
            
            // Soft-delete the organization itself
            await ctx.db.patch(carrierOrg._id, {
              isDeleted: true,
              deletedAt: now,
              deletedBy: args.userId,
              deletionReason: `Partnership terminated by broker`,
              updatedAt: now,
            });
            orgDeactivated = true;
            
            // Delete user identity links for this org (blocks mobile access)
            // Also capture Clerk user ID or phone to delete
            const identityLinks = await ctx.db
              .query('userIdentityLinks')
              .withIndex('by_org', (q) => q.eq('organizationId', carrierOrg!._id))
              .collect();
            
            for (const link of identityLinks) {
              // Schedule Clerk user deletion to free up phone number
              if (link.clerkUserId && !link.clerkUserId.startsWith('pending_')) {
                // Have actual Clerk user ID - delete by ID
                await ctx.scheduler.runAfter(0, internal.clerkSync.deleteClerkUserById, {
                  clerkUserId: link.clerkUserId,
                  reason: `Partnership terminated for ${partnership.carrierName}`,
                });
              } else if (link.phone) {
                // Clerk user might exist but link wasn't updated - delete by phone
                await ctx.scheduler.runAfter(0, internal.clerkSync.deleteClerkUser, {
                  phone: link.phone,
                });
              }
              await ctx.db.delete(link._id);
            }
          }
        }

        // Log to audit
        await ctx.runMutation(internal.auditLog.logAction, {
          organizationId: partnership.brokerOrgId,
          entityType: 'carrierPartnership',
          entityId: partnershipId,
          entityName: partnership.carrierName,
          action: 'terminated',
          performedBy: args.userId,
          performedByName: args.userName,
          description: `Terminated partnership with ${partnership.carrierName} (MC# ${partnership.mcNumber}). Released ${releasedCount} assignments, reopened ${loadsReopened} loads. ${orgDeactivated ? `Deactivated carrier org and ${driversDeactivated} drivers. Clerk user deleted.` : ''}`,
        });

        results.push({ id: partnershipId, success: true, releasedAssignments: releasedCount, loadsReopened });
      } catch (error) {
        results.push({ id: partnershipId, success: false, error: String(error) });
      }
    }

    return {
      results,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      totalReleasedAssignments,
      totalLoadsReopened,
    };
  },
});

/**
 * Bulk reactivate terminated partnerships
 * Used to restore partnerships from the Terminated tab
 * Sets status back to ACTIVE and optionally creates carrier org/Clerk user if missing
 */
export const bulkReactivate = mutation({
  args: {
    partnershipIds: v.array(v.id('carrierPartnerships')),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const results: { id: string; success: boolean; error?: string; carrierOrgCreated?: boolean; carrierOrgRestored?: boolean; clerkSyncScheduled?: boolean }[] = [];

    for (const partnershipId of args.partnershipIds) {
      try {
        const partnership = await ctx.db.get(partnershipId);
        if (!partnership) {
          results.push({ id: partnershipId, success: false, error: 'Partnership not found' });
          continue;
        }

        if (partnership.status === 'ACTIVE') {
          results.push({ id: partnershipId, success: true }); // Already active
          continue;
        }

        let carrierOrgCreated = false;
        let carrierOrgRestored = false;
        let clerkSyncScheduled = false;
        const phone = partnership.ownerDriverPhone || partnership.contactPhone;

        // Check if carrierOrgId exists and handle accordingly
        if (partnership.carrierOrgId) {
          // Try to find the existing org
          let carrierOrg = null;
          try {
            carrierOrg = await ctx.db.get(partnership.carrierOrgId as Id<'organizations'>);
          } catch {
            // Not a valid Convex ID, try as clerkOrgId
            carrierOrg = await ctx.db
              .query('organizations')
              .withIndex('by_clerk_org', (q) => q.eq('clerkOrgId', partnership.carrierOrgId!))
              .first();
          }
          
          if (carrierOrg) {
            // Org exists - restore it if deleted
            if (carrierOrg.isDeleted) {
              await ctx.db.patch(carrierOrg._id, {
                isDeleted: false,
                deletedAt: undefined,
                deletedBy: undefined,
                deletionReason: undefined,
                updatedAt: now,
              });
              carrierOrgRestored = true;
              
              // Also restore any soft-deleted drivers
              const deletedDrivers = await ctx.db
                .query('drivers')
                .withIndex('by_organization', (q) => q.eq('organizationId', carrierOrg!._id))
                .collect();
              
              for (const driver of deletedDrivers) {
                if (driver.isDeleted) {
                  await ctx.db.patch(driver._id, {
                    isDeleted: false,
                    deletedAt: undefined,
                    deletedBy: undefined,
                    employmentStatus: 'Active',
                    updatedAt: now,
                  });
                }
              }
            }
            
            // Check if identity link exists - recreate if missing
            const existingLink = await ctx.db
              .query('userIdentityLinks')
              .withIndex('by_org', (q) => q.eq('organizationId', carrierOrg._id))
              .first();
            
            if (!existingLink && phone) {
              await ctx.db.insert('userIdentityLinks', {
                clerkUserId: `pending_${phone.replace(/\D/g, '')}`,
                organizationId: carrierOrg._id,
                role: 'OWNER',
                phone: phone,
                createdAt: now,
                updatedAt: now,
              });
              
              // Schedule Clerk user creation
              const firstName = partnership.ownerDriverFirstName || partnership.contactFirstName || partnership.carrierName.split(' ')[0] || 'Owner';
              const lastName = partnership.ownerDriverLastName || partnership.contactLastName || partnership.carrierName.split(' ').slice(1).join(' ') || '';
              
              await ctx.scheduler.runAfter(0, internal.clerkSync.syncSingleCarrierOwnerToClerk, {
                organizationId: carrierOrg._id,
                phone: phone,
                firstName,
                lastName,
              });
              clerkSyncScheduled = true;
            }
          }
        }
        
        // If no carrierOrgId exists, create org and sync to Clerk
        if (!partnership.carrierOrgId && phone) {
          // Check if org already exists by MC#
          const existingOrg = await ctx.db
            .query('organizations')
            .withIndex('by_mc', (q) => q.eq('mcNumber', partnership.mcNumber))
            .first();

          let newCarrierOrgId: Id<'organizations'>;
          
          if (existingOrg) {
            newCarrierOrgId = existingOrg._id;
            // Restore if deleted
            if (existingOrg.isDeleted) {
              await ctx.db.patch(existingOrg._id, {
                isDeleted: false,
                deletedAt: undefined,
                deletedBy: undefined,
                deletionReason: undefined,
                updatedAt: now,
              });
              carrierOrgRestored = true;
            }
          } else {
            // Create new carrier organization
            newCarrierOrgId = await ctx.db.insert('organizations', {
              orgType: 'CARRIER',
              name: partnership.carrierName,
              mcNumber: partnership.mcNumber,
              usdotNumber: partnership.usdotNumber,
              billingEmail: partnership.contactEmail || `${partnership.mcNumber}@placeholder.carrier`,
              billingPhone: phone,
              billingAddress: {
                addressLine1: partnership.addressLine || '',
                addressLine2: partnership.addressLine2,
                city: partnership.city || '',
                state: partnership.state || '',
                zip: partnership.zip || '',
                country: partnership.country || 'USA',
              },
              insuranceProvider: partnership.insuranceProvider,
              insuranceExpiration: partnership.insuranceExpiration,
              isOwnerOperator: partnership.isOwnerOperator,
              subscriptionPlan: 'Free',
              subscriptionStatus: 'Active',
              billingCycle: 'N/A',
              createdAt: now,
              updatedAt: now,
            });
            carrierOrgCreated = true;
          }

          // Check if userIdentityLinks already exists for this org
          const existingLink = await ctx.db
            .query('userIdentityLinks')
            .withIndex('by_org', (q) => q.eq('organizationId', newCarrierOrgId))
            .first();

          if (!existingLink) {
            await ctx.db.insert('userIdentityLinks', {
              clerkUserId: `pending_${phone.replace(/\D/g, '')}`,
              organizationId: newCarrierOrgId,
              role: 'OWNER',
              phone: phone,
              createdAt: now,
              updatedAt: now,
            });
          }

          // Update partnership with the carrierOrgId
          await ctx.db.patch(partnershipId, {
            carrierOrgId: newCarrierOrgId,
            linkedAt: now,
          });

          // Schedule Clerk user creation
          const firstName = partnership.ownerDriverFirstName || partnership.contactFirstName || partnership.carrierName.split(' ')[0] || 'Owner';
          const lastName = partnership.ownerDriverLastName || partnership.contactLastName || partnership.carrierName.split(' ').slice(1).join(' ') || '';
          
          await ctx.scheduler.runAfter(0, internal.clerkSync.syncSingleCarrierOwnerToClerk, {
            organizationId: newCarrierOrgId,
            phone: phone,
            firstName,
            lastName,
          });
          clerkSyncScheduled = true;
        }

        // Reactivate the partnership
        await ctx.db.patch(partnershipId, {
          status: 'ACTIVE',
          updatedAt: now,
        });

        // Log to audit
        await ctx.runMutation(internal.auditLog.logAction, {
          organizationId: partnership.brokerOrgId,
          entityType: 'carrierPartnership',
          entityId: partnershipId,
          entityName: partnership.carrierName,
          action: 'reactivated',
          performedBy: args.userId,
          performedByName: args.userName,
          description: `Reactivated partnership with ${partnership.carrierName} (MC# ${partnership.mcNumber})`,
        });

        results.push({ id: partnershipId, success: true, carrierOrgCreated, carrierOrgRestored, clerkSyncScheduled });
      } catch (error) {
        results.push({ id: partnershipId, success: false, error: String(error) });
      }
    }

    return {
      results,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      carrierOrgsCreated: results.filter((r) => r.carrierOrgCreated).length,
      carrierOrgsRestored: results.filter((r) => r.carrierOrgRestored).length,
      clerkSyncsScheduled: results.filter((r) => r.clerkSyncScheduled).length,
    };
  },
});

/**
 * Permanently delete terminated partnerships
 * DESTRUCTIVE: Hard deletes all carrier data including:
 * - Partnership record
 * - Carrier organization
 * - All drivers in the organization
 * - User identity links
 * - Rate profiles and contracts
 * - Schedules Clerk user deletion
 * 
 * Only works for TERMINATED partnerships to prevent accidental data loss
 */
export const permanentlyDelete = mutation({
  args: {
    partnershipIds: v.array(v.id('carrierPartnerships')),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const results: { 
      id: string; 
      success: boolean; 
      error?: string;
      deletedOrg?: boolean;
      deletedDrivers?: number;
      deletedAssignments?: number;
      clerkUserDeleted?: boolean;
    }[] = [];

    for (const partnershipId of args.partnershipIds) {
      try {
        const partnership = await ctx.db.get(partnershipId);
        if (!partnership) {
          results.push({ id: partnershipId, success: false, error: 'Partnership not found' });
          continue;
        }

        // Only allow permanent deletion of TERMINATED partnerships
        if (partnership.status !== 'TERMINATED') {
          results.push({ 
            id: partnershipId, 
            success: false, 
            error: `Cannot permanently delete partnership with status "${partnership.status}". Must be TERMINATED first.` 
          });
          continue;
        }

        let deletedOrg = false;
        let deletedDrivers = 0;
        let deletedAssignments = 0;
        let clerkUserDeleted = false;
        let clerkUserIdToDelete: string | null = null;
        let phoneToFree: string | null = null;

        // === 1. Find and delete carrier organization ===
        if (partnership.carrierOrgId) {
          let carrierOrg = null;
          
          // Try as Convex ID first
          try {
            carrierOrg = await ctx.db.get(partnership.carrierOrgId as Id<'organizations'>);
          } catch {
            // Not a valid Convex ID, try as clerkOrgId
            carrierOrg = await ctx.db
              .query('organizations')
              .withIndex('by_clerk_org', (q) => q.eq('clerkOrgId', partnership.carrierOrgId!))
              .first();
          }
          
          if (carrierOrg) {
            // === 2. Delete all drivers in this organization ===
            const drivers = await ctx.db
              .query('drivers')
              .withIndex('by_organization', (q) => q.eq('organizationId', carrierOrg!._id))
              .collect();
            
            for (const driver of drivers) {
              // Delete driver locations
              const driverLocations = await ctx.db
                .query('driverLocations')
                .withIndex('by_driver_time', (q) => q.eq('driverId', driver._id))
                .collect();
              for (const loc of driverLocations) {
                await ctx.db.delete(loc._id);
              }
              
              // Delete the driver
              await ctx.db.delete(driver._id);
              deletedDrivers++;
            }
            
            // === 3. Delete user identity links and get Clerk user ID ===
            const identityLinks = await ctx.db
              .query('userIdentityLinks')
              .withIndex('by_org', (q) => q.eq('organizationId', carrierOrg!._id))
              .collect();
            
            for (const link of identityLinks) {
              // Capture the Clerk user ID for deletion
              if (link.clerkUserId && !link.clerkUserId.startsWith('pending_')) {
                clerkUserIdToDelete = link.clerkUserId;
              }
              // Capture phone for freeing (use as fallback if clerkUserId is pending)
              if (link.phone) {
                phoneToFree = link.phone;
              }
              await ctx.db.delete(link._id);
            }
            
            // === 4. Delete notification preferences ===
            const notifPrefs = await ctx.db
              .query('notificationPreferences')
              .filter((q) => q.eq(q.field('organizationId'), carrierOrg!._id))
              .collect();
            for (const pref of notifPrefs) {
              await ctx.db.delete(pref._id);
            }
            
            // === 5. Hard delete the organization ===
            await ctx.db.delete(carrierOrg._id);
            deletedOrg = true;
          }
        }
        
        // === 7. Delete all load assignments for this partnership ===
        // Get all assignments (any status) for this partnership
        const allAssignments = await ctx.db
          .query('loadCarrierAssignments')
          .withIndex('by_broker', (q) => q.eq('brokerOrgId', partnership.brokerOrgId))
          .collect();
        
        const partnershipAssignments = allAssignments.filter(
          (a) => String(a.partnershipId) === String(partnershipId) ||
                 (partnership.carrierOrgId && a.carrierOrgId === partnership.carrierOrgId)
        );
        
        for (const assignment of partnershipAssignments) {
          // Only delete COMPLETED, CANCELED, DECLINED, or WITHDRAWN assignments
          // For safety, don't delete active assignments
          if (['COMPLETED', 'CANCELED', 'DECLINED', 'WITHDRAWN'].includes(assignment.status)) {
            await ctx.db.delete(assignment._id);
            deletedAssignments++;
          }
        }
        
        // === 8. Delete the partnership itself ===
        await ctx.db.delete(partnershipId);
        
        // === 9. Schedule Clerk user deletion ===
        if (clerkUserIdToDelete) {
          // Have actual Clerk user ID - delete by ID
          await ctx.scheduler.runAfter(0, internal.clerkSync.deleteClerkUserById, {
            clerkUserId: clerkUserIdToDelete,
            reason: `Partnership permanently deleted for ${partnership.carrierName}`,
          });
          clerkUserDeleted = true;
        } else if (phoneToFree) {
          // Clerk user might exist but link wasn't updated - delete by phone
          await ctx.scheduler.runAfter(0, internal.clerkSync.deleteClerkUser, {
            phone: phoneToFree,
          });
          clerkUserDeleted = true;
        }
        
        // Log to audit
        await ctx.runMutation(internal.auditLog.logAction, {
          organizationId: partnership.brokerOrgId,
          entityType: 'carrierPartnership',
          entityId: partnershipId,
          entityName: partnership.carrierName,
          action: 'permanently_deleted',
          performedBy: args.userId,
          performedByName: args.userName,
          description: `Permanently deleted carrier ${partnership.carrierName} (MC# ${partnership.mcNumber}). Deleted: org=${deletedOrg}, drivers=${deletedDrivers}, assignments=${deletedAssignments}, clerkUser=${clerkUserDeleted}`,
        });

        results.push({ 
          id: partnershipId, 
          success: true, 
          deletedOrg, 
          deletedDrivers, 
          deletedAssignments,
          clerkUserDeleted,
        });
      } catch (error) {
        results.push({ id: partnershipId, success: false, error: String(error) });
      }
    }

    return {
      results,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      totalDeletedDrivers: results.reduce((sum, r) => sum + (r.deletedDrivers || 0), 0),
      totalDeletedAssignments: results.reduce((sum, r) => sum + (r.deletedAssignments || 0), 0),
    };
  },
});

/**
 * Send invite to carrier
 * Updates status to INVITED and returns invite link
 */
export const sendInvite = mutation({
  args: {
    partnershipId: v.id('carrierPartnerships'),
  },
  handler: async (ctx, args) => {
    const partnership = await ctx.db.get(args.partnershipId);
    if (!partnership) {
      throw new Error('Partnership not found');
    }

    if (partnership.carrierOrgId) {
      throw new Error('Carrier already has an account');
    }

    await ctx.db.patch(args.partnershipId, {
      status: 'INVITED',
      updatedAt: Date.now(),
    });

    // Generate invite link (in real implementation, this would be a signed URL)
    const inviteLink = `https://app.otoqa.com/carrier/signup?mc=${encodeURIComponent(partnership.mcNumber)}`;

    return {
      success: true,
      inviteLink,
    };
  },
});

/**
 * Sync an existing partnership to enable mobile app access
 * Creates carrier org, userIdentityLinks, and Clerk user if not already set up
 */
export const syncPartnershipForMobileAccess = mutation({
  args: {
    partnershipId: v.id('carrierPartnerships'),
  },
  handler: async (ctx, args) => {
    const partnership = await ctx.db.get(args.partnershipId);
    if (!partnership) {
      throw new Error('Partnership not found');
    }

    if (!partnership.contactPhone) {
      throw new Error('Partnership has no contact phone - cannot enable mobile access');
    }

    const now = Date.now();

    // Check if carrier org already exists
    let carrierOrg = await ctx.db
      .query('organizations')
      .withIndex('by_mc', (q) => q.eq('mcNumber', partnership.mcNumber))
      .first();

    let newCarrierOrgId: Id<'organizations'> | undefined = undefined;

    if (!carrierOrg) {
      // Create carrier organization
      newCarrierOrgId = await ctx.db.insert('organizations', {
        orgType: 'CARRIER',
        name: partnership.carrierName,
        mcNumber: partnership.mcNumber,
        usdotNumber: partnership.usdotNumber,
        billingEmail: partnership.contactEmail || `${partnership.mcNumber}@placeholder.carrier`,
        billingPhone: partnership.contactPhone,
        billingAddress: {
          addressLine1: partnership.addressLine || '',
          addressLine2: partnership.addressLine2,
          city: partnership.city || '',
          state: partnership.state || '',
          zip: partnership.zip || '',
          country: partnership.country || 'USA',
        },
        insuranceProvider: partnership.insuranceProvider,
        insuranceExpiration: partnership.insuranceExpiration,
        subscriptionPlan: 'Free',
        subscriptionStatus: 'Active',
        billingCycle: 'N/A',
        createdAt: now,
        updatedAt: now,
      });

      carrierOrg = await ctx.db.get(newCarrierOrgId);
    }

    // Check if userIdentityLinks exists for this phone
    const normalizedPhone = partnership.contactPhone.replace(/\D/g, '');
    const existingLinks = await ctx.db
      .query('userIdentityLinks')
      .collect();
    
    const existingLink = existingLinks.find((link) => {
      if (!link.phone) return false;
      return link.phone.replace(/\D/g, '') === normalizedPhone;
    });

    if (!existingLink && carrierOrg) {
      // Create userIdentityLinks
      await ctx.db.insert('userIdentityLinks', {
        clerkUserId: `pending_${normalizedPhone}`,
        organizationId: carrierOrg._id,
        role: 'OWNER',
        phone: partnership.contactPhone,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Update partnership with carrier org ID if newly created
    if (newCarrierOrgId && !partnership.carrierOrgId) {
      await ctx.db.patch(args.partnershipId, {
        carrierOrgId: newCarrierOrgId,
        linkedAt: now,
        updatedAt: now,
      });
    }

    // Schedule Clerk user creation (uses syncSingleCarrierOwnerToClerk which updates the userIdentityLinks record)
    if (carrierOrg) {
      await ctx.scheduler.runAfter(0, internal.clerkSync.syncSingleCarrierOwnerToClerk, {
        organizationId: carrierOrg._id,
        phone: partnership.contactPhone,
        firstName: partnership.contactFirstName || partnership.carrierName.split(' ')[0] || 'Owner',
        lastName: partnership.contactLastName || partnership.carrierName.split(' ').slice(1).join(' ') || '',
      });
    }

    return {
      success: true,
      carrierOrgCreated: !!newCarrierOrgId,
      carrierOrgId: carrierOrg?._id,
    };
  },
});
