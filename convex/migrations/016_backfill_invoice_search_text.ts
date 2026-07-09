import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { computeInvoiceSearchText } from '../invoiceSearchText';

/**
 * One-off: populate `loadInvoices.searchText` for existing invoices so the
 * dashboard full-text search (search_text index) can find them.
 *
 * Background: the invoice search filtered a single paginated page in JS, so
 * only invoices in the first ~100 rows of a status tab were ever findable.
 * The fix denormalizes invoiceNumber + load order # + customer name into
 * `searchText` and searches it via a Convex search index. New/updated invoices
 * maintain it on write (see refreshInvoiceSearchText); this backfills the
 * ~22k pre-existing rows.
 *
 * Paginated over by_organization — its keys (workosOrgId, _creationTime) are
 * immutable, and searchText is not an index key, so patching mid-run cannot
 * shift the cursor or skip rows. Drive by feeding nextCursor back until isDone.
 *
 *   # dry run (no writes), then chain {cursor} until isDone with dryRun:false:
 *   npx convex run migrations/016_backfill_invoice_search_text:run \
 *     '{"workosOrgId":"org_...","dryRun":true}'
 */
export const run = internalMutation({
  args: {
    workosOrgId: v.string(),
    dryRun: v.boolean(),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? (args.dryRun ? 800 : 200);

    const page = await ctx.db
      .query('loadInvoices')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let patched = 0;
    let unchanged = 0;
    let empty = 0; // no invoice#, order#, or customer name to index

    for (const invoice of page.page) {
      const load = await ctx.db.get(invoice.loadId);
      const customer = await ctx.db.get(invoice.customerId);
      const searchText = computeInvoiceSearchText({
        invoiceNumber: invoice.invoiceNumber,
        orderNumber: load?.orderNumber,
        customerName: customer?.name,
      });

      if (searchText === '') empty++;
      if (searchText === (invoice.searchText ?? '')) {
        unchanged++;
        continue;
      }
      if (!args.dryRun) {
        await ctx.db.patch(invoice._id, { searchText });
      }
      patched++;
    }

    return {
      scanned: page.page.length,
      patched,
      unchanged,
      empty,
      nextCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});
