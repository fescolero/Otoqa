/**
 * Shared shapes for the platform billing-cycle invoice (preview sheet +
 * PDF template). Kept in their own module so the sheet can type against
 * them without eagerly importing @react-pdf/renderer — the PDF template
 * is lazy-loaded only when the user prints/downloads.
 */

export interface BillingInvoiceCycle {
  /** "2026-06" — stable identity for navigation. */
  periodKey: string;
  /** "Jun 2026" */
  label: string;
  /** "INV-2026-06" — derived platform invoice number. */
  invoiceNo: string;
  loads: number;
  rate: number;
  amount: number;
  status: 'due' | 'paid';
  /** Due date has passed without settlement — badge reads PAST DUE. */
  pastDue?: boolean;
  /** Display dates, already formatted ("Jul 1, 2026"). */
  issuedOn: string;
  dueOn: string;
  paidOn?: string;
  periodStart: string;
  periodEnd: string;
}

export interface BillingInvoiceBillTo {
  companyName: string;
  billingEmail: string;
  billingPhone?: string | null;
  /** Pre-formatted address lines; empty when the org has no address on file. */
  addressLines: string[];
}

/**
 * Contract identity shown in the invoice details panel. Values are
 * pre-formatted for display; missing org fields render as "—".
 */
export interface BillingInvoiceContract {
  contractNumber: string;
  licenseStart: string;
  licenseEnd: string;
}

/** Payment terms — invoices issue on the 1st and are due on the 15th. */
export const INVOICE_TERMS = 'Net 15';

/**
 * The issuing entity on platform invoices — Otoqa itself.
 * TODO: replace with Otoqa's real remittance details (legal name, address,
 * billing email) before sending these invoices to customers.
 */
export const OTOQA_BILLER = {
  name: 'Otoqa',
  tagline: 'Transportation Management Platform',
  email: 'billing@otoqa.com',
} as const;

/** Resolved badge state for an invoice — shared by preview and PDF. */
export type InvoiceBadge = 'paid' | 'due' | 'pastdue';

export const invoiceBadge = (cycle: {
  status: 'due' | 'paid';
  pastDue?: boolean;
}): InvoiceBadge => (cycle.status === 'paid' ? 'paid' : cycle.pastDue ? 'pastdue' : 'due');

export const INVOICE_BADGE_LABEL: Record<InvoiceBadge, string> = {
  paid: 'PAID',
  due: 'DUE',
  pastdue: 'PAST DUE',
};

/** Shared money formatter so the HTML preview and the PDF can never differ. */
export const invoiceMoney = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const invoiceContactNote = () =>
  `Thank you for using Otoqa. For questions regarding this invoice, please contact ${OTOQA_BILLER.email}.`;
