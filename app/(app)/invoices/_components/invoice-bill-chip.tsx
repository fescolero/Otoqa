/**
 * Invoice billing helpers + status chip for the Invoices list.
 *
 * Maps our six invoice statuses (plus the derived "overdue" / "partial"
 * states) onto the shared Otoqa Web `Chip` tones, and centralises the
 * balance / overdue / formatting math the table columns and stat-chips share.
 *
 * Status → chip:
 *   DRAFT          → draft (gray)     "Ready"        (shown in "Ready to invoice")
 *   BILLED/PENDING → assigned (blue)  "Sent"
 *     · overdue    → danger (red)     "Overdue"
 *     · partial    → pending (amber)  "Partial"
 *   PAID           → active (green)   "Paid"
 *   VOID           → cancelled (gray) "Void"
 *   MISSING_DATA   → warning (amber)  "Missing data"
 */

import { Chip, type ChipStatus } from '@/components/web';
import type { Id } from '@/convex/_generated/dataModel';

export type InvoiceStatus =
  | 'MISSING_DATA'
  | 'DRAFT'
  | 'BILLED'
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'VOID';

/** The shape the invoice table/columns read — a subset of `listInvoices` page items. */
export interface InvoiceRow {
  _id: Id<'loadInvoices'>;
  /** Stable id for the shared Table (`getRowId`). */
  id?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  status: InvoiceStatus;
  currency?: 'USD' | 'CAD' | 'MXN';
  totalAmount: number;
  paidAmount?: number;
  paymentDifference?: number;
  createdAt: number;
  customer?: { name: string } | null;
  load?: { orderNumber?: string; loadType?: 'CONTRACT' | 'SPOT' | 'UNMAPPED' } | null;
}

const DAY_MS = 86_400_000;

/** Open balance = invoiced total − amount paid. */
export const invoiceBalance = (inv: Pick<InvoiceRow, 'totalAmount' | 'paidAmount'>): number =>
  (inv.totalAmount ?? 0) - (inv.paidAmount ?? 0);

/** Past-due with an open balance (only meaningful for sent/billed invoices). */
export function isInvoiceOverdue(inv: InvoiceRow): boolean {
  if (inv.status !== 'BILLED' && inv.status !== 'PENDING_PAYMENT') return false;
  if (!inv.dueDate) return false;
  if (invoiceBalance(inv) <= 0) return false;
  const due = new Date(inv.dueDate).getTime();
  return !Number.isNaN(due) && due < Date.now();
}

/** Whole days past the due date (0 if not past due). */
export function invoiceDaysLate(inv: Pick<InvoiceRow, 'dueDate'>): number {
  if (!inv.dueDate) return 0;
  const due = new Date(inv.dueDate).getTime();
  if (Number.isNaN(due)) return 0;
  const diff = Date.now() - due;
  return diff > 0 ? Math.floor(diff / DAY_MS) : 0;
}

/** Partially paid (some payment recorded, balance still open). */
export const isInvoicePartial = (inv: InvoiceRow): boolean =>
  (inv.paidAmount ?? 0) > 0 && invoiceBalance(inv) > 0;

export function invoiceChip(inv: InvoiceRow): { status: ChipStatus; label: string } {
  switch (inv.status) {
    case 'VOID':
      return { status: 'cancelled', label: 'Void' };
    case 'PAID':
      return { status: 'active', label: 'Paid' };
    case 'DRAFT':
      return { status: 'draft', label: 'Ready' };
    case 'MISSING_DATA':
      return { status: 'warning', label: 'Missing data' };
    case 'BILLED':
    case 'PENDING_PAYMENT':
    default:
      if (isInvoiceOverdue(inv)) return { status: 'danger', label: 'Overdue' };
      if (isInvoicePartial(inv)) return { status: 'pending', label: 'Partial' };
      return { status: 'assigned', label: 'Sent' };
  }
}

export function InvoiceBillChip({ inv }: { inv: InvoiceRow }) {
  const { status, label } = invoiceChip(inv);
  return <Chip status={status} label={label} />;
}

// ── formatting ──────────────────────────────────────────────────────────
export function fmtUSD(n: number | null | undefined, cents = true): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

/** Compact dollar figure for header stat-chips — "$12.4K" / "$840". */
export function fmtUSDCompact(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1000) return '$' + (n / 1000).toFixed(n >= 100_000 ? 0 : 1) + 'K';
  return fmtUSD(n, false);
}

/** Short table date from an ISO string — "Jun 7". */
export function fmtShortDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
