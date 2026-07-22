import { internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';

/**
 * Hourly driver-settlement generation.
 *
 * Pay plans define the org-sanctioned cadence (frequency, cutoff, payment
 * lag), so statements generate themselves instead of waiting for someone to
 * click "New pay run": each tick fans out per-plan, then per-driver, into
 * driverSettlements.generateOrRefreshForDriver — which creates the current
 * period's DRAFT once work lands in it and additively tops up existing
 * DRAFTs as more payables arrive (the "Open — accruing" behavior on the
 * settlements screen). It never unassigns lines and never touches statements
 * past DRAFT.
 *
 * Carriers stay manual ("New pay run" on the carrier screen): partnerships
 * carry payment terms but no period-defining pay plan, so there is no
 * org-sanctioned schedule to generate from yet.
 */
export const tick = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const plans = await ctx.db.query('payPlans').collect();
    const active = plans.filter((p) => p.isActive);
    for (let i = 0; i < active.length; i++) {
      await ctx.scheduler.runAfter(i * 500, internal.settlementsCron.processPlan, {
        planId: active[i]._id,
      });
    }
    return null;
  },
});

export const processPlan = internalMutation({
  args: { planId: v.id('payPlans') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (!plan || !plan.isActive) return null;

    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', plan.workosOrgId))
      .filter((q) =>
        q.and(q.eq(q.field('payPlanId'), args.planId), q.neq(q.field('isDeleted'), true)),
      )
      .collect();

    for (let i = 0; i < drivers.length; i++) {
      // Stagger so the statement-number counter doc isn't hammered by N
      // simultaneous transactions.
      await ctx.scheduler.runAfter(i * 150, internal.driverSettlements.generateOrRefreshForDriver, {
        driverId: drivers[i]._id,
        planId: args.planId,
        workosOrgId: plan.workosOrgId,
        userId: 'system:settlements-cron',
        additive: true,
      });
    }
    return null;
  },
});
