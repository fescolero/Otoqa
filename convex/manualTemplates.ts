import { v } from 'convex/values';
import { query } from './_generated/server';

/**
 * Manual Adjustment Templates
 * 
 * Provides the "Quick-Add" menu for accountants to add common
 * manual adjustments without typing.
 * 
 * Templates are stored as rate rules with category: 'MANUAL_TEMPLATE'
 */

/**
 * Get all manual adjustment templates for an organization
 * Used to populate the "Add Adjustment" dropdown menu
 */
export const listTemplates = query({
  args: {
    workosOrgId: v.string(),
    profileType: v.optional(v.union(v.literal('DRIVER'), v.literal('CARRIER'))),
  },
  returns: v.array(
    v.object({
      _id: v.id('rateRules'),
      profileId: v.id('rateProfiles'),
      profileName: v.string(),
      name: v.string(),
      triggerEvent: v.union(
        v.literal('MILE_LOADED'),
        v.literal('MILE_EMPTY'),
        v.literal('TIME_DURATION'),
        v.literal('TIME_WAITING'),
        v.literal('COUNT_STOPS'),
        v.literal('FLAT_LOAD'),
        v.literal('FLAT_LEG'),
        v.literal('ATTR_HAZMAT'),
        v.literal('ATTR_TARP'),
        v.literal('PCT_OF_LOAD')
      ),
      rateAmount: v.float64(),
      description: v.string(), // Generated description for UI
    })
  ),
  handler: async (ctx, args) => {
    // Get all active profiles for this org
    let profilesQuery = ctx.db
      .query('rateProfiles')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .filter((q) => q.eq(q.field('isActive'), true));

    const profiles = await profilesQuery.collect();

    // Filter by profile type if specified
    const filteredProfiles = args.profileType
      ? profiles.filter((p) => p.profileType === args.profileType)
      : profiles;

    // Get all MANUAL_TEMPLATE rules for these profiles
    const templates: Array<any> = [];

    for (const profile of filteredProfiles) {
      const rules = await ctx.db
        .query('rateRules')
        .withIndex('by_profile', (q) => q.eq('profileId', profile._id))
        .filter((q) =>
          q.and(
            q.eq(q.field('category'), 'MANUAL_TEMPLATE'),
            q.eq(q.field('isActive'), true)
          )
        )
        .collect();

      for (const rule of rules) {
        // Generate user-friendly description
        let description = rule.name;
        if (rule.triggerEvent === 'FLAT_LOAD' || rule.triggerEvent === 'FLAT_LEG') {
          description = `${rule.name} - $${rule.rateAmount.toFixed(2)}`;
        } else if (rule.triggerEvent === 'TIME_DURATION' || rule.triggerEvent === 'TIME_WAITING') {
          description = `${rule.name} - $${rule.rateAmount.toFixed(2)}/hour`;
        } else if (rule.triggerEvent === 'MILE_LOADED' || rule.triggerEvent === 'MILE_EMPTY') {
          description = `${rule.name} - $${rule.rateAmount.toFixed(2)}/mile`;
        } else if (rule.triggerEvent === 'PCT_OF_LOAD') {
          description = `${rule.name} - ${rule.rateAmount}%`;
        }

        templates.push({
          _id: rule._id,
          profileId: profile._id,
          profileName: profile.name,
          name: rule.name,
          triggerEvent: rule.triggerEvent,
          rateAmount: rule.rateAmount,
          description,
        });
      }
    }

    // Sort by name
    return templates.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * Get common adjustment types (predefined list)
 * Used when no templates are configured
 */
export const getCommonAdjustmentTypes = query({
  args: {},
  returns: v.array(
    v.object({
      type: v.string(),
      label: v.string(),
      defaultAmount: v.optional(v.float64()),
      isRebillable: v.boolean(),
      requiresReceipt: v.boolean(),
    })
  ),
  handler: async () => {
    return [
      {
        type: 'LAYOVER',
        label: 'Layover',
        defaultAmount: 150,
        isRebillable: false,
        requiresReceipt: false,
      },
      {
        type: 'LUMPER',
        label: 'Lumper Fee',
        isRebillable: true,
        requiresReceipt: true,
      },
      {
        type: 'TARP',
        label: 'Tarp Fee',
        defaultAmount: 75,
        isRebillable: true,
        requiresReceipt: false,
      },
      {
        type: 'DETENTION',
        label: 'Detention',
        defaultAmount: 50,
        isRebillable: true,
        requiresReceipt: false,
      },
      {
        type: 'BONUS',
        label: 'Bonus',
        isRebillable: false,
        requiresReceipt: false,
      },
      {
        type: 'SAFETY_BONUS',
        label: 'Safety Bonus',
        defaultAmount: 500,
        isRebillable: false,
        requiresReceipt: false,
      },
      {
        type: 'FUEL_ADVANCE',
        label: 'Fuel Advance',
        isRebillable: false,
        requiresReceipt: true,
      },
      {
        type: 'SCALE_TICKET',
        label: 'Scale Ticket',
        isRebillable: true,
        requiresReceipt: true,
      },
      {
        type: 'TOLL',
        label: 'Toll Reimbursement',
        isRebillable: true,
        requiresReceipt: true,
      },
      {
        type: 'OTHER',
        label: 'Other Adjustment',
        isRebillable: false,
        requiresReceipt: false,
      },
    ];
  },
});

/**
 * Validate if a manual adjustment needs a receipt
 */
export const requiresReceipt = query({
  args: {
    adjustmentType: v.string(),
    amount: v.float64(),
  },
  returns: v.object({
    required: v.boolean(),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    // Types that always require receipts
    const requiresReceiptTypes = ['LUMPER', 'FUEL_ADVANCE', 'SCALE_TICKET', 'TOLL'];

    if (requiresReceiptTypes.includes(args.adjustmentType)) {
      return {
        required: true,
        reason: 'This adjustment type requires a receipt for audit compliance',
      };
    }

    // Large amounts require receipts
    if (args.amount > 500) {
      return {
        required: true,
        reason: 'Adjustments over $500 require supporting documentation',
      };
    }

    return {
      required: false,
    };
  },
});

