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

// ── per-rate hour rollup (panel Net pay card + statement PDF totals) ─────────

export interface RateHoursRow {
  label: string;
  rate: number;
  hours: number;
  amount: number;
  /** Weekly cap applied to this layer — "capped at N h/week". Hours/amount
   *  above already reflect the cap (paid figures, not clocked figures). */
  cappedNote?: string;
}

/** A weekly-cap offset to fold into its capped component's row: `hours` and
 *  `amount` are positive magnitudes to subtract from the paid figures. */
export interface RateHoursCap {
  componentId: string;
  hours: number;
  amount: number;
  thresholdQty?: number;
}

/**
 * Group hourly earning lines by pay layer + rate — the total hours paid at
 * each distinct rate — so the Earnings figure reads as Σ hours × rate. The
 * "— Mon, Jun 8" / "— ORD-123" description tail is stripped so one layer
 * groups across its shifts and loads. Lines with no hours story (flat/mile/
 * legacy) land in `otherTotal`, keeping rows + otherTotal equal to the same
 * lines' earnings total. Returns null when nothing groups (non-hourly
 * statements). Layers are deliberately NOT summed into a grand hours figure:
 * stacked layers pay on the same clock hours, so adding them would
 * double-count time.
 *
 * `caps` (weekly hour caps) fold INTO their component's rows: the row then
 * shows the hours actually PAID with a "capped at N h/week" note — maxed
 * out, not deducted. Reconciliation holds: rows + otherTotal equals the
 * earnings total including the (negative) cap lines.
 */
export function buildRateHours(
  lines: Array<{ label: string; hours?: number; rate?: number; amount: number; componentId?: string }>,
  caps?: RateHoursCap[],
): { rows: RateHoursRow[]; otherTotal: number } | null {
  const groups = new Map<string, RateHoursRow & { componentId?: string }>();
  let otherTotal = 0;
  for (const l of lines) {
    if (l.hours != null && l.hours > 0 && l.rate != null) {
      const label = l.label.replace(/\s+—\s+[^—]+$/, '');
      const key = `${label}|${l.rate.toFixed(4)}`;
      const g = groups.get(key);
      if (g) {
        g.hours += l.hours;
        g.amount += l.amount;
      } else {
        groups.set(key, { label, rate: l.rate, hours: l.hours, amount: l.amount, componentId: l.componentId });
      }
    } else {
      otherTotal += l.amount;
    }
  }
  if (groups.size === 0) return null;

  // Fold each cap into its component's rows, dominant row first. Anything a
  // cap can't attach to (no matching row) still reduces otherTotal so the
  // breakdown keeps summing to the capped earnings total.
  for (const cap of caps ?? []) {
    let hoursLeft = Math.max(0, cap.hours);
    let amountLeft = Math.max(0, cap.amount);
    const targets = [...groups.values()]
      .filter((g) => g.componentId != null && g.componentId === cap.componentId)
      .sort((a, b) => b.amount - a.amount);
    for (const g of targets) {
      if (hoursLeft <= 0 && amountLeft <= 0) break;
      const takeHours = Math.min(g.hours, hoursLeft);
      const takeAmount = Math.min(g.amount, amountLeft);
      g.hours = Math.round((g.hours - takeHours) * 100) / 100;
      g.amount = +(g.amount - takeAmount).toFixed(2);
      g.cappedNote = cap.thresholdQty != null ? `capped at ${cap.thresholdQty} h/week` : 'weekly cap applied';
      hoursLeft -= takeHours;
      amountLeft -= takeAmount;
    }
    if (amountLeft > 0.005) otherTotal -= amountLeft;
  }

  // Dominant layer first — mirrors the shift cards' ordering.
  return {
    rows: [...groups.values()]
      .map((g) => {
        const { componentId, ...row } = g;
        void componentId;
        return row;
      })
      .sort((a, b) => b.amount - a.amount),
    otherTotal,
  };
}
