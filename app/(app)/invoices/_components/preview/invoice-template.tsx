import React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  InvoiceLineItem, 
  InvoiceMeta, 
  LineItemsTable, 
  InvoiceSummary, 
  BillTo,
  InvoiceStatusBadge,
  Customer 
} from "./invoice-components";
import { formatDate } from "@/lib/utils/invoice";

interface Invoice {
  _id: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  status: 'MISSING_DATA' | 'DRAFT' | 'BILLED' | 'PENDING_PAYMENT' | 'PAID' | 'VOID';
  currency: 'USD' | 'CAD' | 'MXN';
  subtotal?: number;  // Optional - calculated for DRAFT, stored for finalized
  fuelSurcharge?: number;
  accessorialsTotal?: number;
  taxAmount?: number;
  totalAmount?: number;  // Optional - calculated for DRAFT, stored for finalized
  missingDataReason?: string;
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
}

export function InvoiceTemplate({ 
  invoice, 
  customer, 
  lineItems, 
  companyDetails 
}: InvoiceTemplateProps) {
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
    <ScrollArea className="h-full w-full print:h-auto print:overflow-visible">
      <div className="h-full flex items-start justify-center bg-background">
        <div className="invoice-container p-6 md:p-8 w-full max-w-[800px] flex flex-col bg-card print:border-0 print:p-6 print:max-w-full print:m-0 print:bg-white">
        
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
                currency: invoice.currency
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
    </ScrollArea>
  );
}
