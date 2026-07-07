/**
 * Shared vocabulary for the Driver & Carrier Settlements screens: the
 * lifecycle chip, pay-basis metadata, blocker definitions, money/date
 * formatters, and the enriched row shape returned by
 * driverSettlements.listActive / listSettled (and the carrier mirrors).
 *
 * One chassis, two parties — everything here is keyed by `party` where the
 * vocabulary differs.
 */

import type { IconName } from '@/components/web';

export type SettlementParty = 'driver' | 'carrier';

export type SettlementBucket =
  | 'open'
  | 'attention'
  | 'ready'
  | 'approved'
  | 'paid'
  | 'void'
  | 'disputed';

export type SettlementStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'PAID' | 'VOID' | 'DISPUTED';

export interface SettlementBlocker {
  key: string;
  sev: 'hard' | 'soft';
  detail?: string;
  /** Payable line ids this blocker points at — lets the panel jump to them. */
  lineIds?: string[];
  /** Reviewer marked this verified — no longer gates approval, stays shown. */
  acknowledged?: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: number;
}

/** Row shape shared by driver and carrier list queries. */
export interface SettlementRow {
  _id: string;
  statementNumber: string;
  status: SettlementStatus;
  bucket: SettlementBucket;
  payeeId: string;
  payeeName: string;
  payeeSub: string | null;
  periodStart: number;
  periodEnd: number;
  periodNumber: number | null;
  payDate: number | null;
  paidAt: number | null;
  paidMethod: string | null;
  paidReference: string | null;
  planBasis: 'mile' | 'hourly' | 'flat' | 'pct' | null;
  planDetail: string | null;
  cadence: string | null;
  units: string;
  loadCount: number;
  lineCount: number;
  earnTotal: number;
  reimbTotal: number;
  deductTotal: number;
  net: number;
  blockers: SettlementBlocker[];
  ageDays: number;
  voidReason: string | null;
  notes: string | null;
}

// ── settlement lifecycle chip (same visual formula as the invoice BillChip) ──

interface ChipPreset {
  bg: string;
  fg: string;
  dot: string;
  label: string;
}

export const SETTLE_PRESETS: Record<string, ChipPreset> = {
  open:     { bg: 'rgba(107,115,133,0.10)', fg: '#5A6172', dot: '#9BA3B4', label: 'Open' },
  blocked:  { bg: 'rgba(239,68,68,0.10)',   fg: '#B43030', dot: '#EF4444', label: 'Blocked' },
  ready:    { bg: 'rgba(46,92,255,0.10)',   fg: '#1A47E6', dot: '#2E5CFF', label: 'Ready' },
  approved: { bg: 'rgba(99,102,241,0.12)',  fg: '#4F46E5', dot: '#6366F1', label: 'Approved' },
  paid:     { bg: 'rgba(16,185,129,0.10)',  fg: '#0F8C5F', dot: '#10B981', label: 'Paid' },
  void:     { bg: 'rgba(107,115,133,0.10)', fg: '#5A6172', dot: '#9BA3B4', label: 'Void' },
  disputed: { bg: 'rgba(245,158,11,0.12)',  fg: '#A66800', dot: '#F59E0B', label: 'Disputed' },
};

/** Chip key for a row — blocked is derived, not a status. */
export function chipKeyForRow(row: Pick<SettlementRow, 'bucket'>): string {
  return row.bucket === 'attention' ? 'blocked' : row.bucket;
}

export function SettleChip({ chip, label }: { chip: string; label?: string }) {
  const p = SETTLE_PRESETS[chip] ?? SETTLE_PRESETS.open;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full whitespace-nowrap font-semibold"
      style={{ background: p.bg, color: p.fg, padding: '2px 10px 2px 8px', fontSize: 11.5, lineHeight: '18px' }}
    >
      <span
        className="rounded-full"
        style={{ width: 6, height: 6, background: p.dot, boxShadow: `0 0 0 2px ${p.bg}` }}
      />
      {label ?? p.label}
    </span>
  );
}

// ── pay basis vocabulary ─────────────────────────────────────────────────────

export const PLAN_META: Record<
  NonNullable<SettlementRow['planBasis']>,
  { label: string; icon: IconName }
> = {
  mile:   { label: 'Per mile',  icon: 'route' },
  hourly: { label: 'Hourly',    icon: 'clock' },
  flat:   { label: 'Flat rate', icon: 'doc-dollar' },
  pct:    { label: '% revenue', icon: 'chart-bar' },
};

// ── blockers ─────────────────────────────────────────────────────────────────
// Only data-backed blockers exist — checklist items without a backing data
// model (timesheets, W-9, bank details) join when their data does.

export interface BlockerMeta {
  label: string;
  short: string;
  icon: IconName;
  fix: string;
  /** Verify-to-clear button label (audit-logged acknowledgment). */
  verify: string;
}

const DRIVER_BLOCKERS: Record<string, BlockerMeta> = {
  shiftreview: { label: 'Shift hours need review',       short: 'Shift hours',  icon: 'clock',      fix: 'Open the flagged shift below — verify the hours, then adjust if needed', verify: 'Mark verified' },
  loadpay:  { label: 'Load pay not finalized',          short: 'Load pay',     icon: 'doc-dollar', fix: 'Open the flagged line below to finalize its pay', verify: 'Mark verified' },
  negative: { label: 'Net pay is negative',             short: 'Negative net', icon: 'warn-tri',   fix: 'Add an adjustment or carry the balance', verify: 'Carry to next period' },
  pod:      { label: 'POD missing on load',             short: 'POD',          icon: 'receipt',    fix: 'Upload proof of delivery', verify: 'Mark received' },
  receipts: { label: 'Reimbursement receipts pending',  short: 'Receipts',     icon: 'receipt',    fix: 'Attach toll / lumper receipts', verify: 'Mark attached' },
};

const CARRIER_BLOCKERS: Record<string, BlockerMeta> = {
  pod:       { label: 'POD missing on load',           short: 'POD',          icon: 'receipt',    fix: 'Upload proof of delivery', verify: 'Mark received' },
  insurance: { label: 'Insurance lapsed — pay hold',   short: 'Insurance',    icon: 'shield',     fix: 'Verify updated certificate', verify: 'Mark verified' },
  loadpay:   { label: 'Carrier pay not finalized',     short: 'Load pay',     icon: 'doc-dollar', fix: 'Open the flagged line below to finalize its pay', verify: 'Mark verified' },
  negative:  { label: 'Net pay is negative',           short: 'Negative net', icon: 'warn-tri',   fix: 'Add an adjustment or carry the balance', verify: 'Carry to next period' },
};

export function blockersFor(party: SettlementParty): Record<string, BlockerMeta> {
  return party === 'carrier' ? CARRIER_BLOCKERS : DRIVER_BLOCKERS;
}

/** Inline blocker chip for table rows — primary blocker + overflow count. */
export function SettleIssueCell({
  blockers,
  party,
}: {
  blockers: SettlementBlocker[];
  party: SettlementParty;
}) {
  const META = blockersFor(party);
  if (!blockers || blockers.length === 0) {
    return <span className="text-[12.5px] text-[var(--text-tertiary)]">—</span>;
  }
  const primary = blockers.find((b) => b.sev === 'hard') ?? blockers[0];
  const meta = META[primary.key];
  const extra = blockers.length - 1;
  const tone =
    primary.sev === 'hard'
      ? { bg: 'rgba(239,68,68,0.10)', fg: '#B43030', dot: '#EF4444' }
      : { bg: 'rgba(245,158,11,0.12)', fg: '#A66800', dot: '#F59E0B' };
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span
        className="inline-flex items-center gap-1.5 rounded-full whitespace-nowrap font-semibold"
        style={{ background: tone.bg, color: tone.fg, padding: '2px 10px 2px 8px', fontSize: 11.5, lineHeight: '18px' }}
      >
        <span className="rounded-full" style={{ width: 6, height: 6, background: tone.dot, boxShadow: `0 0 0 2px ${tone.bg}` }} />
        {meta ? meta.short : primary.key}
      </span>
      {extra > 0 && (
        <span className="num text-[11.5px] font-medium text-[var(--text-tertiary)]">+{extra}</span>
      )}
    </span>
  );
}

// ── formatters ───────────────────────────────────────────────────────────────

export const fmtUSD = (n: number | null | undefined, cents = true): string =>
  n == null
    ? '—'
    : (n < 0 ? '−' : '') +
      Math.abs(n).toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: cents ? 2 : 0,
        maximumFractionDigits: cents ? 2 : 0,
      });

export const fmtUSDCompact = (n: number | null | undefined): string => {
  if (n == null) return '—';
  if (Math.abs(n) >= 1000) {
    return (n < 0 ? '−$' : '$') + (Math.abs(n) / 1000).toFixed(Math.abs(n) >= 100000 ? 0 : 1) + 'K';
  }
  return fmtUSD(n, false);
};

export const fmtShortDate = (t: number | null | undefined): string =>
  t == null ? '—' : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** "Jun 1 – 7" or "May 25 – Jun 7" — the design's period column format. */
export function fmtPeriod(start: number, end: number): string {
  const s = new Date(start);
  const e = new Date(end);
  const sMo = s.toLocaleDateString('en-US', { month: 'short' });
  const eMo = e.toLocaleDateString('en-US', { month: 'short' });
  return sMo === eMo
    ? `${sMo} ${s.getDate()} – ${e.getDate()}`
    : `${sMo} ${s.getDate()} – ${eMo} ${e.getDate()}`;
}

/** Pay-run grouping key — settlements paying on the same date settle together. */
export function payRunKey(row: Pick<SettlementRow, 'payDate'>): string {
  return row.payDate == null ? 'Unscheduled' : fmtShortDate(row.payDate);
}
