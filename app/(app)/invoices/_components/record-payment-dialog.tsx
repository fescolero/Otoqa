'use client';

import { useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { formatCurrency } from '@/lib/utils/format';
import { toast } from 'sonner';

interface RecordPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: Id<'loadInvoices'>;
  workosOrgId: string;
  userId: string;
  invoiceNumber?: string | null;
  totalAmount: number;
  paidAmount: number;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * Manual single-invoice payment entry. Records amount + date + reference + miles,
 * supports partial payments (invoice stays open) and accepting a short-pay as
 * final. Routes through `api.invoices.recordSinglePayment` (the one primitive).
 */
export function RecordPaymentDialog({
  open,
  onOpenChange,
  invoiceId,
  workosOrgId,
  userId,
  invoiceNumber,
  totalAmount,
  paidAmount,
}: RecordPaymentDialogProps) {
  const balance = Math.max(0, Math.round((totalAmount - paidAmount) * 100) / 100);
  const [amount, setAmount] = useState(String(balance || totalAmount || ''));
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [miles, setMiles] = useState('');
  const [closeShort, setCloseShort] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const record = useMutation(api.invoices.recordSinglePayment);

  const amt = parseFloat(amount);
  const validAmt = !isNaN(amt) && amt > 0;
  const newPaid = paidAmount + (validAmt ? amt : 0);
  const isShort = validAmt && newPaid < totalAmount - 0.005;
  const isOver = validAmt && newPaid > totalAmount + 0.005;
  const resultingStatus = newPaid >= totalAmount - 0.005 || closeShort ? 'Paid' : 'Partial (open)';

  const submit = async () => {
    if (!validAmt || submitting) return;
    setSubmitting(true);
    try {
      await record({
        workosOrgId,
        invoiceId,
        userId,
        amount: amt,
        miles: miles ? parseFloat(miles) : undefined,
        paymentDate: date || undefined,
        reference: reference || undefined,
        closeShort,
      });
      toast.success('Payment recorded');
      onOpenChange(false);
      setReference('');
      setMiles('');
      setCloseShort(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to record payment');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment{invoiceNumber ? ` · ${invoiceNumber}` : ''}</DialogTitle>
          <DialogDescription>
            Invoiced {formatCurrency(totalAmount)} · already paid {formatCurrency(paidAmount)} · balance{' '}
            {formatCurrency(balance)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Amount">
            <Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Payment date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Miles paid (optional)">
              <Input type="number" value={miles} onChange={(e) => setMiles(e.target.value)} placeholder="—" />
            </Field>
          </div>
          <Field label="Reference — check # / ACH (optional)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="optional" />
          </Field>

          {validAmt && (
            <div className="rounded-md border p-2.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">New paid total</span>
                <span className="font-medium">{formatCurrency(newPaid)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Resulting status</span>
                <span className="font-medium">{resultingStatus}</span>
              </div>
              {isOver && (
                <div className="mt-1 text-xs text-amber-600">Overpayment of {formatCurrency(newPaid - totalAmount)}.</div>
              )}
            </div>
          )}

          {isShort && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={closeShort} onCheckedChange={(v) => setCloseShort(!!v)} className="mt-0.5" />
              <span>
                Accept short-pay and close this invoice (short by {formatCurrency(Math.max(0, totalAmount - newPaid))}).
                Otherwise it stays open with a balance.
              </span>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!validAmt || submitting}>
            {submitting ? 'Recording…' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
