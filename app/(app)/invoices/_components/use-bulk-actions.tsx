'use client';

import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { toast } from 'sonner';
import { useState } from 'react';

interface BulkActionState {
  invoiceIds: Id<'loadInvoices'>[];
  previousStatus?: string;
  action: string;
}

export function useBulkActions(
  workosOrgId: string,
  userId: string,
  onSuccess?: () => void
) {
  const bulkUpdateStatus = useMutation(api.invoices.bulkUpdateStatus);
  const bulkVoidInvoices = useMutation(api.invoices.bulkVoidInvoices);
  const bulkUpdateLoadType = useMutation(api.invoices.bulkUpdateLoadType);
  
  const [lastAction, setLastAction] = useState<BulkActionState | null>(null);

  const handleMarkAsPaid = async (invoiceIds: Id<'loadInvoices'>[]) => {
    try {
      const result = await bulkUpdateStatus({
        invoiceIds,
        workosOrgId,
        newStatus: 'PAID',
        updatedBy: userId,
      });

      if (result.success > 0) {
        setLastAction({
          invoiceIds,
          action: 'mark_paid',
        });

        toast.success(
          `${result.success} ${result.success === 1 ? 'invoice' : 'invoices'} marked as Paid`,
          {
            duration: 5000,
            action: {
              label: 'Undo',
              onClick: () => handleUndoMarkAsPaid(invoiceIds),
            },
          }
        );

        onSuccess?.();
      }

      if (result.failed > 0) {
        toast.error(`Failed to update ${result.failed} invoices`);
      }
    } catch (error) {
      toast.error('Failed to update invoices');
      console.error(error);
    }
  };

  const handleUndoMarkAsPaid = async (invoiceIds: Id<'loadInvoices'>[]) => {
    try {
      await bulkUpdateStatus({
        invoiceIds,
        workosOrgId,
        newStatus: 'PENDING_PAYMENT', // Revert to pending
        updatedBy: userId,
      });

      toast.success('Action undone');
      onSuccess?.();
    } catch (error) {
      toast.error('Failed to undo action');
    }
  };

  const handleVoid = async (invoiceIds: Id<'loadInvoices'>[]) => {
    try {
      const result = await bulkVoidInvoices({
        invoiceIds,
        workosOrgId,
        reason: 'Voided via bulk action',
        updatedBy: userId,
      });

      if (result.success > 0) {
        setLastAction({
          invoiceIds,
          action: 'void',
        });

        toast.success(
          `${result.success} ${result.success === 1 ? 'invoice' : 'invoices'} voided`,
          {
            duration: 5000,
            action: {
              label: 'Undo',
              onClick: () => handleUndoVoid(invoiceIds),
            },
          }
        );

        onSuccess?.();
      }

      if (result.failed > 0) {
        toast.error(`Failed to void ${result.failed} invoices`);
      }
    } catch (error) {
      toast.error('Failed to void invoices');
      console.error(error);
    }
  };

  const handleUndoVoid = async (invoiceIds: Id<'loadInvoices'>[]) => {
    try {
      await bulkUpdateStatus({
        invoiceIds,
        workosOrgId,
        newStatus: 'DRAFT', // Revert to draft
        updatedBy: userId,
      });

      toast.success('Action undone');
      onSuccess?.();
    } catch (error) {
      toast.error('Failed to undo action');
    }
  };

  const handleChangeType = async (
    invoiceIds: Id<'loadInvoices'>[],
    newType: 'CONTRACT' | 'SPOT'
  ) => {
    try {
      const result = await bulkUpdateLoadType({
        invoiceIds,
        workosOrgId,
        newLoadType: newType,
        updatedBy: userId,
      });

      if (result.success > 0) {
        toast.success(
          `${result.success} ${result.success === 1 ? 'invoice' : 'invoices'} changed to ${newType}`,
          {
            duration: 3000,
          }
        );

        onSuccess?.();
      }

      if (result.failed > 0) {
        toast.error(`Failed to update ${result.failed} invoices`);
      }
    } catch (error) {
      toast.error('Failed to change invoice type');
      console.error(error);
    }
  };

  const handleBulkDownload = async (invoiceIds: Id<'loadInvoices'>[]) => {
    // TODO: Implement PDF generation and zip download
    toast.info('Bulk download coming soon', {
      description: `Preparing ${invoiceIds.length} PDFs for download...`,
    });
  };

  return {
    handleMarkAsPaid,
    handleVoid,
    handleChangeType,
    handleBulkDownload,
    lastAction,
  };
}
