import React from "react";
import { formatCurrency } from "@/lib/utils/invoice";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";

// --- Types based on Convex Schema ---
export type InvoiceLineItem = {
  _id: string;
  description: string;
  quantity: number;
  rate: number;
  amount: number;
  type: 'FREIGHT' | 'FUEL' | 'ACCESSORIAL' | 'TAX';
};

export type InvoiceTotals = {
  subtotal: number;
  fuelSurcharge?: number;
  accessorialsTotal?: number;
  taxAmount?: number;
  totalAmount: number;
  currency: string;
};

export type Customer = {
  name: string;
  office?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
};

// --- Components ---

/**
 * Invoice Meta Information (Invoice #, Dates)
 */
export function InvoiceMeta({ 
  invoiceNumber, 
  issueDate, 
  dueDate 
}: { 
  invoiceNumber?: string; 
  issueDate?: string; 
  dueDate?: string; 
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-[11px] font-mono">
      <div className="flex flex-col">
        <span className="text-muted-foreground">Invoice No:</span>
        <span className="font-medium">{invoiceNumber || 'DRAFT'}</span>
      </div>
      <div className="flex flex-col">
        <span className="text-muted-foreground">Issued:</span>
        <span className="font-medium">{issueDate || '-'}</span>
      </div>
      <div className="flex flex-col">
        <span className="text-muted-foreground">Due Date:</span>
        <span className="font-medium">{dueDate || '-'}</span>
      </div>
    </div>
  );
}

/**
 * Bill To Section (Customer Address)
 */
export function BillTo({ customer }: { customer: Customer }) {
  return (
    <div className="text-[11px] font-mono leading-tight">
      <p className="text-muted-foreground mb-2 uppercase tracking-wide">Bill To</p>
      <p className="font-medium text-foreground text-sm">{customer.name}</p>
      {customer.office && (
        <p className="text-xs text-muted-foreground mb-1">{customer.office}</p>
      )}
      <p className="mt-2">{customer.addressLine1}</p>
      {customer.addressLine2 && <p>{customer.addressLine2}</p>}
      <p>{customer.city}, {customer.state} {customer.zip}</p>
      <p>{customer.country}</p>
    </div>
  );
}

/**
 * Line Items Table
 */
export function LineItemsTable({ 
  items, 
  currency 
}: { 
  items: InvoiceLineItem[]; 
  currency: string;
}) {
  return (
    <div className="mt-8 font-mono">
      {/* Header */}
      <div className="grid grid-cols-[2fr_15%_15%_15%] gap-4 border-b border-border pb-2 mb-2 text-[11px] text-muted-foreground uppercase tracking-wide">
        <div>Description</div>
        <div className="text-right">Rate</div>
        <div className="text-right">Qty</div>
        <div className="text-right">Amount</div>
      </div>

      {/* Rows */}
      {items.map((item) => (
        <div 
          key={item._id} 
          className="grid grid-cols-[2fr_15%_15%_15%] gap-4 py-3 text-[11px] text-foreground border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors"
        >
          <div>
            <span className="block font-medium">{item.description}</span>
          </div>
          <div className="text-right">{formatCurrency(item.rate, currency)}</div>
          <div className="text-right">{item.quantity}</div>
          <div className="text-right font-semibold">{formatCurrency(item.amount, currency)}</div>
        </div>
      ))}
      
      {items.length === 0 && (
         <div className="py-12 text-center text-[11px] text-muted-foreground italic">
            No line items added yet.
         </div>
      )}
    </div>
  );
}

/**
 * Invoice Summary (Totals Section)
 */
export function InvoiceSummary({ totals }: { totals: InvoiceTotals }) {
  const { currency } = totals;
  
  return (
    <div className="w-full md:w-[320px] flex flex-col gap-3 font-mono text-[11px] bg-muted/30 p-4 rounded-lg border border-border">
      <div className="flex justify-between py-1">
        <span className="text-muted-foreground">Subtotal</span>
        <span className="font-medium">{formatCurrency(totals.subtotal, currency)}</span>
      </div>
      
      {!!totals.fuelSurcharge && (
        <div className="flex justify-between py-1">
          <span className="text-muted-foreground">Fuel Surcharge</span>
          <span className="font-medium">{formatCurrency(totals.fuelSurcharge, currency)}</span>
        </div>
      )}

      {!!totals.accessorialsTotal && (
        <div className="flex justify-between py-1">
          <span className="text-muted-foreground">Accessorials</span>
          <span className="font-medium">{formatCurrency(totals.accessorialsTotal, currency)}</span>
        </div>
      )}
      
      {(!!totals.fuelSurcharge || !!totals.accessorialsTotal) && (
        <Separator className="my-1" />
      )}

      {!!totals.taxAmount && (
        <div className="flex justify-between py-1">
          <span className="text-muted-foreground">Tax</span>
          <span className="font-medium">{formatCurrency(totals.taxAmount, currency)}</span>
        </div>
      )}

      <div className="flex justify-between py-2 text-sm font-bold border-t-2 border-border mt-1">
        <span>Total Due</span>
        <span className="text-base">{formatCurrency(totals.totalAmount, currency)}</span>
      </div>
    </div>
  );
}

/**
 * Status Badge
 */
export function InvoiceStatusBadge({ 
  status 
}: { 
  status: 'MISSING_DATA' | 'DRAFT' | 'BILLED' | 'PENDING_PAYMENT' | 'PAID' | 'VOID';
}) {
  return (
    <span className={cn(
      "text-[10px] px-2.5 py-1 rounded-full border font-medium uppercase tracking-wide",
      status === 'PAID' && 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400',
      status === 'BILLED' && 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400',
      status === 'PENDING_PAYMENT' && 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400',
      status === 'DRAFT' && 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-950 dark:text-slate-400',
      status === 'VOID' && 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400',
      status === 'MISSING_DATA' && 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400'
    )}>
      {status.replace('_', ' ')}
    </span>
  );
}
