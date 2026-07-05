import { MutationCtx, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { Id } from './_generated/dataModel';
import { v } from 'convex/values';

/**
 * Build the denormalized search haystack for an invoice: its invoice number,
 * the load's order number, and the customer name — lowercased and space-joined.
 * Falsy parts are dropped. Convex's search tokenizer lowercases anyway; we
 * normalize here too so the value is predictable in the DB.
 */
export function computeInvoiceSearchText(parts: {
  invoiceNumber?: string | null;
  orderNumber?: string | null;
  customerName?: string | null;
}): string {
  return [parts.invoiceNumber, parts.orderNumber, parts.customerName]
    .filter((s): s is string => !!s && s.trim() !== '')
    .join(' ')
    .toLowerCase();
}

/**
 * Recompute and persist `searchText` for one invoice by joining its load
 * (order #) and customer (name). Call after creating an invoice and after
 * assigning/refreshing its invoice number. Idempotent; a no-op patch when the
 * value is unchanged. Safe if the invoice was deleted between calls.
 */
export async function refreshInvoiceSearchText(
  ctx: MutationCtx,
  invoiceId: Id<'loadInvoices'>,
): Promise<void> {
  const invoice = await ctx.db.get(invoiceId);
  if (!invoice) return;

  const load = await ctx.db.get(invoice.loadId);
  const customer = await ctx.db.get(invoice.customerId);

  const searchText = computeInvoiceSearchText({
    invoiceNumber: invoice.invoiceNumber,
    orderNumber: load?.orderNumber,
    customerName: customer?.name,
  });

  if (searchText !== (invoice.searchText ?? '')) {
    await ctx.db.patch(invoiceId, { searchText });
  }
}

/**
 * Re-index every invoice of one customer after a rename — searchText embeds the
 * customer name, so it goes stale otherwise. A customer can own thousands of
 * invoices, so this paginates and self-schedules the next batch rather than
 * blocking the mutation. Scheduled from customers.update on a name change.
 */
export const reindexCustomerInvoices = internalMutation({
  args: {
    customerId: v.id('customers'),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { customerId, cursor }) => {
    const page = await ctx.db
      .query('loadInvoices')
      .withIndex('by_customer', (q) => q.eq('customerId', customerId))
      .paginate({ cursor: cursor ?? null, numItems: 200 });

    for (const invoice of page.page) {
      await refreshInvoiceSearchText(ctx, invoice._id);
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.invoiceSearchText.reindexCustomerInvoices, {
        customerId,
        cursor: page.continueCursor,
      });
    }
  },
});
