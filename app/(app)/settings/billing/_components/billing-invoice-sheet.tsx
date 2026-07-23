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
import { ChevronLeft, ChevronRight, Download, FileX2, Printer, X } from 'lucide-react';
import { downloadPdfBlob, generatePdfWithToast, openPdfBlob } from '@/lib/pdf-actions';
import {
  INVOICE_BADGE_LABEL,
  INVOICE_TERMS,
  OTOQA_BILLER,
  invoiceBadge,
  invoiceContactNote,
  invoiceMoney as money,
  type BillingInvoiceBillTo,
  type BillingInvoiceContract,
  type BillingInvoiceCycle,
} from './billing-invoice-types';

// Soft badge tints that read on both light and dark surfaces (same palette
// as the app's Chip presets). The PDF keeps its own print-on-white tints.
const BADGE_TINTS = {
  paid: { bg: 'rgba(16,185,129,0.10)', fg: '#0F8C5F' },
  due: { bg: 'rgba(245,158,11,0.12)', fg: '#A66800' },
  pastdue: { bg: 'rgba(239,68,68,0.10)', fg: '#B43030' },
} as const;

/** Muted body text at the invoice's small type size. */
function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{children}</div>;
}

/** Uppercase section label (BILL TO / DETAILS / footer blocks). */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="uppercase mb-1.5"
      style={{ fontSize: 10, letterSpacing: 0.5, color: 'var(--text-tertiary)' }}
    >
      {children}
    </div>
  );
}

/** One label→value line in the invoice details panel. */
function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      className="flex items-baseline justify-between gap-6 py-1"
      style={{ fontSize: 11.5, borderBottom: '1px solid var(--border-hairline)' }}
    >
      <span style={{ color: 'var(--text-tertiary)' }}>{label}</span>
      <span className="font-semibold font-mono text-right">{value}</span>
    </div>
  );
}

interface BillingInvoiceSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** Closed cycles, newest first (matches the history table order). */
  cycles: BillingInvoiceCycle[];
  /** periodKey of the cycle being previewed. */
  activeKey: string | null;
  onNavigate: (periodKey: string) => void;
  billTo: BillingInvoiceBillTo;
  contract: BillingInvoiceContract;
}

export function BillingInvoiceSheet({
  isOpen,
  onClose,
  cycles,
  activeKey,
  onNavigate,
  billTo,
  contract,
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
    return pdf(
      <BillingInvoicePDFTemplate cycle={cycle} billTo={billTo} contract={contract} />,
    ).toBlob();
  }, [billTo, contract, cycle]);

  const handlePrint = useCallback(async () => {
    if (!cycle) return;
    const blob = await generatePdfWithToast(generateBlob, 'Generating PDF for printing...');
    if (blob) openPdfBlob(blob);
  }, [cycle, generateBlob]);

  const handleDownloadPDF = useCallback(async () => {
    if (!cycle) return;
    const blob = await generatePdfWithToast(generateBlob, 'Generating PDF...');
    if (blob) downloadPdfBlob(blob, `${cycle.invoiceNo}.pdf`);
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

              {cycles.length > 1 && currentIndex >= 0 && (
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
            {!cycle && (
              /* Stale key — the cycle left the history window (month rollover,
                 org switch) while the sheet was open. */
              <div className="h-full flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <FileX2 className="w-8 h-8 mx-auto mb-3" strokeWidth={1.5} />
                  <p className="text-sm">This invoice is no longer available.</p>
                </div>
              </div>
            )}
            {cycle && (
              /* Theme-aware document surface: renders as paper in light mode
                 and as a card in dark mode. The downloaded PDF stays white. */
              <div
                className="mx-auto shadow-sm rounded-sm"
                style={{
                  maxWidth: 680,
                  padding: 40,
                  fontSize: 13,
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-hairline)',
                }}
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
                    <Muted>{OTOQA_BILLER.tagline}</Muted>
                    <Muted>{OTOQA_BILLER.email}</Muted>
                  </div>
                  <div className="text-right">
                    <div style={{ fontSize: 26, letterSpacing: 0.5 }}>INVOICE</div>
                    <span
                      className="inline-block rounded px-2 py-0.5 font-semibold"
                      style={{
                        fontSize: 11,
                        background: BADGE_TINTS[invoiceBadge(cycle)].bg,
                        color: BADGE_TINTS[invoiceBadge(cycle)].fg,
                      }}
                    >
                      {INVOICE_BADGE_LABEL[invoiceBadge(cycle)]}
                    </span>
                  </div>
                </div>

                {/* Bill to + invoice details */}
                <div className="flex gap-10 mb-6">
                  <div className="flex-1">
                    <SectionLabel>Bill to</SectionLabel>
                    <div className="font-semibold" style={{ fontSize: 12 }}>
                      {billTo.companyName}
                    </div>
                    {billTo.addressLines.map((line, i) => (
                      <Muted key={i}>{line}</Muted>
                    ))}
                    <Muted>{billTo.billingEmail}</Muted>
                    {billTo.billingPhone && <Muted>{billTo.billingPhone}</Muted>}
                  </div>
                  <div className="flex-1">
                    <SectionLabel>Details</SectionLabel>
                    <DetailRow label="Invoice No" value={cycle.invoiceNo} />
                    <DetailRow label="Invoice date" value={cycle.issuedOn} />
                    <DetailRow label="Due date" value={cycle.dueOn} />
                    {cycle.status === 'paid' && (
                      <DetailRow label="Paid" value={cycle.paidOn ?? '—'} />
                    )}
                    <DetailRow label="Terms" value={INVOICE_TERMS} />
                    <DetailRow label="Contract #" value={contract.contractNumber} />
                    <DetailRow label="License start" value={contract.licenseStart} />
                    <DetailRow label="License end" value={contract.licenseEnd} />
                    <DetailRow
                      label="Billing period"
                      value={`${cycle.periodStart} – ${cycle.periodEnd}`}
                    />
                  </div>
                </div>

                {/* Line item table */}
                <table className="w-full mb-6" style={{ fontSize: 11.5 }}>
                  <thead>
                    <tr
                      className="uppercase text-left"
                      style={{
                        fontSize: 10,
                        background: 'var(--bg-surface-2)',
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      <th className="py-2 px-2 font-semibold">Description</th>
                      <th className="py-2 px-2 font-semibold text-right">Rate</th>
                      <th className="py-2 px-2 font-semibold text-right">Qty</th>
                      <th className="py-2 px-2 font-semibold text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      className="align-top"
                      style={{ borderBottom: '1px solid var(--border-hairline)' }}
                    >
                      <td className="py-2.5 px-2">
                        <div>
                          Platform usage — {cycle.label} ({cycle.periodStart} – {cycle.periodEnd})
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                          Loads written into Otoqa during the billing cycle
                        </div>
                        <span
                          className="inline-block rounded px-1.5 mt-1"
                          style={{
                            fontSize: 9.5,
                            background: 'rgba(46,92,255,0.10)',
                            color: 'var(--accent)',
                          }}
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
                      className="flex justify-between py-2 px-3 font-bold"
                      style={{
                        fontSize: 13,
                        background: 'var(--bg-surface-2)',
                        borderTop: '2px solid var(--border-hairline-strong)',
                      }}
                    >
                      <span>{cycle.status === 'paid' ? 'Total' : 'Total Due'}</span>
                      <span className="font-mono">{money(cycle.amount)}</span>
                    </div>
                  </div>
                </div>

                {/* Footer */}
                <div
                  className="pt-5"
                  style={{ fontSize: 11.5, borderTop: '1px dashed var(--border-hairline-strong)' }}
                >
                  <SectionLabel>Notes</SectionLabel>
                  <div style={{ lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                    {invoiceContactNote()}
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
