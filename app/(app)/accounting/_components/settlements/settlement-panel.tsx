'use client';

/**
 * SettlementPanel — the working slide-over for the Driver / Carrier
 * Settlements screens.
 *
 * One chassis, two parties: blocked rows surface a "Settlement readiness"
 * card built from live blocker data; open rows show accruing lines with
 * approval locked until the period closes; ready rows approve directly;
 * approved rows hand off to the statement doc / record-payment flows.
 *
 * Data flows in two layers:
 *   - `row` (prop) — the enriched list row from listActive / listSettled.
 *     It carries totals, blockers, and lifecycle bucket and stays fresh via
 *     the parent's reactive Convex query.
 *   - details — per-party getSettlementDetails for the actual payable lines
 *     (and held items / fresher blockers).
 */

import * as React from 'react';
import { toast } from 'sonner';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { classifyPayable, type PayableCategory } from '@/convex/lib/settlementShared';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { useSettlementsLedger } from './use-settlements-ledger';
import { EntityAuditTimeline } from '@/components/audit/entity-audit-timeline';
import { Avatar, WBtn, WIcon, type IconName } from '@/components/web';
import {
  blockersFor,
  chipKeyForRow,
  fmtPeriod,
  fmtShortDate,
  fmtUSD,
  PLAN_META,
  SettleChip,
  type BlockerMeta,
  type SettlementBlocker,
  type SettlementParty,
  type SettlementRow,
} from './settlement-meta';

// ─── props ───────────────────────────────────────────────────────────────────

export interface SettlementPanelProps {
  party: SettlementParty;
  row: SettlementRow;
  organizationId: string;
  userId: string;
  onClose: () => void;
  onOpenDoc: (row: SettlementRow) => void;
  onRecordPayment: (row: SettlementRow) => void;
  /** Reopen an APPROVED settlement to DRAFT for corrections. */
  onReopen?: (row: SettlementRow) => void;
  onChanged?: () => void;
}

// ─── local line shape (normalized from either party's details payables) ─────

interface DetailsPayable {
  _id: string;
  loadId?: string;
  loadOrderNumber?: string;
  loadInternalId?: string;
  description: string;
  quantity: number;
  rate: number;
  totalAmount: number;
  sourceType: 'SYSTEM' | 'MANUAL';
  category?: PayableCategory;
  isRebillable?: boolean;
  createdAt: number;
  /** When the work happened (load first pickup / shift check-in). */
  workStart?: number;
  /** Shift check-out — present on session-based hourly lines. */
  workEnd?: number;
  /** Session behind a shift line — enables the per-shift profile picker. */
  sessionId?: string;
  /** The shift's current pay profile override (if any). */
  sessionPayProfileOverrideId?: string;
  /** The loads run during the shift, one reviewable row each. */
  shiftLoads?: Array<{ label: string; actualAt?: number; scheduledAt?: number; lane?: string }>;
  /** Rules-engine warning — surfaces inline on the line and gates approval. */
  warningMessage?: string;
  /** Review-edit state (Phase 2). */
  edited?: boolean;
  breakMinutes?: number;
  clockStart?: number;
  clockEnd?: number;
  originalRate?: number;
  originalQuantity?: number;
  originalTotalAmount?: number;
  /** Rules engine now computes a different amount than this locked edit. */
  rulesChanged?: boolean;
  rulesAmount?: number;
}

interface PanelLine {
  _id: string;
  label: string;
  sub?: string;
  calc?: string;
  /** Magnitude for deductions (stored negative); raw amount otherwise. */
  amount: number;
  removable: boolean;
  /** Start-of-day ms for the day the work happened — drives grouping. */
  dayKey: number;
  /** Precise work timestamp — ordering within the day. */
  at: number;
  /** Hours on this line (hourly basis) — feeds the day subtotal. */
  hours?: number;
  /** Loads run during the shift — rendered one row each for review. */
  loads?: Array<{ label: string; actualAt?: number; scheduledAt?: number; lane?: string }>;
  /** Session-backed shift line — gets the loads mini-table (or its absence note). */
  isShift?: boolean;
  /** Session id behind a shift line — enables the per-shift profile picker. */
  sessionId?: string;
  /** The shift's current pay profile override (if any). */
  sessionOverrideId?: string;
  /** Raw rate-line description (e.g. "Base hourly") — used as the row label
   *  when the line renders inside a load group (the group header carries the
   *  order number). */
  desc?: string;
  /** Work time formatted for display — lifted into the load group header. */
  timeLabel?: string;
  /** Rules-engine warning shown inline; this line is a blocker jump target. */
  warning?: string;
  /** Review-edit state — drives the editor and the "Adjusted" badge. */
  edited?: boolean;
  rate?: number;
  basis?: SettlementRow['planBasis'];
  breakMinutes?: number;
  clockStart?: number;
  clockEnd?: number;
  originalTotalAmount?: number;
  /** Rules drift: engine now computes a different amount than this edit. */
  rulesChanged?: boolean;
  rulesAmount?: number;
  /** Editable system line (DRAFT/PENDING + SYSTEM). */
  editableLine?: boolean;
  /** Load id for per-load adjustments. */
  loadId?: string;
  /** Per-load "Adjust" shortcut available (load lines on editable statements). */
  adjustableLoad?: boolean;
}

/**
 * Turn a raw Convex/server error into a short, human message for a toast.
 * Pulls the handler's `throw new Error("…")` text out of the wrapper, maps
 * known low-level failures to a plain hint, and never dumps a stack trace.
 */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (/ArgumentValidationError|Value does not match validator/i.test(raw)) {
    return 'The request was malformed. Please retry — if it keeps happening, let us know.';
  }
  // Handler errors arrive as "… Uncaught Error: <message>\n at …".
  const m = raw.match(/Uncaught Error:\s*(.+?)(?:\n|$)/);
  if (m) return m[1].trim();
  const firstLine = raw.split('\n')[0]?.trim();
  return firstLine && firstLine.length < 160 ? firstLine : 'Something went wrong. Please try again.';
}

const fmtTime = (t: number): string =>
  new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** ms-of-day → <input type="time"> "HH:MM" (local). */
const toTimeInput = (t: number): string => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
/** Apply an "HH:MM" to the date portion of `base` ms; returns new ms. */
const fromTimeInput = (v: string, base: number): number | null => {
  const m = String(v).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(base);
  d.setHours(+m[1], +m[2], 0, 0);
  return d.getTime();
};

const fmtDayLabel = (dayKey: number): string =>
  new Date(dayKey).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** "COLTON, CA → SAN BERNARDINO, CA" → "Colton → San Bernardino, CA". */
function fmtLane(lane: string): string {
  // Title-case every word except state codes (2 letters following ", "),
  // then lowercase the lone mid-name connective ("City Of Industry" → "of").
  const title = lane
    .replace(/[A-ZÀ-Ý][A-ZÀ-Ý']+/g, (w, offset: number, s: string) => {
      if (w.length === 2 && s.slice(Math.max(0, offset - 2), offset) === ', ') return w;
      return w[0] + w.slice(1).toLowerCase();
    })
    .replace(/ Of /g, ' of ');
  const m = title.match(/^(.*), ([A-Z]{2}) → (.*), ([A-Z]{2})$/);
  if (m && m[2] === m[4]) return `${m[1]} → ${m[3]}, ${m[4]}`;
  return title;
}

const startOfDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "412 mi @ $0.62/mi" / "8.5 h @ $32/hr" — '—' when there's no quantity story. */
function calcFor(p: DetailsPayable, basis: SettlementRow['planBasis']): string {
  if (p.quantity === 1) return '—';
  if (basis === 'mile') {
    return `${Math.round(p.quantity).toLocaleString('en-US')} mi @ $${p.rate.toFixed(2)}/mi`;
  }
  if (basis === 'hourly') {
    return `${p.quantity} h @ $${p.rate}/hr`;
  }
  return `${p.quantity.toLocaleString('en-US')} × ${fmtUSD(p.rate)}`;
}

// ─── small shared bits (StStat / StSectionLabel / StIconBtn …) ───────────────

function StStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'danger' | 'warn' | 'ok';
}) {
  const color =
    tone === 'danger' ? '#B43030' : tone === 'warn' ? '#A66800' : tone === 'ok' ? '#0F8C5F' : 'var(--text-primary)';
  return (
    <div>
      <div className="uppercase" style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.5, color: 'var(--text-tertiary)' }}>
        {label}
      </div>
      <div className="num" style={{ fontSize: 17, fontWeight: 600, color, marginTop: 3, letterSpacing: -0.1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function StSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="uppercase" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: 'var(--text-tertiary)', marginBottom: 8 }}>
      {children}
    </div>
  );
}

function StIconBtn({ icon, onClick, tip }: { icon: IconName; onClick?: () => void; tip?: string }) {
  return (
    <button
      type="button"
      title={tip}
      onClick={onClick}
      className="focus-ring h-7 w-7 inline-flex items-center justify-center rounded-md cursor-pointer text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-[var(--text-primary)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]"
    >
      <WIcon name={icon} size={14} />
    </button>
  );
}

const EDIT_INPUT: React.CSSProperties = {
  height: 26,
  borderRadius: 6,
  padding: '0 6px',
  border: '1px solid var(--accent)',
  background: 'var(--bg-surface)',
  fontSize: 12,
  color: 'var(--text-primary)',
  outline: 'none',
};

/** Inline editor for a system earning line — shift clock/break/rate, or a
 *  load's pay rate. Commits via onEdit (override-in-place on the backend). */
function StLineEditor({ line, onEdit, onCancel }: {
  line: PanelLine;
  onEdit: (patch: { rate?: number; overrideStartAt?: number; overrideEndAt?: number; breakMinutes?: number }) => void;
  onCancel: () => void;
}) {
  const isShift = line.isShift;
  const [start, setStart] = React.useState(line.clockStart != null ? toTimeInput(line.clockStart) : '');
  const [end, setEnd] = React.useState(line.clockEnd != null ? toTimeInput(line.clockEnd) : '');
  const [brk, setBrk] = React.useState(String(line.breakMinutes ?? 0));
  const isPct = line.basis === 'pct';
  const [rate, setRate] = React.useState(
    line.rate != null ? (isPct ? String(+(line.rate * 100).toFixed(2)) : String(line.rate)) : '',
  );

  const commit = () => {
    const patch: { rate?: number; overrideStartAt?: number; overrideEndAt?: number; breakMinutes?: number } = {};
    const r = parseFloat(rate);
    if (Number.isFinite(r) && r >= 0) patch.rate = isPct ? +(r / 100).toFixed(4) : +r.toFixed(4);
    if (isShift) {
      const s = line.clockStart != null ? fromTimeInput(start, line.clockStart) : null;
      // The end time is interpreted on the SAME calendar day as the start;
      // only roll to the next day when end ≤ start (a genuine overnight
      // shift). The original clock-out may have been past midnight (its base
      // date is day+1), so anchoring on the start avoids a multi-day span.
      let e: number | null = null;
      if (s != null) {
        e = fromTimeInput(end, s);
        if (e != null && e <= s) e += 24 * 3_600_000;
      } else if (line.clockEnd != null) {
        e = fromTimeInput(end, line.clockEnd);
      }
      if (s != null) patch.overrideStartAt = s;
      if (e != null) patch.overrideEndAt = e;
      const b = parseFloat(brk);
      patch.breakMinutes = Number.isFinite(b) && b >= 0 ? b : 0;
    }
    onEdit(patch);
  };
  const onKeys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') onCancel();
  };

  // Live preview of the resulting paid hours + amount (same overnight-aware
  // math as commit), so a mistyped clock time is visible before saving.
  const preview = React.useMemo(() => {
    const r = parseFloat(rate);
    const rateVal = Number.isFinite(r) && r >= 0 ? (isPct ? r / 100 : r) : (line.rate ?? 0);
    if (!isShift) return null;
    const s = line.clockStart != null ? fromTimeInput(start, line.clockStart) : null;
    if (s == null) return null;
    let e = fromTimeInput(end, s);
    if (e == null) return null;
    if (e <= s) e += 24 * 3_600_000;
    const b = parseFloat(brk);
    const hours = Math.max((e - s) / 3_600_000 - (Number.isFinite(b) && b >= 0 ? b : 0) / 60, 0);
    return { hours, amount: +(hours * rateVal).toFixed(2) };
  }, [isShift, start, end, brk, rate, isPct, line.clockStart, line.rate]);

  return (
    <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 8 }}>
      {isShift && (
        <>
          <input autoFocus type="time" value={start} onChange={(e) => setStart(e.target.value)} onKeyDown={onKeys} className="num focus-ring" style={EDIT_INPUT} />
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>–</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} onKeyDown={onKeys} className="num focus-ring" style={EDIT_INPUT} />
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>break</span>
          <input type="number" min="0" step="5" value={brk} onChange={(e) => setBrk(e.target.value)} onKeyDown={onKeys} className="num focus-ring" style={{ ...EDIT_INPUT, width: 52, textAlign: 'right' }} />
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>min</span>
        </>
      )}
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{isPct ? '' : '$'}</span>
      <input
        autoFocus={!isShift}
        type="number" min="0" step={isPct ? '0.5' : line.basis === 'mile' ? '0.01' : '1'}
        value={rate} onChange={(e) => setRate(e.target.value)} onKeyDown={onKeys}
        className="num focus-ring" style={{ ...EDIT_INPUT, width: 64, textAlign: 'right' }}
      />
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{isPct ? '%' : isShift || line.basis === 'mile' ? (isShift ? '/hr' : '/mi') : ''}</span>
      {preview && (
        <span className="num" style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>
          = {preview.hours.toFixed(2)} h · {fmtUSD(preview.amount, false)}
        </span>
      )}
      <button onClick={commit} className="focus-ring inline-flex items-center justify-center rounded" title="Apply" style={{ width: 26, height: 26, border: 0, cursor: 'pointer', background: 'var(--accent)', color: '#FFF' }}>
        <WIcon name="check" size={13} strokeWidth={2.4} />
      </button>
      <button onClick={onCancel} className="focus-ring inline-flex items-center justify-center rounded" title="Cancel" style={{ width: 26, height: 26, border: '1px solid var(--border-hairline)', cursor: 'pointer', background: 'transparent', color: 'var(--text-tertiary)' }}>
        <WIcon name="close" size={12} />
      </button>
    </div>
  );
}

/** One line inside an earnings / reimbursement / deduction card. */
// ── load grouping — one header per load, its rate lines nested under it ─────
//
// A load paying multiple rate lines (base hourly + on-load premium, or
// mileage + stop pay) would otherwise render as sibling rows that read like
// duplicate charges. Group them: the header carries the order number, work
// time, and the load's combined total; each rate line renders indented
// beneath it with its own edit affordances intact.

type DayRenderGroup =
  | { kind: 'line'; line: PanelLine }
  | { kind: 'load'; key: string; label: string; time?: string; total: number; lines: PanelLine[] };

function groupLoadLines(dayLines: PanelLine[]): DayRenderGroup[] {
  const out: DayRenderGroup[] = [];
  const byLoad = new Map<string, number>();
  for (const l of dayLines) {
    if (l.isShift || !l.loadId) {
      out.push({ kind: 'line', line: l });
      continue;
    }
    const i = byLoad.get(l.loadId);
    if (i === undefined) {
      byLoad.set(l.loadId, out.length);
      out.push({ kind: 'load', key: l.loadId, label: l.label, time: l.timeLabel, total: l.amount, lines: [l] });
    } else {
      const g = out[i] as Extract<DayRenderGroup, { kind: 'load' }>;
      g.total += l.amount;
      g.lines.push(l);
    }
  }
  return out;
}

function StLoadHeader({ label, time, total, first }: { label: string; time?: string; total: number; first: boolean }) {
  return (
    <div
      className="flex items-baseline gap-2"
      style={{ padding: '9px 14px 2px', borderTop: first ? 'none' : '1px solid var(--border-hairline)' }}
    >
      <span className="num tw-mono" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
        {label}
      </span>
      {time && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{time}</span>}
      <span className="flex-1" />
      <span className="num" style={{ fontSize: 12.5, fontWeight: 600 }}>{fmtUSD(total)}</span>
    </div>
  );
}

function StLineRow({
  line,
  first,
  mono,
  negative,
  highlighted,
  onRemove,
  onEdit,
  onRevert,
  onAdjustLoad,
  onApplyRules,
  shiftProfile,
  indent,
}: {
  line: PanelLine;
  first: boolean;
  mono?: boolean;
  negative?: boolean;
  highlighted?: boolean;
  onRemove?: (payableId: string) => void;
  onEdit?: (payableId: string, patch: { rate?: number; overrideStartAt?: number; overrideEndAt?: number; breakMinutes?: number }) => void;
  onRevert?: (payableId: string) => void;
  onAdjustLoad?: (loadId: string, label: string) => void;
  onApplyRules?: (payableId: string) => void;
  /** Per-shift pay profile override control (driver hourly shift lines). */
  shiftProfile?: {
    value: string;                                    // 'auto' | payProfiles id
    options: Array<{ value: string; label: string }>;
    saving: boolean;
    onChange: (value: string) => void;
  };
  /** Rendered nested under a load group header — indented, no divider. */
  indent?: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  return (
    <div
      data-line-id={line._id}
      className="group flex items-start gap-3"
      style={{
        padding: indent ? '5px 14px 5px 28px' : '10px 14px',
        borderTop: first ? 'none' : '1px solid var(--border-hairline)',
        // Pulses when a readiness blocker jumps to this line.
        background: highlighted ? 'rgba(245,158,11,0.10)' : line.warning ? 'rgba(245,158,11,0.04)' : undefined,
        boxShadow: highlighted ? 'inset 2px 0 0 #F59E0B' : line.warning ? 'inset 2px 0 0 rgba(245,158,11,0.5)' : undefined,
        transition: 'background var(--dur-med) var(--ease-out)',
        scrollMarginTop: 12,
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={mono ? 'num tw-mono' : undefined} style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
            {line.label}
          </span>
          {line.edited && (
            <span
              className="uppercase"
              style={{ fontSize: 9, fontWeight: 600, letterSpacing: 0.4, color: 'var(--accent)', padding: '1px 5px', borderRadius: 3, background: 'rgba(46,92,255,0.08)' }}
            >
              Adjusted
            </span>
          )}
          {line.editableLine && onEdit && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              title={line.isShift ? 'Correct clock time, break, or rate' : "Edit this line's rate"}
              className="focus-ring inline-flex items-center gap-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ height: 20, padding: '0 7px', border: '1px solid var(--border-hairline)', background: 'transparent', cursor: 'pointer', fontSize: 10.5, fontWeight: 500, color: 'var(--text-tertiary)' }}
            >
              <WIcon name="edit" size={10} />
              {line.isShift ? 'Edit time & rate' : 'Edit rate'}
            </button>
          )}
          {line.adjustableLoad && line.loadId && onAdjustLoad && !editing && (
            <button
              type="button"
              onClick={() => onAdjustLoad(line.loadId!, line.label)}
              title="Add an adjustment tied to this load"
              className="focus-ring inline-flex items-center gap-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ height: 20, padding: '0 7px', border: '1px solid var(--border-hairline)', background: 'transparent', cursor: 'pointer', fontSize: 10.5, fontWeight: 500, color: 'var(--text-tertiary)' }}
            >
              <WIcon name="plus" size={10} />
              Adjust
            </button>
          )}
          {line.edited && onRevert && !editing && (
            <button
              type="button"
              onClick={() => onRevert(line._id)}
              title="Restore the original system amount"
              className="focus-ring rounded opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ fontSize: 10.5, color: 'var(--text-tertiary)', background: 'none', border: 0, padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
            >
              Revert
            </button>
          )}
        </div>
        {line.sub && (
          <div className="truncate" style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
            {line.sub}
          </div>
        )}
        {shiftProfile && (
          <div className="flex items-center gap-1.5" style={{ marginTop: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
              Profile
            </span>
            <div className="relative">
              <select
                value={shiftProfile.value}
                disabled={shiftProfile.saving}
                onChange={(e) => shiftProfile.onChange(e.target.value)}
                className="appearance-none cursor-pointer disabled:cursor-wait"
                style={{
                  height: 22,
                  padding: '0 22px 0 7px',
                  borderRadius: 5,
                  border: '1px solid var(--border-hairline)',
                  background: 'transparent',
                  fontFamily: 'inherit',
                  fontSize: 11,
                  color: shiftProfile.value === 'auto' ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                  opacity: shiftProfile.saving ? 0.6 : 1,
                  maxWidth: 240,
                }}
              >
                <option value="auto">Driver default (auto)</option>
                {shiftProfile.options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <span
                className="absolute pointer-events-none"
                style={{ right: 7, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }}
              >
                <WIcon name="chevron-down" size={10} />
              </span>
            </div>
            {shiftProfile.value !== 'auto' && (
              <span
                className="uppercase"
                style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.4, color: '#A66800', padding: '1px 5px', borderRadius: 3, background: 'rgba(245,158,11,0.12)' }}
              >
                Override
              </span>
            )}
          </div>
        )}
        {line.loads && line.loads.length > 0 ? (
          // Flat sub-section — a divider and the column grid carry the
          // structure; no third nested box (canvas → card → rows only).
          <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--border-hairline)' }}>
            <div
              className="uppercase"
              style={{
                display: 'grid',
                gridTemplateColumns: '64px 64px 104px 1fr',
                gap: 8,
                fontSize: 9.5,
                fontWeight: 600,
                letterSpacing: 0.5,
                color: 'var(--text-tertiary)',
                paddingBottom: 4,
                borderBottom: '1px solid var(--border-hairline)',
                marginBottom: 4,
              }}
            >
              <span>In</span>
              <span>Sched</span>
              <span>Order #</span>
              <span>Lane</span>
            </div>
            {line.loads.map((ld) => {
              // Quietly amber when check-in ran >45 min behind plan — the
              // drift a reviewer should glance at, silent otherwise.
              const driftMin =
                ld.actualAt != null && ld.scheduledAt != null
                  ? Math.round((ld.actualAt - ld.scheduledAt) / 60000)
                  : null;
              const late = driftMin != null && driftMin > 45;
              return (
                <div
                  key={ld.label}
                  className="items-baseline"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '64px 64px 104px 1fr',
                    gap: 8,
                    fontSize: 11.5,
                    lineHeight: '17px',
                  }}
                >
                  <span
                    className="num whitespace-nowrap"
                    title={late ? `Checked in ${Math.floor(driftMin! / 60)}h ${driftMin! % 60}m after schedule` : undefined}
                    style={{ color: late ? '#A66800' : 'var(--text-secondary)', fontWeight: 500 }}
                  >
                    {ld.actualAt != null ? fmtTime(ld.actualAt) : '—'}
                  </span>
                  <span className="num whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                    {ld.scheduledAt != null ? fmtTime(ld.scheduledAt) : '—'}
                  </span>
                  <span className="num tw-mono truncate" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                    {ld.label}
                  </span>
                  <span className="truncate" title={ld.lane} style={{ color: 'var(--text-tertiary)' }}>
                    {ld.lane ? fmtLane(ld.lane) : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        ) : line.isShift ? (
          <div style={{ marginTop: 5, fontSize: 11.5, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <WIcon name="circle-alert" size={12} color="#A66800" />
            No loads linked to this shift
          </div>
        ) : null}
        {line.warning && (
          <div
            className="flex items-start gap-1.5"
            style={{ marginTop: 6, fontSize: 11.5, lineHeight: '16px', color: '#A66800', fontWeight: 500 }}
          >
            <WIcon name="warn-tri" size={12} color="#A66800" />
            <span>{line.warning}</span>
          </div>
        )}
        {/* Rules drift: the engine now computes a different amount than this
            kept edit. Offer a one-click adopt; the reviewer's number stands
            until they choose to take the update. */}
        {line.rulesChanged && line.rulesAmount != null && onApplyRules && (
          <div
            className="flex items-center gap-1.5 flex-wrap"
            style={{ marginTop: 6, fontSize: 11.5, lineHeight: '16px', color: 'var(--text-secondary)' }}
          >
            <WIcon name="refresh" size={12} color="#6366F1" />
            <span>
              Pay rules changed — now{' '}
              <span className="num" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{fmtUSD(line.rulesAmount, false)}</span>.
            </span>
            <button
              type="button"
              onClick={() => onApplyRules(line._id)}
              className="focus-ring rounded cursor-pointer"
              style={{ padding: '1px 7px', fontSize: 11, fontWeight: 600, color: '#4F46E5', background: 'rgba(99,102,241,0.1)' }}
            >
              Apply update
            </button>
          </div>
        )}
        {editing && onEdit && (
          <StLineEditor
            line={line}
            onEdit={(patch) => { onEdit(line._id, patch); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        )}
      </div>
      <div className="text-right shrink-0">
        <div className="num" style={{ fontSize: 12.5, fontWeight: 500, color: negative ? '#B43030' : 'var(--text-primary)' }}>
          {negative ? '−' + fmtUSD(line.amount) : fmtUSD(line.amount)}
        </div>
        {line.edited && line.originalTotalAmount != null && line.originalTotalAmount !== line.amount && (
          <div className="num" style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 1, textDecoration: 'line-through' }}>
            {fmtUSD(line.originalTotalAmount)}
          </div>
        )}
        {line.calc && (
          <div className="num" style={{ fontSize: 11, color: line.edited ? 'var(--accent)' : 'var(--text-tertiary)', fontWeight: line.edited ? 600 : 400, marginTop: 2 }}>
            {line.calc}
          </div>
        )}
      </div>
      {/* Manual lines can be pulled off an editable statement; system lines
          are managed by the rules engine — no remove. */}
      {line.removable && onRemove && (
        <button
          type="button"
          title="Remove from statement"
          onClick={() => onRemove(line._id)}
          className="focus-ring h-5 w-5 mt-0.5 shrink-0 inline-flex items-center justify-center rounded cursor-pointer text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-row-hover)] hover:text-[#B43030] transition-opacity duration-[var(--dur-fast)]"
        >
          <WIcon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

/** Day band inside the earnings card — date left, hours/amount summary right. */
function StDayHeader({ dayKey, dayLines, first }: { dayKey: number; dayLines: PanelLine[]; first: boolean }) {
  const hours = dayLines.reduce((s, l) => s + (l.hours ?? 0), 0);
  const amount = dayLines.reduce((s, l) => s + l.amount, 0);
  return (
    <div
      className="flex items-center gap-3"
      style={{
        padding: '7px 14px',
        borderTop: first ? 'none' : '1px solid var(--border-hairline)',
        background: 'var(--bg-surface-2)',
      }}
    >
      <span className="flex-1" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
        {fmtDayLabel(dayKey)}
      </span>
      <span className="num" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        {hours > 0 ? `${Math.round(hours * 100) / 100} h · ` : ''}
        {fmtUSD(amount, false)}
      </span>
    </div>
  );
}

function StSubtotal({ label, value, negative }: { label: string; value: number; negative?: boolean }) {
  return (
    <div
      className="flex items-center gap-3"
      style={{ padding: '9px 14px', borderTop: '1px solid var(--border-hairline)', background: 'var(--bg-surface-2)' }}
    >
      <span className="flex-1" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
        {label}
      </span>
      <span className="num" style={{ fontSize: 12.5, fontWeight: 600, color: negative ? '#B43030' : 'var(--text-primary)' }}>
        {negative ? '−' + fmtUSD(value) : fmtUSD(value)}
      </span>
    </div>
  );
}

/**
 * One blocker row inside the readiness card. Blockers are LIVE DATA from the
 * backend (row.blockers / details.blockers) — there's nothing to tick off
 * here. The `fix` hint renders as plain helper text; when the underlying
 * issue is resolved elsewhere (POD uploaded, pay finalized, insurance
 * verified…) Convex reactivity drops the blocker from the array and this row
 * disappears on its own.
 */
function StBlockerRow({
  blocker,
  meta,
  first,
  editable,
  onJump,
  onAcknowledge,
  onUndo,
}: {
  blocker: SettlementBlocker;
  meta?: BlockerMeta;
  first: boolean;
  editable: boolean;
  onJump?: (lineId: string) => void;
  onAcknowledge?: (key: string) => void;
  onUndo?: (key: string) => void;
}) {
  const done = !!blocker.acknowledged;
  const hard = blocker.sev === 'hard';
  const color = done ? '#10B981' : hard ? '#EF4444' : '#F59E0B';
  const target = blocker.lineIds && blocker.lineIds.length > 0 ? blocker.lineIds[0] : null;
  const jumpable = !done && !!(target && onJump);
  return (
    <div
      className="flex items-start gap-3"
      style={{
        padding: '13px 16px',
        borderTop: first ? 'none' : '1px solid var(--border-hairline)',
        background: done ? 'rgba(16,185,129,0.04)' : hard ? 'rgba(239,68,68,0.025)' : 'rgba(245,158,11,0.03)',
      }}
    >
      <span
        className="inline-flex items-center justify-center rounded-full shrink-0"
        style={{
          width: 22,
          height: 22,
          marginTop: 1,
          background: done ? 'rgba(16,185,129,0.14)' : hard ? 'rgba(239,68,68,0.10)' : 'rgba(245,158,11,0.12)',
          color,
        }}
      >
        {done ? (
          <WIcon name="check" size={13} strokeWidth={2.6} />
        ) : (
          <span className="rounded-full" style={{ width: 7, height: 7, background: color }} />
        )}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
            {meta?.label ?? blocker.key}
          </span>
          {!hard && !done && (
            <span className="uppercase" style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, color: '#A66800' }}>
              Optional
            </span>
          )}
        </div>
        {done ? (
          <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
            <span style={{ fontSize: 12, color: '#0F8C5F' }}>Verified</span>
            {editable && onUndo && (
              <button
                type="button"
                onClick={() => onUndo(blocker.key)}
                className="focus-ring"
                style={{ fontSize: 11.5, color: 'var(--text-tertiary)', background: 'none', border: 0, padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
              >
                Undo
              </button>
            )}
          </div>
        ) : (
          <>
            {blocker.detail && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>{blocker.detail}</div>
            )}
            <div className="flex items-center gap-3 flex-wrap" style={{ marginTop: 8 }}>
              {jumpable && (
                <button
                  type="button"
                  onClick={() => onJump!(target!)}
                  className="focus-ring inline-flex items-center gap-1.5"
                  style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 500, background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
                >
                  {meta && <WIcon name={meta.icon} size={13} />}
                  {meta?.fix ?? 'Locate'}
                  <WIcon name="arrow-right" size={12} />
                </button>
              )}
              {editable && onAcknowledge && meta && (
                <WBtn size="xs" variant="secondary" onClick={() => onAcknowledge(blocker.key)}>
                  {meta.verify}
                </WBtn>
              )}
            </div>
            {!jumpable && meta && !onAcknowledge && (
              <div className="flex items-center gap-1.5" style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 5 }}>
                <WIcon name={meta.icon} size={13} />
                {meta.fix}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const CARD_STYLE: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-hairline)',
  borderRadius: 12,
  overflow: 'hidden',
  marginBottom: 20,
};

// ─── the panel ───────────────────────────────────────────────────────────────

export function SettlementPanel({
  party,
  row,
  organizationId,
  userId,
  onClose,
  onOpenDoc,
  onRecordPayment,
  onReopen,
  onChanged,
}: SettlementPanelProps) {
  // Ledger adapter — reads the settlements_read_ledger flag and normalizes the
  // write API across legacy + new ledgers (flag defaults legacy → unchanged).
  const ledger = useSettlementsLedger({ party, organizationId, userId });

  // Per-party details query — only the matching party's query runs. Ref swaps
  // with the flag; args are identical (settlementId is a string at runtime).
  const driverDetails = useAuthQuery(
    ledger.useNew ? api.payEngine.settlementReads.getSettlementDetails : api.driverSettlements.getSettlementDetails,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    party === 'driver' ? { settlementId: row._id as any } : 'skip',
  );
  const carrierDetails = useAuthQuery(
    ledger.useNew ? api.payEngine.settlementReads.carrierGetSettlementDetails : api.carrierSettlements.getSettlementDetails,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    party === 'carrier' ? { settlementId: row._id as any } : 'skip',
  );
  const presets = useAuthQuery(api.manualTemplates.listAdjustmentPresets, { workosOrgId: organizationId, party });

  const [busy, setBusy] = React.useState(false);

  // Add-adjustment mini-form (expanding card at the bottom of the body).
  const [adjustOpen, setAdjustOpen] = React.useState(false);
  // When an adjustment is started from a load line, tie it to that load.
  const [pendingLoadId, setPendingLoadId] = React.useState<string | null>(null);
  const [adjDesc, setAdjDesc] = React.useState('');
  const [adjAmount, setAdjAmount] = React.useState('');
  const [adjCategory, setAdjCategory] = React.useState<PayableCategory>('EARNING');
  const bodyRef = React.useRef<HTMLDivElement>(null);

  // Jump from a readiness blocker to the line it flags: scroll it into view in
  // the (left) lines column and pulse it so the user sees exactly what to fix.
  const [highlightLineId, setHighlightLineId] = React.useState<string | null>(null);
  const highlightTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpToLine = React.useCallback((lineId: string) => {
    const el = bodyRef.current?.querySelector(`[data-line-id="${lineId}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightLineId(lineId);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightLineId(null), 2600);
  }, []);
  React.useEffect(() => () => { if (highlightTimer.current) clearTimeout(highlightTimer.current); }, []);

  React.useEffect(() => {
    if (adjustOpen) {
      bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [adjustOpen]);

  // Esc closes.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const details = party === 'driver' ? driverDetails : carrierDetails;
  const detailsLoading = details === undefined;
  const editable = row.status === 'DRAFT' || row.status === 'PENDING';

  // Blockers are live backend data — the carrier details query recomputes
  // them, so prefer it when loaded; the driver row carries them from the
  // (equally reactive) list query. Either way, resolving the underlying
  // issue elsewhere updates this panel automatically via Convex reactivity.
  const blockers: SettlementBlocker[] =
    party === 'carrier' && carrierDetails ? carrierDetails.blockers : row.blockers;
  // Acknowledged (reviewer-verified) hard blockers no longer gate approval.
  const hardRemaining = blockers.filter((b) => b.sev === 'hard' && !b.acknowledged).length;
  const allClear = hardRemaining === 0;
  const BLOCKER_META = blockersFor(party);

  const acknowledgeBlocker = async (key: string) => {
    try {
      await ledger.ackBlocker(row._id, key);
    } catch (err) {
      toast.error('Failed to verify');
      console.error(err);
    }
  };
  const undoAcknowledge = async (key: string) => {
    try {
      await ledger.unackBlocker(row._id, key);
    } catch (err) {
      console.error(err);
    }
  };

  // ── classified lines ───────────────────────────────────────────────────────
  const payables: DetailsPayable[] | null = React.useMemo(() => {
    if (party === 'driver') return driverDetails ? driverDetails.payables : null;
    return carrierDetails ? carrierDetails.payables : null;
  }, [party, driverDetails, carrierDetails]);

  const lines = React.useMemo(() => {
    if (!payables) return null;
    const earn: PanelLine[] = [];
    const reimb: PanelLine[] = [];
    const deduct: PanelLine[] = [];
    // Reviewer-added MANUAL lines live in the right-rail Adjustments section,
    // not the day-grouped earnings flow. Amount is signed (deductions stored
    // negative).
    const adjustments: Array<{ _id: string; label: string; amount: number; loadLabel?: string }> = [];
    for (const p of payables) {
      const category = classifyPayable(p);
      const loadLabel = p.loadOrderNumber ?? p.loadInternalId;
      const workAt = p.workStart ?? p.createdAt;

      if (p.sourceType === 'MANUAL') {
        adjustments.push({ _id: p._id, label: p.description, amount: p.totalAmount, loadLabel });
        continue;
      }

      // Shift lines (workEnd present) show their check-in → check-out range;
      // load lines show the pickup time. The day itself lives in the group
      // header, so shift descriptions drop their redundant "— Mon, Jun 8" tail.
      const isShift = p.workEnd != null;
      // Show the reviewer-corrected clock window when edited (clockStart/End
      // reflect the override), falling back to the session work times.
      const shiftStart = p.clockStart ?? p.workStart;
      const shiftEnd = p.clockEnd ?? p.workEnd;
      const time =
        isShift && shiftStart != null && shiftEnd != null
          ? `${fmtTime(shiftStart)} – ${fmtTime(shiftEnd)}${p.breakMinutes ? ` · ${p.breakMinutes} min break` : ''}`
          : p.workStart != null
            ? fmtTime(p.workStart)
            : undefined;
      const baseLabel = isShift ? p.description.replace(/\s+—\s+[^—]+$/, '') : (loadLabel ?? p.description);
      const baseSub = isShift ? undefined : loadLabel ? p.description : undefined;

      const line: PanelLine = {
        _id: p._id,
        label: baseLabel,
        sub: [time, baseSub].filter(Boolean).join(' · ') || undefined,
        calc: calcFor(p, row.planBasis),
        amount: category === 'DEDUCTION' ? Math.abs(p.totalAmount) : p.totalAmount,
        // MANUAL lines were split off above into the rail Adjustments section.
        removable: false,
        loadId: p.loadId,
        dayKey: startOfDay(workAt),
        at: workAt,
        hours: row.planBasis === 'hourly' && category === 'EARNING' ? p.quantity : undefined,
        loads: p.shiftLoads,
        isShift,
        sessionId: p.sessionId,
        sessionOverrideId: p.sessionPayProfileOverrideId,
        desc: p.description,
        timeLabel: time,
        warning: p.warningMessage,
        // Inline-edit state.
        edited: p.edited,
        rate: p.rate,
        basis: row.planBasis,
        breakMinutes: p.breakMinutes,
        clockStart: p.clockStart,
        clockEnd: p.clockEnd,
        originalTotalAmount: p.originalTotalAmount,
        rulesChanged: p.rulesChanged,
        rulesAmount: p.rulesAmount,
        editableLine: editable && category === 'EARNING',
        // Per-load Adjust available for load lines (mile/pct/flat, not shift).
        adjustableLoad: editable && !isShift && !!p.loadId,
      };
      if (category === 'DEDUCTION') deduct.push(line);
      else if (category === 'REIMBURSEMENT') reimb.push(line);
      else earn.push(line);
    }
    // Statements read chronologically — days ascending, lines by time within.
    earn.sort((a, b) => a.at - b.at);
    const earnTotal = earn.reduce((s, l) => s + l.amount, 0);
    const reimbTotal = reimb.reduce((s, l) => s + l.amount, 0);
    const deductTotal = deduct.reduce((s, l) => s + l.amount, 0);
    const adjTotal = adjustments.reduce((s, a) => s + a.amount, 0);
    return {
      earn, reimb, deduct, adjustments,
      earnTotal, reimbTotal, deductTotal, adjTotal,
      net: earnTotal + reimbTotal - deductTotal + adjTotal,
    };
  }, [payables, row.planBasis, editable]);

  // While the details query streams in, the header strip falls back to the
  // (already-enriched) row totals so nothing flashes empty.
  const totals = lines ?? {
    earnTotal: row.earnTotal,
    reimbTotal: row.reimbTotal,
    deductTotal: row.deductTotal,
    adjTotal: 0,
    net: row.net,
  };
  const adjustments = lines?.adjustments ?? [];

  const heldPayables = party === 'driver' && driverDetails ? driverDetails.heldPayables : [];

  // ── derived display bits ───────────────────────────────────────────────────
  const isBlocked = row.bucket === 'attention';
  const isOpen = row.bucket === 'open';
  const planMeta = row.planBasis ? PLAN_META[row.planBasis] : null;
  // Shift count = distinct sessions among earn lines — a shift can carry
  // several rate lines (base, H&W, off-load), and loads add per-leg lines,
  // so counting lines overstates wildly ("13 shifts" for one shift).
  const distinctShifts = lines
    ? new Set(lines.earn.filter((l) => l.isShift).map((l) => l.sessionId ?? l._id)).size
    : null;
  const earnCount = distinctShifts !== null && distinctShifts > 0
    ? distinctShifts
    : (lines?.earn.length ?? row.lineCount);
  const earnLabel =
    row.planBasis === 'hourly'
      ? `Earnings · ${earnCount} shift${earnCount === 1 ? '' : 's'} · ${row.units}`
      : `Earnings · ${row.loadCount} load${row.loadCount === 1 ? '' : 's'}${row.planBasis === 'mile' ? ' · ' + row.units : ''}`;
  const periodSub =
    row.status === 'PAID'
      ? `paid ${fmtShortDate(row.paidAt)}`
      : isOpen
        ? `ends ${fmtShortDate(row.periodEnd)}`
        : `pay ${fmtShortDate(row.payDate)}`;

  // ── actions ────────────────────────────────────────────────────────────────
  const setStatus = async (newStatus: 'PENDING' | 'APPROVED', successMsg: string) => {
    setBusy(true);
    try {
      await ledger.updateStatus(row._id, newStatus);
      toast.success(successMsg);
      onChanged?.();
      onClose();
    } catch (err) {
      toast.error('Couldn\'t update the settlement', { description: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const submitAdjustment = async () => {
    const parsed = parseFloat(adjAmount);
    if (!adjDesc.trim()) {
      toast.error('Enter a description for the adjustment');
      return;
    }
    if (!Number.isFinite(parsed) || parsed === 0) {
      toast.error('Enter a non-zero amount');
      return;
    }
    // Deductions are stored negative — negate a positive entry; amounts are
    // otherwise stored exactly as entered.
    const amount = adjCategory === 'DEDUCTION' && parsed > 0 ? -parsed : parsed;
    // Convex `v.optional(v.id())` accepts undefined, never null — coerce the
    // "no tied load" default so the validator doesn't reject it.
    const loadId = (pendingLoadId ?? undefined) as string | undefined;
    setBusy(true);
    try {
      await ledger.addAdjustment({
        settlementId: row._id,
        payeeId: row.payeeId,
        loadId,
        description: adjDesc.trim(),
        amount,
        category: adjCategory,
      });
      toast.success('Adjustment added');
      setAdjDesc('');
      setAdjAmount('');
      setAdjCategory('EARNING');
      setPendingLoadId(null);
      setAdjustOpen(false);
    } catch (err) {
      toast.error("Couldn't add the adjustment", { description: friendlyError(err) });
      console.error('addManualAdjustment failed', err);
    } finally {
      setBusy(false);
    }
  };

  // Presets are entry shortcuts: pre-fill the form's description + category
  // and focus the amount so the reviewer just types the dollar value.
  const adjAmountRef = React.useRef<HTMLInputElement>(null);
  const fillFromPreset = (preset: { label: string; category: PayableCategory }) => {
    setAdjDesc(preset.label);
    setAdjCategory(preset.category);
    setAdjAmount('');
    setTimeout(() => adjAmountRef.current?.focus(), 0);
  };

  // Per-load "Adjust": open the adjustment form tied to that load, with the
  // order number seeded into the description.
  const adjustForLoad = (loadId: string, label: string) => {
    setPendingLoadId(loadId);
    setAdjDesc(`Adjustment — ${label}`);
    setAdjCategory('EARNING');
    setAdjAmount('');
    setAdjustOpen(true);
    setTimeout(() => adjAmountRef.current?.focus(), 0);
  };

  // Inline line edits — clock/break for shifts, rate for any line. Override
  // in place; the reactive details query reflects the new amount + net.
  const editLine = async (
    payableId: string,
    patch: { rate?: number; quantity?: number; overrideStartAt?: number; overrideEndAt?: number; breakMinutes?: number },
  ) => {
    setBusy(true);
    try {
      await ledger.editLine(payableId, patch);
      toast.success('Line updated');
    } catch (err) {
      toast.error('Couldn\'t update the line', { description: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  };
  const revertLine = async (payableId: string) => {
    setBusy(true);
    try {
      await ledger.revertLine(payableId);
      toast.success('Restored original');
    } catch (err) {
      toast.error('Couldn\'t restore the original', { description: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  };
  const applyRules = async (payableId: string) => {
    setBusy(true);
    try {
      await ledger.applyRules(payableId);
      toast.success('Updated to the current rules amount');
    } catch (err) {
      toast.error("Couldn't apply the update", { description: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  // ── shift-level pay profile override (driver hourly shifts) ────────────────
  // Session pay selects the driver's default assignment at shift start; the
  // picker pins one shift to a specific profile instead. New-engine only —
  // legacy statements won't reflect it until settlements_read_ledger = 'new'.
  const driverProfiles = useAuthQuery(
    api.payProfiles.listForOrg,
    party === 'driver'
      ? { workosOrgId: organizationId, includeInactive: true, payeeType: 'DRIVER' as const }
      : 'skip',
  );
  const shiftProfileOptions = React.useMemo(
    () => (driverProfiles ?? [])
      .filter(p => p.isActive)
      .map(p => ({ value: p._id as string, label: p.name })),
    [driverProfiles],
  );
  const setSessionOverride = useMutation(api.payProfiles.setSessionOverride);
  const [savingShiftSession, setSavingShiftSession] = React.useState<string | null>(null);
  const changeShiftProfile = async (sessionId: string, value: string) => {
    setSavingShiftSession(sessionId);
    try {
      await setSessionOverride({
        sessionId: sessionId as Id<'driverSessions'>,
        profileId: value === 'auto' ? undefined : (value as Id<'payProfiles'>),
      });
      toast.success(
        value === 'auto'
          ? 'Shift override cleared — recalculating shift pay'
          : 'Shift pay profile set — recalculating shift pay',
      );
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update shift pay profile');
    } finally {
      setSavingShiftSession(null);
    }
  };

  const removeLine = async (payableId: string) => {
    setBusy(true);
    try {
      await ledger.removeLine(payableId);
      toast.success('Line removed from statement');
    } catch (err) {
      toast.error('Couldn\'t remove the line', { description: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  // ── footer (per lifecycle state) ───────────────────────────────────────────
  const footerNote = (icon: IconName, iconColor: string, text: React.ReactNode, textColor?: string) => (
    <div className="flex items-center gap-2" style={{ fontSize: 12.5, color: textColor ?? 'var(--text-secondary)' }}>
      <WIcon name={icon} size={15} color={iconColor} />
      {text}
    </div>
  );

  let footer: React.ReactNode;
  if (isBlocked) {
    footer = (
      <>
        {allClear
          ? footerNote('badge-check', '#10B981', 'All blockers cleared', '#0F8C5F')
          : footerNote(
              'circle-dot',
              'var(--text-tertiary)',
              `${hardRemaining} blocker${hardRemaining > 1 ? 's' : ''} remaining`,
            )}
        <div className="flex-1" />
        <WBtn variant="secondary" onClick={onClose}>
          Close
        </WBtn>
        <WBtn
          accent
          leading="check"
          disabled={!allClear || busy}
          onClick={() => setStatus('PENDING', `${row.statementNumber} marked ready to approve`)}
        >
          Mark ready to approve
        </WBtn>
      </>
    );
  } else if (isOpen) {
    footer = (
      <>
        {footerNote('circle-dot', 'var(--text-tertiary)', <>Accruing — period ends {fmtShortDate(row.periodEnd)}</>)}
        <div className="flex-1" />
        <WBtn variant="secondary" leading="plus" disabled={busy} onClick={() => setAdjustOpen((v) => !v)}>
          Add adjustment
        </WBtn>
        <WBtn accent leading="badge-check" disabled title="Available once the period closes">
          Approve
        </WBtn>
      </>
    );
  } else if (row.bucket === 'ready') {
    footer = (
      <>
        {footerNote('badge-check', '#10B981', <>Ready for approval — pays {fmtShortDate(row.payDate)}</>, '#0F8C5F')}
        <div className="flex-1" />
        <WBtn variant="secondary" leading="plus" disabled={busy} onClick={() => setAdjustOpen((v) => !v)}>
          Add adjustment
        </WBtn>
        <WBtn
          accent
          leading="badge-check"
          disabled={busy}
          onClick={() => setStatus('APPROVED', `Approved ${row.statementNumber} · ${fmtUSD(totals.net, false)}`)}
        >
          {`Approve · ${fmtUSD(totals.net, false)}`}
        </WBtn>
      </>
    );
  } else if (row.status === 'APPROVED') {
    footer = (
      <>
        {footerNote('badge-check', '#6366F1', <>Approved — scheduled for {fmtShortDate(row.payDate)}</>)}
        <div className="flex-1" />
        {onReopen && (
          <WBtn variant="secondary" leading="edit-pen" onClick={() => onReopen(row)}>
            Reopen
          </WBtn>
        )}
        <WBtn variant="secondary" leading="receipt" onClick={() => onOpenDoc(row)}>
          View statement
        </WBtn>
        <WBtn accent leading="doc-dollar" onClick={() => onRecordPayment(row)}>
          Record payment
        </WBtn>
      </>
    );
  } else if (row.status === 'PAID') {
    footer = (
      <>
        {footerNote(
          'badge-check',
          '#10B981',
          <>
            Paid {fmtShortDate(row.paidAt)}
            {row.paidMethod ? ` via ${row.paidMethod}` : ''}
          </>,
          '#0F8C5F',
        )}
        <div className="flex-1" />
        <WBtn variant="secondary" leading="receipt" onClick={() => onOpenDoc(row)}>
          View statement
        </WBtn>
      </>
    );
  } else if (row.status === 'VOID') {
    footer = (
      <>
        {footerNote('circle-dot', 'var(--text-tertiary)', <>Voided{row.voidReason ? ` — ${row.voidReason}` : ''}</>)}
        <div className="flex-1" />
        <WBtn variant="secondary" onClick={onClose}>
          Close
        </WBtn>
      </>
    );
  } else {
    // DISPUTED (or anything future) — read-only.
    footer = (
      <>
        {footerNote('warn-tri', '#F59E0B', 'Disputed — resolve with the payee before paying', '#A66800')}
        <div className="flex-1" />
        <WBtn variant="secondary" onClick={onClose}>
          Close
        </WBtn>
      </>
    );
  }

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Centered work modal — same surface pattern as the statement preview
          (SettlementDocPanel) and the create-record shell. Wider than the old
          560px slide-over so the per-load review table reads without
          truncation. */}
      <style>{`
        @keyframes stp-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes stp-pop { from { transform: scale(0.985) translateY(6px); opacity: 0; } to { transform: scale(1) translateY(0); opacity: 1; } }
      `}</style>

      {/* backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 z-50"
        style={{ background: 'rgba(15,22,36,0.42)', animation: 'stp-fade 160ms var(--ease-out)' }}
      />

      {/* modal — the flex wrapper centers the card so the pop animation can
          own the card's transform (animating transform on a
          translate(-50%,-50%)-positioned element overrides the centering
          mid-animation and the card visibly jumps). */}
      <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none" style={{ padding: 24 }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Settlement ${row.statementNumber}`}
        className="pointer-events-auto flex flex-col overflow-hidden"
        style={{
          width: 'min(920px, 94vw)',
          height: 'min(86vh, 980px)',
          background: 'var(--bg-canvas)',
          borderRadius: 14,
          boxShadow: '0 24px 64px -16px rgba(15,22,36,0.35), 0 8px 24px -8px rgba(15,22,36,0.18)',
          animation: 'stp-pop 200ms var(--ease-out)',
        }}
      >
        {/* header */}
        <div
          className="shrink-0"
          style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-hairline)', padding: '14px 20px 16px' }}
        >
          <div className="flex items-center justify-end gap-1" style={{ marginBottom: 8 }}>
            {(row.status === 'APPROVED' || row.status === 'PAID') && (
              <StIconBtn icon="export" tip="View statement" onClick={() => onOpenDoc(row)} />
            )}
            <StIconBtn icon="close" tip="Close (Esc)" onClick={onClose} />
          </div>
          <div className="flex items-start gap-3">
            <Avatar name={row.payeeName} size={36} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: -0.1 }}>
                  {row.payeeName}
                </span>
                <SettleChip chip={chipKeyForRow(row)} />
              </div>
              <div
                className="flex items-center gap-1.5 whitespace-nowrap overflow-hidden"
                style={{ fontSize: 12.5, color: 'var(--text-tertiary)', marginTop: 3 }}
              >
                <span className="num tw-mono">{row.statementNumber}</span>
                {planMeta && (
                  <>
                    <span className="opacity-50">·</span>
                    <span>
                      {planMeta.label}
                      {row.planDetail ? ` — ${row.planDetail}` : ''}
                    </span>
                  </>
                )}
                {row.cadence && (
                  <>
                    <span className="opacity-50">·</span>
                    <span>{row.cadence}</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div
            className="flex"
            style={{ gap: 28, marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-hairline)' }}
          >
            <StStat label="Period" value={fmtPeriod(row.periodStart, row.periodEnd)} sub={periodSub} />
            <StStat label="Earnings" value={fmtUSD(totals.earnTotal, false)} />
            <StStat
              label="Deductions"
              value={totals.deductTotal > 0 ? '−' + fmtUSD(totals.deductTotal, false) : '—'}
              tone={totals.deductTotal > 0 ? 'warn' : undefined}
            />
            {totals.adjTotal !== 0 && (
              <StStat
                label="Adjustments"
                value={(totals.adjTotal < 0 ? '−' : '+') + fmtUSD(Math.abs(totals.adjTotal), false)}
              />
            )}
            <StStat label="Net pay" value={fmtUSD(totals.net, false)} tone={totals.net < 0 ? 'danger' : 'ok'} />
          </div>
        </div>

        {/* body — lines on the left; blockers, totals, and held items live in
            a right rail that stays visible while the lines scroll. */}
        <div className="flex-1 flex min-h-0">
        <div ref={bodyRef} className="scroll-thin flex-1 overflow-auto min-w-0" style={{ padding: '18px 20px 24px' }}>
          {isOpen && (
            <div
              className="flex items-center gap-2.5"
              style={{
                padding: '10px 14px',
                marginBottom: 20,
                background: 'var(--bg-surface-2)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 10,
                fontSize: 12.5,
                color: 'var(--text-secondary)',
              }}
            >
              <WIcon name="calendar" size={15} color="var(--text-tertiary)" />
              <span>
                Period in progress — lines keep accruing until{' '}
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{fmtShortDate(row.periodEnd)}</span>.
              </span>
            </div>
          )}

          <StSectionLabel>{earnLabel}</StSectionLabel>
          <div style={CARD_STYLE}>
            {detailsLoading ? (
              <div style={{ padding: '14px 14px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                Loading statement lines…
              </div>
            ) : lines && lines.earn.length > 0 ? (
              // Lines grouped by the day the work happened (chronological).
              Array.from(
                lines.earn.reduce((m, l) => {
                  const list = m.get(l.dayKey) ?? [];
                  list.push(l);
                  m.set(l.dayKey, list);
                  return m;
                }, new Map<number, PanelLine[]>()),
              ).map(([dayKey, dayLines], gi) => (
                <React.Fragment key={dayKey}>
                  <StDayHeader dayKey={dayKey} dayLines={dayLines} first={gi === 0} />
                  {groupLoadLines(dayLines).map((g) =>
                    g.kind === 'line' ? (
                      <StLineRow
                        key={g.line._id}
                        line={g.line}
                        first={false}
                        mono={row.planBasis !== 'hourly'}
                        highlighted={highlightLineId === g.line._id}
                        onRemove={removeLine}
                        onEdit={editLine}
                        onRevert={revertLine}
                        onAdjustLoad={adjustForLoad}
                        onApplyRules={applyRules}
                        shiftProfile={
                          party === 'driver' && editable && g.line.isShift && g.line.sessionId
                            ? {
                                value: g.line.sessionOverrideId ?? 'auto',
                                options: shiftProfileOptions,
                                saving: savingShiftSession === g.line.sessionId,
                                onChange: (v) => changeShiftProfile(g.line.sessionId!, v),
                              }
                            : undefined
                        }
                      />
                    ) : (
                      <React.Fragment key={g.key}>
                        <StLoadHeader label={g.label} time={g.time} total={g.total} first={false} />
                        {g.lines.map((l) => (
                          <StLineRow
                            key={l._id}
                            line={{ ...l, label: l.desc ?? l.label, sub: undefined }}
                            first
                            indent
                            highlighted={highlightLineId === l._id}
                            onRemove={removeLine}
                            onEdit={editLine}
                            onRevert={revertLine}
                            onAdjustLoad={adjustForLoad}
                            onApplyRules={applyRules}
                          />
                        ))}
                      </React.Fragment>
                    ),
                  )}
                </React.Fragment>
              ))
            ) : (
              <div style={{ padding: '14px 14px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                No earning lines yet.
              </div>
            )}
            <StSubtotal label="Earnings subtotal" value={totals.earnTotal} />
          </div>

          {lines && lines.reimb.length > 0 && (
            <>
              <StSectionLabel>Reimbursements</StSectionLabel>
              <div style={CARD_STYLE}>
                {lines.reimb.map((l, i) => (
                  <StLineRow key={l._id} line={l} first={i === 0} onRemove={removeLine} />
                ))}
                <StSubtotal label="Reimbursements subtotal" value={lines.reimbTotal} />
              </div>
            </>
          )}

          {lines && lines.deduct.length > 0 && (
            <>
              <StSectionLabel>Deductions</StSectionLabel>
              <div style={CARD_STYLE}>
                {lines.deduct.map((l, i) => (
                  <StLineRow key={l._id} line={l} first={i === 0} negative onRemove={removeLine} />
                ))}
                <StSubtotal label="Deductions subtotal" value={lines.deductTotal} negative />
              </div>
            </>
          )}

        </div>

        {/* review rail */}
        <div
          className="scroll-thin shrink-0 overflow-auto"
          style={{ width: 288, borderLeft: '1px solid var(--border-hairline)', padding: '18px 16px 24px' }}
        >
          {blockers.length > 0 && editable && (
            <>
              <StSectionLabel>Settlement readiness</StSectionLabel>
              <div style={CARD_STYLE}>
                {blockers.map((b, i) => (
                  <StBlockerRow key={b.key} blocker={b} meta={BLOCKER_META[b.key]} first={i === 0} editable={editable} onJump={jumpToLine} onAcknowledge={acknowledgeBlocker} onUndo={undoAcknowledge} />
                ))}
              </div>
              {/* On an accruing statement, verifying is recorded but approval
                  still waits for the period to close — make that explicit so
                  "verify did nothing" isn't a mystery. */}
              {isOpen && allClear && (
                <div
                  className="flex items-start gap-2"
                  style={{ marginTop: -12, marginBottom: 20, padding: '9px 12px', borderRadius: 0, fontSize: 11.5, color: 'var(--text-tertiary)' }}
                >
                  <WIcon name="circle-alert" size={13} color="var(--text-tertiary)" />
                  <span>All blockers verified — approval opens when the period closes on <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{fmtShortDate(row.periodEnd)}</span>.</span>
                </div>
              )}
            </>
          )}

          <StSectionLabel>Net pay</StSectionLabel>
          <div
            className="flex flex-col"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 12,
              padding: '14px 16px',
              gap: 9,
            }}
          >
            <div className="flex justify-between">
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Earnings</span>
              <span className="num" style={{ fontSize: 12.5, fontWeight: 500 }}>
                {fmtUSD(totals.earnTotal)}
              </span>
            </div>
            {totals.reimbTotal > 0 && (
              <div className="flex justify-between">
                <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Reimbursements</span>
                <span className="num" style={{ fontSize: 12.5, fontWeight: 500 }}>
                  {fmtUSD(totals.reimbTotal)}
                </span>
              </div>
            )}
            {totals.deductTotal > 0 && (
              <div className="flex justify-between">
                <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Deductions</span>
                <span className="num" style={{ fontSize: 12.5, fontWeight: 500, color: '#B43030' }}>
                  −{fmtUSD(totals.deductTotal)}
                </span>
              </div>
            )}
            {totals.adjTotal !== 0 && (
              <div className="flex justify-between">
                <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Adjustments</span>
                <span className="num" style={{ fontSize: 12.5, fontWeight: 500, color: totals.adjTotal < 0 ? '#B43030' : 'var(--text-primary)' }}>
                  {totals.adjTotal < 0 ? '−' : '+'}{fmtUSD(Math.abs(totals.adjTotal))}
                </span>
              </div>
            )}
            <div style={{ height: 1, background: 'var(--border-hairline)', margin: '2px 0' }} />
            <div className="flex justify-between items-baseline">
              <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>Net pay</span>
              <span className="num" style={{ fontSize: 16, fontWeight: 700, color: totals.net < 0 ? '#B43030' : 'var(--text-primary)' }}>
                {fmtUSD(totals.net)}
              </span>
            </div>
          </div>

          {/* Adjustments — reviewer-added lines, separate from system pay. */}
          {(adjustments.length > 0 || editable) && (
            <div style={{ marginTop: 20 }}>
              <StSectionLabel>Adjustments</StSectionLabel>
              <div className="flex flex-col" style={{ gap: 6 }}>
                {adjustments.map((a) => (
                  <div
                    key={a._id}
                    className="flex items-center gap-2"
                    style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', borderRadius: 9, padding: '8px 8px 8px 11px' }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="truncate" style={{ fontSize: 12, color: 'var(--text-primary)' }}>{a.label}</div>
                      {a.loadLabel && (
                        <div className="num tw-mono truncate" style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 1 }}>{a.loadLabel}</div>
                      )}
                    </div>
                    <span className="num shrink-0" style={{ fontSize: 12, fontWeight: 500, color: a.amount < 0 ? '#B43030' : 'var(--text-primary)' }}>
                      {a.amount < 0 ? '−' : '+'}{fmtUSD(Math.abs(a.amount), false)}
                    </span>
                    {editable && (
                      <button
                        type="button"
                        title="Remove adjustment"
                        onClick={() => removeLine(a._id)}
                        className="focus-ring shrink-0 inline-flex items-center justify-center rounded cursor-pointer text-[var(--text-tertiary)] hover:text-[#B43030]"
                        style={{ width: 18, height: 18 }}
                      >
                        <WIcon name="close" size={12} />
                      </button>
                    )}
                  </div>
                ))}

                {editable && !adjustOpen && (
                  <button
                    type="button"
                    onClick={() => setAdjustOpen(true)}
                    className="focus-ring w-full rounded-lg flex items-center justify-center gap-1.5"
                    style={{ height: 32, border: '1px dashed var(--border-hairline-strong)', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}
                  >
                    <WIcon name="plus" size={12} />
                    Add adjustment
                  </button>
                )}

                {editable && adjustOpen && (
                  <div
                    className="flex flex-col"
                    style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', borderRadius: 10, padding: '10px 11px', gap: 8 }}
                  >
                    {presets && presets.length > 0 && (
                      <>
                        <div className="uppercase" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--text-tertiary)' }}>Quick fill</div>
                        <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', gap: 5 }}>
                          {presets.map((p) => {
                            const isDeduction = p.category === 'DEDUCTION';
                            return (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => fillFromPreset(p)}
                                className="focus-ring flex items-center gap-1.5 rounded"
                                style={{ padding: '5px 7px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-hairline)', cursor: 'pointer', textAlign: 'left' }}
                              >
                                <span className="inline-flex items-center justify-center rounded shrink-0" style={{ width: 16, height: 16, background: isDeduction ? 'rgba(239,68,68,0.08)' : 'rgba(46,92,255,0.08)', color: isDeduction ? '#B43030' : '#1A47E6' }}>
                                  <WIcon name={p.icon as IconName} size={10} />
                                </span>
                                <span className="flex-1 truncate" style={{ fontSize: 11, color: 'var(--text-primary)' }}>{p.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}
                    <input
                      type="text"
                      value={adjDesc}
                      onChange={(e) => setAdjDesc(e.target.value)}
                      placeholder="Description"
                      className="focus-ring w-full rounded-lg"
                      style={{ height: 30, padding: '0 9px', fontSize: 12, color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '1px solid var(--border-hairline-strong)' }}
                    />
                    <div className="flex items-center gap-2">
                      <input
                        ref={adjAmountRef}
                        type="number" step="0.01" value={adjAmount}
                        onChange={(e) => setAdjAmount(e.target.value)}
                        placeholder="Amount"
                        className="focus-ring num rounded-lg"
                        style={{ width: 84, height: 30, padding: '0 9px', fontSize: 12, color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '1px solid var(--border-hairline-strong)' }}
                      />
                      <select
                        value={adjCategory}
                        onChange={(e) => setAdjCategory(e.target.value as PayableCategory)}
                        className="focus-ring rounded-lg cursor-pointer flex-1 min-w-0"
                        style={{ height: 30, padding: '0 7px', fontSize: 12, color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '1px solid var(--border-hairline-strong)' }}
                      >
                        <option value="EARNING">Earning</option>
                        <option value="REIMBURSEMENT">Reimbursement</option>
                        <option value="DEDUCTION">Deduction</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <span style={{ flex: 1, fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: '14px' }}>
                        Deductions stored negative — a positive entry is negated.
                      </span>
                      <WBtn size="xs" variant="ghost" disabled={busy} onClick={() => setAdjustOpen(false)}>Cancel</WBtn>
                      <WBtn size="xs" accent leading="plus" disabled={busy} onClick={submitAdjustment}>Add</WBtn>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {heldPayables.length > 0 && (
            <>
              <StSectionLabel>Held items</StSectionLabel>
              <div style={{ ...CARD_STYLE, opacity: 0.72 }}>
                {heldPayables.map((p, i) => (
                  <div
                    key={p._id}
                    className="flex items-start gap-3"
                    style={{ padding: '10px 14px', borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)' }}
                  >
                    <div className="flex-1 min-w-0" style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                      {p.description}
                    </div>
                    <div className="num shrink-0" style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                      {fmtUSD(p.totalAmount)}
                    </div>
                  </div>
                ))}
                <div
                  style={{
                    padding: '9px 14px',
                    borderTop: '1px solid var(--border-hairline)',
                    background: 'var(--bg-surface-2)',
                    fontSize: 11.5,
                    color: 'var(--text-tertiary)',
                  }}
                >
                  Held — excluded from this statement
                </div>
              </div>
            </>
          )}

          {/* Audit trail — driver settlements write audit rows; the carrier
              ledger doesn't yet, so the panel stays clean for that party. */}
          {party === 'driver' && (
            <>
              <StSectionLabel>Audit trail</StSectionLabel>
              <div style={{ ...CARD_STYLE, padding: '10px 14px', maxHeight: 256, overflowY: 'auto' }}>
                <EntityAuditTimeline entityType="driverSettlement" entityId={String(row._id)} limit={25} />
              </div>
            </>
          )}

        </div>
        </div>

        {/* footer */}
        <div
          className="shrink-0 flex items-center gap-3"
          style={{ background: 'var(--bg-surface)', borderTop: '1px solid var(--border-hairline)', padding: '12px 20px' }}
        >
          {footer}
        </div>
      </div>
      </div>
    </>
  );
}
