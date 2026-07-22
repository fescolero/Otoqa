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
 * The issuing entity on platform invoices — Otoqa itself.
 * TODO: replace with Otoqa's real remittance details (legal name, address,
 * billing email) before sending these invoices to customers.
 */
export const OTOQA_BILLER = {
  name: 'Otoqa',
  tagline: 'Transportation Management Platform',
  email: 'billing@otoqa.com',
} as const;
