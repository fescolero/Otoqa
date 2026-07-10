import React from "react";
import {
  InvoiceLineItem, 
  InvoiceMeta, 
  LineItemsTable, 
  InvoiceSummary, 
  BillTo,
  InvoiceStatusBadge,
  Customer 
} from "./invoice-components";
import { formatDate, formatCurrency } from "@/lib/utils/invoice";

interface Invoice {
  _id: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  status: 'MISSING_DATA' | 'DRAFT' | 'BILLED' | 'PENDING_PAYMENT' | 'PAID' | 'VOID';
  currency: 'USD' | 'CAD' | 'MXN';
  subtotal?: number;
  fuelSurcharge?: number;
  accessorialsTotal?: number;
  taxAmount?: number;
  totalAmount?: number;
  missingDataReason?: string;
  paidAmount?: number;
  paymentDate?: string;
  paymentReference?: string;
  paymentMiles?: number;
  paymentDifference?: number;
  load?: {
    effectiveMiles?: number;
    contractMiles?: number;
    googleMiles?: number;
    importedMiles?: number;
    manualMiles?: number;
  } | null;
  contractLaneMiles?: number | null;
}

interface PaymentRow {
  _id: string;
  amount: number;
  miles?: number | null;
  paymentDate?: string | null;
  reference?: string | null;
  note?: string | null;
}

interface CompanyDetails {
  name: string;
  logoUrl?: string;
  address: string;
  email: string;
  phone?: string;
}

interface InvoiceTemplateProps {
  invoice: Invoice | null | undefined;
  customer: Customer | null | undefined;
  lineItems: InvoiceLineItem[];
  companyDetails: CompanyDetails;
  /**
   * The individual payment ledger rows. When more than one exists (split /
   * partial payments), a history table is shown in place of the single
   * date + reference snapshot. Omit for surfaces that don't load them.
   */
  payments?: PaymentRow[];
  /**
   * Scale the document down (via CSS `zoom`) so the whole invoice fits the
   * available height without scrolling — used by the slide-over preview so it
   * reads the same on a short laptop or a tall desktop. Capped at 1 (never
   * enlarges). The full-page route leaves this off and scrolls naturally.
   */
  fitToHeight?: boolean;
}

export function InvoiceTemplate({
  invoice,
  customer,
  lineItems,
  companyDetails,
  payments,
  fitToHeight = false,
}: InvoiceTemplateProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const docRef = React.useRef<HTMLDivElement>(null);

  // Fit the document to the available height. Measure at zoom:1 first so the
  // result is independent of any previously-applied scale, then apply a zoom
  // that makes the natural height fit the container (minus a small margin).
  React.useLayoutEffect(() => {
    if (!fitToHeight) return;
    const container = containerRef.current;
    const doc = docRef.current;
    if (!container || !doc) return;

    const measure = () => {
      // Reset to 1 so the natural height is measured independent of any
      // previously-applied scale, then scale to fit (capped at 1).
      doc.style.setProperty('zoom', '1');
      const naturalH = doc.offsetHeight;
      const availH = container.clientHeight;
      if (naturalH > 0 && availH > 0) {
        const next = Math.min(1, (availH - 24) / naturalH);
        doc.style.setProperty('zoom', String(next > 0.25 ? next : 0.25));
      }
    };

    measure();
    // Re-fit when the container resizes (window/screen change). Call measure
    // directly — it only mutates the doc's zoom, never the observed container,
    // so there's no ResizeObserver feedback loop.
    const ro = new ResizeObserver(() => measure());
    ro.observe(container);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      doc.style.removeProperty('zoom');
    };
  }, [fitToHeight, invoice, customer, lineItems]);

  // Loading state
  if (!invoice || !customer) {
    return (
      <div className="flex items-center justify-center h-full min-h-[600px]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-sm text-muted-foreground">Loading invoice data...</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={
        fitToHeight
          ? 'h-full w-full overflow-hidden print:h-auto print:overflow-visible'
          : 'scroll-thin h-full w-full overflow-y-auto print:h-auto print:overflow-visible'
      }
    >
      <div
        className={
          fitToHeight
            ? 'h-full flex items-center justify-center bg-background print:block print:h-auto'
            : 'min-h-full flex items-start justify-center bg-background'
        }
      >
        <div ref={docRef} className="invoice-container p-6 md:p-8 w-full max-w-[800px] flex flex-col bg-card print:border-0 print:p-6 print:max-w-full print:m-0 print:bg-white">
        
        {/* Header / Logo */}
        <div className="flex justify-between items-start mb-4 print:mb-3">
          <div>
            {/* Company Logo/Icon */}
            {companyDetails.logoUrl ? (
              <img 
                src={companyDetails.logoUrl} 
                alt={`${companyDetails.name} logo`}
                className="h-12 w-12 object-contain mb-4"
              />
            ) : (
              <div className="h-12 w-12 bg-primary text-primary-foreground flex items-center justify-center font-bold text-xl rounded mb-4">
                {companyDetails.name.substring(0, 1)}
              </div>
            )}
            <h1 className="font-bold text-lg">{companyDetails.name}</h1>
            <div className="text-[11px] text-muted-foreground mt-1 font-mono whitespace-pre-line">
              {companyDetails.address}
            </div>
            {companyDetails.email && (
              <div className="text-[11px] text-muted-foreground font-mono mt-1">
                {companyDetails.email}
              </div>
            )}
            {companyDetails.phone && (
              <div className="text-[11px] text-muted-foreground font-mono">
                {companyDetails.phone}
              </div>
            )}
          </div>

          {/* Invoice Title & Status */}
          <div className="text-right">
            <h2 className="text-3xl font-light tracking-tight uppercase text-foreground">Invoice</h2>
            <div className="mt-2">
              <InvoiceStatusBadge status={invoice.status} />
            </div>
          </div>
        </div>

        {/* Meta Data (Invoice #, Dates) */}
        <div className="mb-4 print:mb-3">
          <InvoiceMeta 
            invoiceNumber={invoice.invoiceNumber}
            issueDate={formatDate(invoice.invoiceDate)}
            dueDate={formatDate(invoice.dueDate)}
          />
        </div>

        {/* Addresses (From & Bill To) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-4 print:mb-3 print:gap-4">
          <div>
            <p className="text-[11px] font-mono text-muted-foreground mb-2 uppercase tracking-wide">From</p>
            <div className="text-[11px] font-mono leading-tight">
              <p className="font-medium text-sm">{companyDetails.name}</p>
              <p className="mt-2">{companyDetails.email}</p>
              {companyDetails.phone && <p>{companyDetails.phone}</p>}
              <p className="whitespace-pre-line mt-2">{companyDetails.address}</p>
            </div>
          </div>
          <div>
            <BillTo customer={customer} />
          </div>
        </div>

        {/* Warning for Missing Data */}
        {invoice.status === 'MISSING_DATA' && invoice.missingDataReason && (
          <div className="mb-8 p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
            <p className="text-sm font-medium text-destructive mb-1">⚠️ Invoice Issue</p>
            <p className="text-xs text-muted-foreground">{invoice.missingDataReason}</p>
          </div>
        )}

        {/* Line Items Table */}
        <div className="mb-4 print:mb-3">
          <LineItemsTable 
            items={lineItems} 
            currency={invoice.currency} 
          />
        </div>

        {/* Miles Comparison */}
        {(invoice.load?.contractMiles || invoice.load?.googleMiles || invoice.load?.effectiveMiles || invoice.paymentMiles || invoice.contractLaneMiles) && (
          <div className="mb-4 print:mb-3 p-3 bg-muted/30 border rounded-lg">
            <p className="text-[11px] font-mono text-muted-foreground mb-2 uppercase tracking-wide">Miles</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {invoice.contractLaneMiles != null && (
                <div>
                  <p className="text-[10px] text-muted-foreground font-mono">Contract Lane</p>
                  <p className="text-sm font-mono font-medium">{invoice.contractLaneMiles.toLocaleString()}</p>
                </div>
              )}
              {invoice.load?.googleMiles != null && (
                <div>
                  <p className="text-[10px] text-muted-foreground font-mono">Google Maps</p>
                  <p className="text-sm font-mono font-medium">{invoice.load.googleMiles.toLocaleString()}</p>
                </div>
              )}
              {invoice.load?.effectiveMiles != null && (
                <div>
                  <p className="text-[10px] text-muted-foreground font-mono">Effective</p>
                  <p className="text-sm font-mono font-medium">{invoice.load.effectiveMiles.toLocaleString()}</p>
                </div>
              )}
              {invoice.paymentMiles != null && (
                <div>
                  <p className="text-[10px] text-muted-foreground font-mono">Payment Reported</p>
                  <p className="text-sm font-mono font-medium">{invoice.paymentMiles.toLocaleString()}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Payment Info — a history table when multiple payments exist (split /
            partial pays), otherwise the single date + reference snapshot. */}
        {(() => {
          const rows = payments ?? [];
          const multi = rows.length > 1;
          const showSnapshot =
            invoice.status === 'PAID' && (invoice.paymentDate || invoice.paymentReference);
          if (!multi && !showSnapshot) return null;

          return (
            <div className="mb-4 print:mb-3 p-3 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded-lg">
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide">
                  {multi ? `Payment History · ${rows.length} payments` : 'Payment Info'}
                </p>
                {multi && (
                  <p className="text-sm font-mono font-medium">
                    {formatCurrency(rows.reduce((s, r) => s + r.amount, 0), invoice.currency)}
                  </p>
                )}
              </div>

              {multi ? (
                <div className="overflow-hidden rounded border border-green-200 dark:border-green-900">
                  <table className="w-full text-sm font-mono">
                    <thead>
                      <tr className="text-[10px] text-muted-foreground uppercase tracking-wide text-left">
                        <th className="px-2 py-1 font-normal">Date</th>
                        <th className="px-2 py-1 font-normal">Reference / Check #</th>
                        <th className="px-2 py-1 font-normal text-right">Miles</th>
                        <th className="px-2 py-1 font-normal text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r._id} className="border-t border-green-200/70 dark:border-green-900/70">
                          <td className="px-2 py-1 whitespace-nowrap">{r.paymentDate ?? '—'}</td>
                          <td className="px-2 py-1">{r.reference ?? '—'}</td>
                          <td className="px-2 py-1 text-right">
                            {r.miles != null && r.miles > 0 ? r.miles.toLocaleString() : '—'}
                          </td>
                          <td className="px-2 py-1 text-right font-medium">
                            {formatCurrency(r.amount, invoice.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {invoice.paymentDate && (
                    <div>
                      <p className="text-[10px] text-muted-foreground font-mono">Payment Date</p>
                      <p className="text-sm font-mono font-medium">{invoice.paymentDate}</p>
                    </div>
                  )}
                  {invoice.paymentReference && (
                    <div>
                      <p className="text-[10px] text-muted-foreground font-mono">Reference / Check #</p>
                      <p className="text-sm font-mono font-medium">{invoice.paymentReference}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Footer / Summary */}
        <div className="mt-auto pt-3 print:pt-2">
          <div className="flex justify-end">
            <InvoiceSummary 
              totals={{
                subtotal: invoice.subtotal ?? 0,
                fuelSurcharge: invoice.fuelSurcharge,
                accessorialsTotal: invoice.accessorialsTotal,
                taxAmount: invoice.taxAmount,
                totalAmount: invoice.totalAmount ?? 0,
                currency: invoice.currency,
                paidAmount: invoice.paidAmount,
                paymentDifference: invoice.paymentDifference,
                status: invoice.status,
              }} 
            />
          </div>
          
          {/* Payment Terms & Notes */}
          <div className="mt-4 pt-3 print:mt-3 print:pt-2 border-t border-dashed border-border grid grid-cols-1 md:grid-cols-2 gap-6 print:gap-4">
            <div>
              <p className="text-[11px] text-muted-foreground font-mono mb-2 uppercase tracking-wide">Payment Details</p>
              <p className="text-[11px] font-mono leading-relaxed">
                Bank: Chase JP Morgan<br/>
                Account: **** 4029<br/>
                Routing: 021000021
              </p>
              <p className="text-[10px] text-muted-foreground font-mono mt-3">
                Payment due within 30 days of invoice date
              </p>
            </div>
            
            <div>
              <p className="text-[11px] text-muted-foreground font-mono mb-2 uppercase tracking-wide">Notes</p>
              <p className="text-[11px] font-mono leading-relaxed text-muted-foreground">
                Thank you for your business. For questions regarding this invoice, 
                please contact {companyDetails.email}.
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="mt-3 pt-2 print:mt-2 print:pt-2 border-t border-border text-center">
            <p className="text-[10px] text-muted-foreground">
              {companyDetails.name} • Generated on {new Date().toLocaleDateString('en-US', { 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
              })}
            </p>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
