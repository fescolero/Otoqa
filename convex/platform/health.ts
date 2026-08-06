import { query } from '../_generated/server';
import { requirePlatformStaff } from '../lib/auth';

/**
 * Platform console — integration health board. Staff-only. Surfaces the
 * health rollups that already exist (fourKitesPushTickHealth, the webhook
 * delivery queue) instead of burying them in the Convex dashboard.
 */

const QUEUE_COUNT_CAP = 500;

export const integrationHealth = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);

    // One row per org with FourKites push configured.
    const fourKites = await ctx.db.query('fourKitesPushTickHealth').collect();
    fourKites.sort((a, b) => (a.workosOrgId < b.workosOrgId ? -1 : 1));

    const countByStatus = async (status: 'PENDING' | 'DEAD_LETTER') =>
      (
        await ctx.db
          .query('webhookDeliveryQueue')
          .withIndex('by_status_next', (q) => q.eq('status', status))
          .take(QUEUE_COUNT_CAP)
      ).length;

    const webhookQueue = {
      pending: await countByStatus('PENDING'),
      deadLetter: await countByStatus('DEAD_LETTER'),
      countCap: QUEUE_COUNT_CAP, // UI shows "500+" at the cap
    };

    return { fourKites, webhookQueue };
  },
});
