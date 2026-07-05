import { MutationCtx } from './_generated/server';
import { Id } from './_generated/dataModel';

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
