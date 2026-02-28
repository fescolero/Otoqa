import { v } from 'convex/values';
import { internalQuery, internalMutation } from './_generated/server';

/**
 * Helper queries for Clerk sync actions
 * These are in a separate file because Node.js files can only contain actions
 */

/**
 * Get drivers for syncing to Clerk
 */
export const getDriversForSync = internalQuery({
  args: {
    organizationId: v.string(),
  },
  returns: v.array(
    v.object({
      phone: v.string(),
      firstName: v.string(),
      lastName: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.organizationId))
      .collect();

    return drivers
      .filter((d) => !d.isDeleted && d.phone)
      .map((d) => ({
        phone: d.phone,
        firstName: d.firstName,
        lastName: d.lastName,
      }));
  },
});

/**
 * Get a single driver by ID for syncing
 */
export const getDriverById = internalQuery({
  args: {
    driverId: v.id('drivers'),
  },
  returns: v.union(
    v.object({
      phone: v.string(),
      firstName: v.string(),
      lastName: v.string(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.isDeleted || !driver.phone) return null;

    return {
      phone: driver.phone,
      firstName: driver.firstName,
      lastName: driver.lastName,
    };
  },
});

// ==========================================
// CARRIER OWNER HELPERS
// ==========================================

/**
 * Get all carrier owners for syncing to Clerk
 * Returns identity links for CARRIER orgs with OWNER/ADMIN role
 */
export const getCarrierOwnersForSync = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      phone: v.optional(v.string()),
      role: v.string(),
      organizationId: v.string(),
      organizationName: v.string(),
    })
  ),
  handler: async (ctx) => {
    // Get all carrier organizations
    const carrierOrgs = await ctx.db
      .query('organizations')
      .collect();

    const carriers = carrierOrgs.filter(
      (org) => org.orgType === 'CARRIER' || org.orgType === 'BROKER_CARRIER'
    );

    const results: Array<{
      phone: string | undefined;
      role: string;
      organizationId: string;
      organizationName: string;
    }> = [];

    // Get identity links for each carrier org
    for (const carrier of carriers) {
      const identityLinks = await ctx.db
        .query('userIdentityLinks')
        .withIndex('by_org', (q) => q.eq('organizationId', carrier._id))
        .collect();

      // Only get OWNER and ADMIN roles
      const owners = identityLinks.filter(
        (link) => link.role === 'OWNER' || link.role === 'ADMIN'
      );

      for (const owner of owners) {
        results.push({
          phone: owner.phone,
          role: owner.role,
          organizationId: carrier._id,
          organizationName: carrier.name,
        });
      }
    }

    return results;
  },
});

/**
 * Get organization by ID
 */
export const getOrganizationById = internalQuery({
  args: {
    organizationId: v.id('organizations'),
  },
  returns: v.union(
    v.object({
      _id: v.id('organizations'),
      name: v.string(),
      orgType: v.optional(v.string()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org) return null;

    return {
      _id: org._id,
      name: org.name,
      orgType: org.orgType,
    };
  },
});

/**
 * Update userIdentityLinks record with actual Clerk user ID
 * Used after creating a Clerk user to replace the pending_ placeholder
 */
export const updateIdentityLinkClerkUserId = internalMutation({
  args: {
    organizationId: v.id('organizations'),
    phone: v.string(),
    clerkUserId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // Find the userIdentityLinks record by org and phone
    const normalizedPhone = args.phone.replace(/\D/g, '');
    
    const links = await ctx.db
      .query('userIdentityLinks')
      .withIndex('by_org', (q) => q.eq('organizationId', args.organizationId))
      .collect();
    
    // Find matching link by phone
    const link = links.find((l) => {
      const linkPhone = l.phone?.replace(/\D/g, '');
      return linkPhone && (linkPhone === normalizedPhone || linkPhone.endsWith(normalizedPhone) || normalizedPhone.endsWith(linkPhone));
    });
    
    if (!link) {
      console.log(`No userIdentityLinks record found for org ${args.organizationId} with phone ${args.phone}`);
      return false;
    }
    
    // Update with actual Clerk user ID
    await ctx.db.patch(link._id, {
      clerkUserId: args.clerkUserId,
      updatedAt: Date.now(),
    });
    
    console.log(`Updated userIdentityLinks ${link._id} with clerkUserId ${args.clerkUserId}`);
    return true;
  },
});

/**
 * Update OWNER/ADMIN identity link clerkUserId for an organization.
 * This is used to repair stale links when phone-based ownership differs.
 */
export const updateIdentityLinkClerkUserIdForOrgOwner = internalMutation({
  args: {
    organizationId: v.id('organizations'),
    clerkUserId: v.string(),
    currentClerkUserId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query('userIdentityLinks')
      .withIndex('by_org', (q) => q.eq('organizationId', args.organizationId))
      .collect();

    const ownerLinks = links.filter((l) => l.role === 'OWNER' || l.role === 'ADMIN');
    if (ownerLinks.length === 0) {
      console.log(`No OWNER/ADMIN identity links found for org ${args.organizationId}`);
      return false;
    }

    const linkToUpdate =
      (args.currentClerkUserId
        ? ownerLinks.find((l) => l.clerkUserId === args.currentClerkUserId)
        : undefined) ?? ownerLinks[0];

    await ctx.db.patch(linkToUpdate._id, {
      clerkUserId: args.clerkUserId,
      updatedAt: Date.now(),
    });
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/57f2ad76-4843-4014-b036-7c154391397b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'bb9bfb'},body:JSON.stringify({sessionId:'bb9bfb',runId:'rerun-1',hypothesisId:'H2',location:'convex/clerkSyncHelpers.ts:updateIdentityLinkClerkUserIdForOrgOwner:patched',message:'owner link patched',data:{organizationId:args.organizationId,ownerLinksCount:ownerLinks.length,patchedLinkId:linkToUpdate._id,matchedCurrentClerkUserId:Boolean(args.currentClerkUserId && linkToUpdate.clerkUserId===args.currentClerkUserId)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    console.log(
      `Updated owner identity link ${linkToUpdate._id} clerkUserId to ${args.clerkUserId}`
    );
    return true;
  },
});

/**
 * Count how many identity links still reference a Clerk user ID.
 * Used to determine if an old Clerk user is now orphaned and safe to delete.
 */
export const countIdentityLinksByClerkUserId = internalQuery({
  args: {
    clerkUserId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query('userIdentityLinks')
      .withIndex('by_clerk', (q) => q.eq('clerkUserId', args.clerkUserId))
      .collect();
    return links.length;
  },
});

