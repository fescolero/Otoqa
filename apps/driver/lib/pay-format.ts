/**
 * Shared formatting + status metadata for the payee-facing settlement
 * screens (driver "My Pay" and carrier owner "Statements").
 */
import type { Palette } from './design-tokens';

export type MobileStatementStatus =
  | 'ACCRUING'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'PAID'
  | 'DISPUTED';

export interface StatementRow {
  id: string;
  source: 'legacy' | 'ledger';
  statementNumber: string | null;
  status: MobileStatementStatus;
  periodStart: number;
  periodEnd: number;
  payDate: number | null;
  paidAt: number | null;
  paidMethod: string | null;
  paidReference: string | null;
  earnTotal: number;
  reimbTotal: number;
  deductTotal: number;
  net: number;
  lineCount: number | null;
  loadCount: number | null;
  units: string | null;
  planDetail: string | null;
  brokerName?: string;
  partnershipId?: string;
}

export interface StatementLine {
  id: string;
  description: string;
  quantity: number;
  rate: number;
  totalAmount: number;
  category: 'EARNING' | 'REIMBURSEMENT' | 'DEDUCTION';
  kind: 'SYSTEM' | 'MANUAL';
  loadLabel: string | null;
  workStart: number | null;
  workEnd: number | null;
  shiftLoads: Array<{
    label: string;
    actualAt?: number;
    scheduledAt?: number;
    lane?: string;
  }> | null;
}

export function fmtMoney(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const MONTH_DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

export function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    weekday: 'short',
    ...MONTH_DAY,
  });
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', MONTH_DAY);
}

export function fmtRange(start: number, end: number): string {
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, '0')} ${ampm}`;
}

export interface StatusMeta {
  label: string;
  /** Palette key for the accent color of the pill. */
  color: (p: Palette) => string;
  /** Numbers may still move — show the provisional hint. */
  provisional: boolean;
}

export const STATUS_META: Record<MobileStatementStatus, StatusMeta> = {
  ACCRUING: { label: 'In progress', color: (p) => p.accent, provisional: true },
  IN_REVIEW: { label: 'In review', color: (p) => p.warning, provisional: true },
  APPROVED: { label: 'Approved', color: (p) => p.success, provisional: false },
  PAID: { label: 'Paid', color: (p) => p.success, provisional: false },
  DISPUTED: { label: 'Disputed', color: (p) => p.danger, provisional: false },
};
