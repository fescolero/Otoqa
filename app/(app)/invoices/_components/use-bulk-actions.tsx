'use client';

import { useMutation, useConvex } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { toast } from 'sonner';
import { trackError } from '@/lib/posthog';
import { bulkDownloadPdfs } from '@/lib/bulk-pdf';
import { runChunkedBulk } from '@/lib/chunked-bulk';

/** Statuses an invoice can be restored to when a bulk action is undone. */
export type UndoableStatus = 'DRAFT' | 'PENDING_PAYMENT' | 'PAID';

/**
 * Bill/pay/void over the selection by chunking it into budget-safe transactions
 * (see lib/chunked-bulk). Streams progress into `progress.toastId` so a
 * 1,000-row action never looks frozen. Each invoice costs ~15 DB ops (enrich +
 * materialize line items + claim number + stats rollups), so a single mutation
 * can only finalize ~100 before hitting Convex's ~1s limit.
 */
async function runChunked(
  ids: string[],
  runChunk: (chunk: any[]) => Promise<{ success: number; skipped?: number; failed: number }>,
  progress: { toastId: string | number; verb: string; noun: string },
) {
  return runChunkedBulk(ids, runChunk, {
    onProgress: (done, total, totals) => {
      if (total <= 40) return; // single chunk — the caller's final toast is enough
      const noun = total === 1 ? progress.noun.replace(/s$/, '') : progress.noun;
      void totals;
      toast.loading(`${progress.verb} ${done}/${total} ${noun}…`, { id: progress.toastId });
    },
  });
}

export function useBulkActions(
  workosOrgId: string,
  userId: string,
  onSuccess?: () => void
) {
  const convex = useConvex();
  const bulkUpdateStatus = useMutation(api.invoices.bulkUpdateStatus);
  const bulkMarkBilled = useMutation(api.invoices.bulkMarkBilled);
  const bulkUnmarkBilled = useMutation(api.invoices.bulkUnmarkBilled);
  const bulkMarkPaid = useMutation(api.invoices.bulkMarkPaid);
  const bulkUnmarkPaid = useMutation(api.invoices.bulkUnmarkPaid);
  const bulkVoidInvoices = useMutation(api.invoices.bulkVoidInvoices);
  const bulkUpdateLoadType = useMutation(api.invoices.bulkUpdateLoadType);

  const handleMarkBilled = async (invoiceIds: Id<'loadInvoices'>[]) => {
    const toastId = toast.loading(
      `Billing ${invoiceIds.length} ${invoiceIds.length === 1 ? 'invoice' : 'invoices'}…`
    );
    try {
      const result = await runChunked(
        invoiceIds,
        (chunk) => bulkMarkBilled({ invoiceIds: chunk, workosOrgId, updatedBy: userId }),
        { toastId, verb: 'Billing', noun: 'invoices' }
      );

      if (result.success > 0) {
        toast.success(
          `${result.success} ${result.success === 1 ? 'invoice' : 'invoices'} billed — now tracked in Sent`,
          {
            id: toastId,
            duration: 5000,
            action: {
              label: 'Undo',
              onClick: () => handleUndoMarkBilled(invoiceIds),
            },
          }
        );
        onSuccess?.();
      } else if (result.failed > 0) {
        toast.error(`Failed to bill ${result.failed} ${result.failed === 1 ? 'invoice' : 'invoices'}`, { id: toastId });
      } else {
        toast.info('Nothing to bill (only drafts can be billed)', { id: toastId });
      }
      if (result.success > 0 && result.skipped > 0) {
        toast.info(`${result.skipped} skipped (only drafts can be billed)`);
      }
      if (result.success > 0 && result.failed > 0) {
        toast.error(`Failed to bill ${result.failed} ${result.failed === 1 ? 'invoice' : 'invoices'}`);
      }
    } catch (error) {
      trackError('invoices_mark_billed', error, { count: invoiceIds.length });
      toast.error('Failed to bill invoices', { id: toastId });
      console.error(error);
    }
  };

  const handleUndoMarkBilled = async (invoiceIds: Id<'loadInvoices'>[]) => {
    const toastId = toast.loading('Undoing…');
    try {
      const result = await runChunked(
        invoiceIds,
        (chunk) => bulkUnmarkBilled({ invoiceIds: chunk, workosOrgId, updatedBy: userId }),
        { toastId, verb: 'Undoing', noun: 'invoices' }
      );
      if (result.failed > 0 && result.success === 0) {
        toast.error('Failed to undo action', { id: toastId });
      } else {
        toast.success('Action undone', { id: toastId });
      }
      onSuccess?.();
    } catch {
      toast.error('Failed to undo action', { id: toastId });
    }
  };

  const handleMarkAsPaid = async (
    invoiceIds: Id<'loadInvoices'>[],
    previousStatus: 'DRAFT' | 'PENDING_PAYMENT'
  ) => {
    const toastId = toast.loading(
      `Marking ${invoiceIds.length} ${invoiceIds.length === 1 ? 'invoice' : 'invoices'} paid…`
    );
    try {
      const result = await runChunked(
        invoiceIds,
        (chunk) => bulkMarkPaid({ invoiceIds: chunk, workosOrgId, updatedBy: userId }),
        { toastId, verb: 'Marking', noun: 'invoices paid' }
      );

      if (result.success > 0) {
        toast.success(
          `${result.success} ${result.success === 1 ? 'invoice' : 'invoices'} marked as paid in full`,
          {
            id: toastId,
            duration: 5000,
            action: {
              label: 'Undo',
              onClick: () => handleUndoMarkAsPaid(invoiceIds, previousStatus),
            },
          }
        );
        onSuccess?.();
        if (result.failed > 0) {
          toast.error(`Failed to update ${result.failed} ${result.failed === 1 ? 'invoice' : 'invoices'}`);
        }
      } else {
        toast.error(`Failed to update ${result.failed} ${result.failed === 1 ? 'invoice' : 'invoices'}`, { id: toastId });
      }
    } catch (error) {
      trackError('invoices_mark_paid', error, { count: invoiceIds.length });
      toast.error('Failed to update invoices', { id: toastId });
      console.error(error);
    }
  };

  const handleUndoMarkAsPaid = async (
    invoiceIds: Id<'loadInvoices'>[],
    restoreStatus: 'DRAFT' | 'PENDING_PAYMENT'
  ) => {
    const toastId = toast.loading('Undoing…');
    try {
      const result = await runChunked(
        invoiceIds,
        (chunk) => bulkUnmarkPaid({ invoiceIds: chunk, workosOrgId, restoreStatus, updatedBy: userId }),
        { toastId, verb: 'Undoing', noun: 'invoices' }
      );
      if (result.failed > 0 && result.success === 0) {
        toast.error('Failed to undo action', { id: toastId });
      } else {
        toast.success('Action undone', { id: toastId });
      }
      onSuccess?.();
    } catch {
      toast.error('Failed to undo action', { id: toastId });
    }
  };

  const handleVoid = async (
    invoiceIds: Id<'loadInvoices'>[],
    previousStatus: UndoableStatus
  ) => {
    const toastId = toast.loading(
      `Voiding ${invoiceIds.length} ${invoiceIds.length === 1 ? 'invoice' : 'invoices'}…`
    );
    try {
      const result = await runChunked(
        invoiceIds,
        (chunk) => bulkVoidInvoices({ invoiceIds: chunk, workosOrgId, reason: 'Voided via bulk action', updatedBy: userId }),
        { toastId, verb: 'Voiding', noun: 'invoices' }
      );

      if (result.success > 0) {
        toast.success(
          `${result.success} ${result.success === 1 ? 'invoice' : 'invoices'} voided`,
          {
            id: toastId,
            duration: 5000,
            action: {
              label: 'Undo',
              onClick: () => handleUndoVoid(invoiceIds, previousStatus),
            },
          }
        );
        onSuccess?.();
        if (result.failed > 0) {
          toast.error(`Failed to void ${result.failed} ${result.failed === 1 ? 'invoice' : 'invoices'}`);
        }
      } else {
        toast.error(`Failed to void ${result.failed} ${result.failed === 1 ? 'invoice' : 'invoices'}`, { id: toastId });
      }
    } catch (error) {
      trackError('invoices_void', error, { count: invoiceIds.length });
      toast.error('Failed to void invoices', { id: toastId });
      console.error(error);
    }
  };

  const handleUndoVoid = async (
    invoiceIds: Id<'loadInvoices'>[],
    restoreStatus: UndoableStatus
  ) => {
    const toastId = toast.loading('Undoing…');
    try {
      const result = await runChunked(
        invoiceIds,
        (chunk) => bulkUpdateStatus({ invoiceIds: chunk, workosOrgId, newStatus: restoreStatus, updatedBy: userId }),
        { toastId, verb: 'Undoing', noun: 'invoices' }
      );
      if (result.failed > 0 && result.success === 0) {
        toast.error('Failed to undo action', { id: toastId });
      } else {
        toast.success('Action undone', { id: toastId });
      }
      onSuccess?.();
    } catch {
      toast.error('Failed to undo action', { id: toastId });
    }
  };

  const handleChangeType = async (
    invoiceIds: Id<'loadInvoices'>[],
    newType: 'CONTRACT' | 'SPOT'
  ) => {
    const toastId = toast.loading(
      `Updating ${invoiceIds.length} ${invoiceIds.length === 1 ? 'invoice' : 'invoices'}…`
    );
    try {
      const result = await runChunked(
        invoiceIds,
        (chunk) => bulkUpdateLoadType({ invoiceIds: chunk, workosOrgId, newLoadType: newType, updatedBy: userId }),
        { toastId, verb: 'Updating', noun: 'invoices' }
      );

      if (result.success > 0) {
        toast.success(
          `${result.success} ${result.success === 1 ? 'invoice' : 'invoices'} changed to ${newType}`,
          { id: toastId, duration: 3000 }
        );
        onSuccess?.();
        if (result.failed > 0) {
          toast.error(`Failed to update ${result.failed} ${result.failed === 1 ? 'invoice' : 'invoices'}`);
        }
      } else {
        toast.error(`Failed to update ${result.failed} ${result.failed === 1 ? 'invoice' : 'invoices'}`, { id: toastId });
      }
    } catch (error) {
      trackError('invoices_change_type', error, { count: invoiceIds.length, newType });
      toast.error('Failed to change invoice type', { id: toastId });
      console.error(error);
    }
  };

  // Bulk PDF download — render each selected invoice to a PDF and deliver them
  // as a single zip (one selection downloads as a bare PDF). Mirrors the
  // single-invoice render in invoice-preview-sheet; data is fetched imperatively
  // per invoice (invoice + line items + customer), org settings once.
  const handleBulkDownload = async (invoiceIds: Id<'loadInvoices'>[]) => {
    if (invoiceIds.length === 0) return;
    const toastId = toast.loading(`Preparing ${invoiceIds.length} ${invoiceIds.length === 1 ? 'invoice' : 'invoices'}…`);
    try {
      const orgSettings = await convex.query(api.settings.getOrgSettings, { workosOrgId });
      const formatPhone = (phone: string): string => {
        const digits = (phone || '').replace(/\D/g, '');
        return digits.length === 10 ? `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}` : phone;
      };
      const companyDetails = orgSettings
        ? {
            name: orgSettings.name || 'Company Name',
            email: orgSettings.billingEmail || 'billing@company.com',
            phone: formatPhone(orgSettings.billingPhone || ''),
            address: orgSettings.billingAddress
              ? `${orgSettings.billingAddress.addressLine1}${orgSettings.billingAddress.addressLine2 ? '\n' + orgSettings.billingAddress.addressLine2 : ''}\n${orgSettings.billingAddress.city}, ${orgSettings.billingAddress.state} ${orgSettings.billingAddress.zip}\n${orgSettings.billingAddress.country}`
              : 'Address not available',
            logoUrl: orgSettings.logoUrl || undefined,
          }
        : { name: 'Company Name', email: 'billing@company.com', phone: '', address: 'Address not available', logoUrl: undefined };

      const result = await bulkDownloadPdfs<Id<'loadInvoices'>>({
        items: invoiceIds,
        zipName: 'invoices',
        concurrency: 3,
        onProgress: (done, total) =>
          toast.loading(`Rendering ${done}/${total} ${total === 1 ? 'invoice' : 'invoices'}…`, { id: toastId }),
        render: async (invoiceId) => {
          const [invoice, lineItems] = await Promise.all([
            convex.query(api.invoices.getInvoice, { invoiceId }),
            convex.query(api.invoices.getLineItems, { invoiceId }),
          ]);
          if (!invoice) throw new Error('invoice not found');
          const customer = invoice.customerId
            ? await convex.query(api.customers.getById, { customerId: invoice.customerId })
            : null;
          if (!customer) throw new Error('customer not found');
          // Lazy-load @react-pdf + the PDF template only when actually rendering.
          const { pdf } = await import('@react-pdf/renderer');
          const { InvoicePDFTemplate } = await import('./preview/invoice-pdf-template');
          const blob = await pdf(
            <InvoicePDFTemplate
              invoice={invoice as any}
              customer={customer as any}
              lineItems={(lineItems ?? []) as any}
              companyDetails={companyDetails}
            />,
          ).toBlob();
          return { blob, name: `invoice-${invoice.invoiceNumber ?? invoiceId}` };
        },
      });

      if (result.failed.length === 0) {
        toast.success(`Downloaded ${result.ok} ${result.ok === 1 ? 'invoice' : 'invoices'}`, { id: toastId });
      } else if (result.ok > 0) {
        toast.warning(`Downloaded ${result.ok}; ${result.failed.length} failed to render`, { id: toastId });
      } else {
        toast.error('Failed to generate PDFs', { id: toastId });
      }
      if (result.ok > 0) onSuccess?.();
    } catch (error) {
      trackError('invoices_bulk_download', error, { count: invoiceIds.length });
      toast.error('Failed to download invoices', { id: toastId });
      console.error(error);
    }
  };

  return {
    handleMarkBilled,
    handleMarkAsPaid,
    handleVoid,
    handleChangeType,
    handleBulkDownload,
  };
}
