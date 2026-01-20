import { v } from 'convex/values';
import { internalQuery } from './_generated/server';

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

