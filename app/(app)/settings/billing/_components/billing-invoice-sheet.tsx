'use client';

/**
 * Billing-cycle invoice preview sheet — the platform-billing sibling of
 * invoices/_components/invoice-preview-sheet.tsx. Same interaction model:
 * slide-over preview with prev/next navigation across cycles, Print (opens
 * the PDF in a new tab) and Download. The PDF module + @react-pdf/renderer
 * are lazy-imported on demand so the billing page bundle stays lean.
 */

import { useCallback } from 'react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, Download, Printer, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  OTOQA_BILLER,
  type BillingInvoiceBillTo,
  type BillingInvoiceCycle,
} from './billing-invoice-types';

const money = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface BillingInvoiceSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** Closed cycles, newest first (matches the history table order). */
  cycles: BillingInvoiceCycle[];
  /** periodKey of the cycle being previewed. */
  activeKey: string | null;
  onNavigate: (periodKey: string) => void;
  billTo: BillingInvoiceBillTo;
}

export function BillingInvoiceSheet({
  isOpen,
  onClose,
  cycles,
  activeKey,
  onNavigate,
  billTo,
}: BillingInvoiceSheetProps) {
  const currentIndex = activeKey ? cycles.findIndex((c) => c.periodKey === activeKey) : -1;
  const cycle = currentIndex >= 0 ? cycles[currentIndex] : null;
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < cycles.length - 1;

  const handlePrevious = () => {
    if (hasPrevious) onNavigate(cycles[currentIndex - 1].periodKey);
  };
  const handleNext = () => {
    if (hasNext) onNavigate(cycles[currentIndex + 1].periodKey);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' && hasPrevious) {
      e.preventDefault();
      handlePrevious();
    } else if (e.key === 'ArrowRight' && hasNext) {
      e.preventDefault();
      handleNext();
    }
  };

  const generateBlob = useCallback(async () => {
    if (!cycle) throw new Error('No cycle selected');
    const { pdf } = await import('@react-pdf/renderer');
    const { BillingInvoicePDFTemplate } = await import('./billing-invoice-pdf-template');
    return pdf(<BillingInvoicePDFTemplate cycle={cycle} billTo={billTo} />).toBlob();
  }, [billTo, cycle]);

  const handlePrint = useCallback(async () => {
    if (!cycle) return;
    try {
      toast.loading('Generating PDF for printing...');
      const blob = await generateBlob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      toast.dismiss();
      toast.success('PDF opened in new tab');
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.dismiss();
      toast.error('Failed to generate PDF');
      console.error('PDF generation error:', error);
    }
  }, [cycle, generateBlob]);

  const handleDownloadPDF = useCallback(async () => {
    if (!cycle) return;
    try {
      toast.loading('Generating PDF...');
      const blob = await generateBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${cycle.invoiceNo}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.dismiss();
      toast.success('PDF downloaded successfully');
    } catch (error) {
      toast.dismiss();
      toast.error('Failed to generate PDF');
      console.error('PDF generation error:', error);
    }
  }, [cycle, generateBlob]);

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="w-full sm:max-w-3xl p-0 print:max-w-full print:border-0 print:shadow-none"
        onKeyDown={handleKeyDown}
      >
        <div className="h-full flex flex-col">
          {/* Toolbar */}
          <div className="h-14 border-b bg-background flex items-center justify-between px-6 shrink-0 print:hidden">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <SheetTitle className="text-sm font-medium truncate">
                Invoice preview{cycle ? ` · ${cycle.label}` : ''}
              </SheetTitle>

              {cycles.length > 1 && (
                <div className="flex items-center gap-1 ml-4 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handlePrevious}
                    disabled={!hasPrevious}
                    className="h-8 w-8 p-0"
                    title="Previous invoice (←)"
                  >
                    <ChevronLeft className="h-4 w-4" strokeWidth={2} />
                  </Button>
                  <span className="text-xs text-muted-foreground px-2">
                    {currentIndex + 1} / {cycles.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleNext}
                    disabled={!hasNext}
                    className="h-8 w-8 p-0"
                    title="Next invoice (→)"
                  >
                    <ChevronRight className="h-4 w-4" strokeWidth={2} />
                  </Button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={handlePrint} disabled={!cycle}>
                <Printer className="w-4 h-4 mr-2" />
                Print
              </Button>
              <Button size="sm" onClick={handleDownloadPDF} disabled={!cycle}>
                <Download className="w-4 h-4 mr-2" />
                PDF
              </Button>
              <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8 ml-2">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Preview — white paper document, mirroring the PDF layout */}
          <div className="flex-1 overflow-auto bg-muted/40 p-6">
            {cycle && (
              <div
                className="mx-auto bg-white text-slate-900 shadow-sm border border-slate-200 rounded-sm"
                style={{ maxWidth: 680, padding: 40, fontSize: 13 }}
              >
                {/* Header */}
                <div className="flex items-start justify-between mb-6">
                  <div>
                    <div
                      className="flex items-center justify-center text-white font-bold"
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 8,
                        background: '#2E5CFF',
                        fontSize: 18,
                      }}
                    >
                      O
                    </div>
                    <div className="font-bold mt-2" style={{ fontSize: 14 }}>
                      {OTOQA_BILLER.name}
                    </div>
                    <div className="text-slate-500" style={{ fontSize: 11.5 }}>
                      {OTOQA_BILLER.tagline}
                    </div>
                    <div className="text-slate-500" style={{ fontSize: 11.5 }}>
                      {OTOQA_BILLER.email}
                    </div>
                  </div>
                  <div className="text-right">
                    <div style={{ fontSize: 26, letterSpacing: 0.5 }}>INVOICE</div>
                    <span
                      className="inline-block rounded px-2 py-0.5 font-semibold"
                      style={{
                        fontSize: 11,
                        background: cycle.status === 'paid' ? '#dcfce7' : '#fef3c7',
                        color: cycle.status === 'paid' ? '#166534' : '#92400e',
                      }}
                    >
                      {cycle.status === 'paid' ? 'PAID' : 'DUE'}
                    </span>
                  </div>
                </div>

                {/* Meta */}
                <div className="flex gap-10 mb-6" style={{ fontSize: 11.5 }}>
                  {[
                    ['Invoice No', cycle.invoiceNo],
                    ['Billing cycle', cycle.label],
                    ['Issued', cycle.issuedOn],
                    [
                      cycle.status === 'paid' ? 'Paid' : 'Due date',
                      cycle.status === 'paid' ? (cycle.paidOn ?? '-') : cycle.dueOn,
                    ],
                  ].map(([k, vLabel]) => (
                    <div key={k}>
                      <div className="text-slate-500 mb-0.5">{k}</div>
                      <div className="font-semibold font-mono">{vLabel}</div>
                    </div>
                  ))}
                </div>

                {/* Addresses */}
                <div className="flex gap-10 mb-6">
                  <div className="flex-1">
                    <div
                      className="text-slate-500 uppercase mb-1.5"
                      style={{ fontSize: 10, letterSpacing: 0.5 }}
                    >
                      From
                    </div>
                    <div className="font-semibold" style={{ fontSize: 12 }}>
                      {OTOQA_BILLER.name}
                    </div>
                    <div className="text-slate-600" style={{ fontSize: 11.5 }}>
                      {OTOQA_BILLER.tagline}
                    </div>
                    <div className="text-slate-600" style={{ fontSize: 11.5 }}>
                      {OTOQA_BILLER.email}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div
                      className="text-slate-500 uppercase mb-1.5"
                      style={{ fontSize: 10, letterSpacing: 0.5 }}
                    >
                      Bill to
                    </div>
                    <div className="font-semibold" style={{ fontSize: 12 }}>
                      {billTo.companyName}
                    </div>
                    {billTo.addressLines.map((line, i) => (
                      <div key={i} className="text-slate-600" style={{ fontSize: 11.5 }}>
                        {line}
                      </div>
                    ))}
                    <div className="text-slate-600" style={{ fontSize: 11.5 }}>
                      {billTo.billingEmail}
                    </div>
                    {billTo.billingPhone && (
                      <div className="text-slate-600" style={{ fontSize: 11.5 }}>
                        {billTo.billingPhone}
                      </div>
                    )}
                  </div>
                </div>

                {/* Line item table */}
                <table className="w-full mb-6" style={{ fontSize: 11.5 }}>
                  <thead>
                    <tr
                      className="bg-slate-50 text-slate-500 uppercase text-left"
                      style={{ fontSize: 10 }}
                    >
                      <th className="py-2 px-2 font-semibold">Description</th>
                      <th className="py-2 px-2 font-semibold text-right">Rate</th>
                      <th className="py-2 px-2 font-semibold text-right">Qty</th>
                      <th className="py-2 px-2 font-semibold text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-slate-100 align-top">
                      <td className="py-2.5 px-2">
                        <div>
                          Platform usage — {cycle.label} ({cycle.periodStart} – {cycle.periodEnd})
                        </div>
                        <div className="text-slate-500" style={{ fontSize: 10.5 }}>
                          Loads written into Otoqa during the billing cycle
                        </div>
                        <span
                          className="inline-block rounded px-1.5 mt-1"
                          style={{ fontSize: 9.5, background: '#dbeafe', color: '#1e40af' }}
                        >
                          metered
                        </span>
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono">{money(cycle.rate)}</td>
                      <td className="py-2.5 px-2 text-right font-mono">
                        {cycle.loads.toLocaleString('en-US')}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono">{money(cycle.amount)}</td>
                    </tr>
                  </tbody>
                </table>

                {/* Summary */}
                <div className="flex justify-end mb-6">
                  <div style={{ width: 220 }}>
                    <div className="flex justify-between py-1.5 px-3" style={{ fontSize: 11.5 }}>
                      <span>Subtotal</span>
                      <span className="font-mono">{money(cycle.amount)}</span>
                    </div>
                    <div
                      className="flex justify-between py-2 px-3 font-bold bg-slate-50 border-t-2 border-slate-200"
                      style={{ fontSize: 13 }}
                    >
                      <span>{cycle.status === 'paid' ? 'Total' : 'Total Due'}</span>
                      <span className="font-mono">{money(cycle.amount)}</span>
                    </div>
                  </div>
                </div>

                {/* Footer */}
                <div
                  className="flex gap-10 pt-5 border-t border-dashed border-slate-200"
                  style={{ fontSize: 11.5 }}
                >
                  <div className="flex-1">
                    <div className="text-slate-500 uppercase mb-1.5" style={{ fontSize: 10 }}>
                      Billing model
                    </div>
                    <div className="text-slate-700" style={{ lineHeight: 1.5 }}>
                      Metered — {money(cycle.rate)} per load written into Otoqa, invoiced monthly.
                      Every load created during the cycle is billable regardless of its later
                      status.
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="text-slate-500 uppercase mb-1.5" style={{ fontSize: 10 }}>
                      Notes
                    </div>
                    <div className="text-slate-700" style={{ lineHeight: 1.5 }}>
                      Thank you for using Otoqa. For questions regarding this invoice, please
                      contact {OTOQA_BILLER.email}.
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
