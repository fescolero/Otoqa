import { query } from '../_generated/server';
import { requirePlatformStaff } from '../lib/auth';
import { jobState } from './jobHealth';

/**
 * Counts for the console sidebar.
 *
 * The console previously answered "where do I need to go" only by visiting
 * every page in turn, which during an incident is exactly the wrong order —
 * you find the failing surface last. These are the few numbers that decide
 * whether a page is worth opening, rendered as a count and a status dot beside
 * each nav item.
 *
 * Deliberately bounded and deliberately shallow: this query runs on EVERY page
 * of the console, so it reads counts and nothing else. Anything that needs a
 * scan of the full ledger belongs on the page that owns it.
 */

const NAV_SCAN = 200;

export const navCounts = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    const now = Date.now();

    const [openAlerts, openTickets, inProgressTickets, jobs] = await Promise.all([
      ctx.db
        .query('platformAlerts')
        .withIndex('by_status_time', (q) => q.eq('status', 'open'))
        .take(NAV_SCAN),
      ctx.db
        .query('supportTickets')
        .withIndex('by_status_time', (q) => q.eq('status', 'open'))
        .take(NAV_SCAN),
      ctx.db
        .query('supportTickets')
        .withIndex('by_status_time', (q) => q.eq('status', 'in_progress'))
        .take(NAV_SCAN),
      ctx.db.query('cronHealth').collect(),
    ]);

    // Dead-lettered deliveries: the one Health-page condition that needs a
    // human rather than just watching.
    const dead = await ctx.db
      .query('webhookDeliveryQueue')
      .withIndex('by_status_next', (q) => q.eq('status', 'DEAD_LETTER'))
      .take(NAV_SCAN);

    // Overdue invoices, not open ones: an invoice inside its terms is not a
    // reason to open the billing board.
    const openInvoices = (
      await Promise.all(
        (['issued', 'sent', 'partially_paid'] as const).map((status) =>
          ctx.db
            .query('platformInvoices')
            .withIndex('by_status', (q) => q.eq('status', status))
            .take(NAV_SCAN),
        ),
      )
    ).flat();
    const overdue = openInvoices.filter(
      (i) => i.dueAt != null && i.dueAt < now && i.total - i.amountPaid > 0.005,
    ).length;
    const drafts = await ctx.db
      .query('platformInvoices')
      .withIndex('by_status', (q) => q.eq('status', 'draft'))
      .take(NAV_SCAN);

    const states = jobs.map((j) => jobState(j, now));
    const jobsBad = states.filter((s) => s === 'failing' || s === 'stale' || s === 'hung').length;

    return {
      alerts: openAlerts.length,
      alertsHigh: openAlerts.filter((a) => a.severity === 'high').length,
      tickets: openTickets.length + inProgressTickets.length,
      jobsBad,
      deadLetters: dead.length,
      billingOverdue: overdue,
      billingDrafts: drafts.length,
    };
  },
});
