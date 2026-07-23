'use client';

/**
 * Settings → Billing & usage.
 *
 * Otoqa is metered: the fleet is billed a flat rate for every load written
 * into the system, invoiced monthly. This screen answers two questions the
 * account owner asks:
 *   • How many loads have we entered — this cycle, and over time?
 *   • What have we paid, and what's coming due?
 *
 * Data shape:
 *   - Usage (loads written per cycle), the org's rate, and derived cycle
 *     amounts come from `api.platformUsage.getBillingOverview`. Counts are
 *     maintained event-driven on every load insert and drift-corrected
 *     nightly (convex/platformUsage.ts).
 *   - Invoice statuses/dates are derived placeholders until a payment
 *     processor is integrated (see getBillingOverview docstring).
 *   - Payment methods / autopay are STATIC PLACEHOLDERS (no processor yet;
 *     organizations_sensitive.stripeCustomerId is reserved for that work).
 *
 * Visual reference: Otoqa Web design — settings-billing.jsx (summary-first
 * arrangement), wrapped in the shared settings shell pattern.
 */

import * as React from 'react';
import { useMemo, useRef, useState } from 'react';
import { useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@/convex/_generated/api';
import { useOrganizationId } from '@/contexts/organization-context';

import { Chip, SettingsHeader, WBtn, WIcon, type ChipStatus } from '@/components/web';
import { exportToCSV } from '@/lib/csv-export';
import { formatCurrency, formatNumber } from '@/lib/utils/format';
import { BillingInvoiceSheet } from './_components/billing-invoice-sheet';
import type {
  BillingInvoiceBillTo,
  BillingInvoiceCycle,
} from './_components/billing-invoice-types';

type BillingOverview = NonNullable<
  FunctionReturnType<typeof api.platformUsage.getBillingOverview>
>;
type CurrentCycle = BillingOverview['currentCycle'];
type ClosedCycle = BillingOverview['closedCycles'][number];

const BILL_PANEL_W = 320;

// ─── formatters ──────────────────────────────────────────────────────────
// Thin aliases over the shared lib formatters (design-vocabulary names);
// only the whole-dollar variant has no shared equivalent.

const fmtNum = (n: number) => formatNumber(n);
const fmtMoney = (n: number) => formatCurrency(n);
const fmtMoney0 = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);

/** "2026-07" → "Jul 2026" */
const monthLabel = (periodKey: string) => {
  const [y, m] = periodKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

/** ms → "Jul 15, 2026" (UTC — cycle boundaries are UTC months) */
const dateLabel = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** ms → "Jul 1" (UTC) */
const dateLabelShort = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "INV-" + period key, mirroring the derived server placeholder. */
const invoiceNo = (periodKey: string) => `INV-${periodKey}`;

// ─── Payment placeholders — static until a payment processor lands ────────
// Flip PAYMENT_STATE to 'action-needed' to preview the dunning flow.

type PaymentState = 'healthy' | 'action-needed';
const PAYMENT_STATE: PaymentState = 'healthy';

interface PaymentMethod {
  id: string;
  kind: 'bank' | 'card';
  name: string;
  detail: string;
  holder: string;
  isDefault: boolean;
  /** Marks the method the issue-state scenario fails on (the default ACH). */
  failable?: boolean;
}

const PAYMENT_METHODS: PaymentMethod[] = [
  {
    id: 'ach',
    kind: 'bank',
    name: 'Chase •••• 6789',
    detail: 'ACH · Business checking',
    holder: 'Primary account',
    isDefault: true,
    failable: true,
  },
  {
    id: 'visa',
    kind: 'card',
    name: 'Visa •••• 4242',
    detail: 'Card · exp 08 / 27',
    holder: 'Backup card',
    isDefault: false,
  },
];

/** Placeholder failure reason for the PAYMENT_STATE === 'action-needed' scenario. */
const PAYMENT_ISSUE_REASON = 'ACH payment returned — insufficient funds (R01)';

// ═══════════════════════════════════════════════════════════════════════════
// Status pill — Paid / Due / Accruing / Verified / Past due / Failed
// ═══════════════════════════════════════════════════════════════════════════

type BillStatusKind = 'paid' | 'due' | 'accruing' | 'verified' | 'pastdue' | 'failed';

// Billing labels over the shared Chip presets so the tints stay in sync
// with the rest of the design system.
const BILL_STATUS_CHIP: Record<BillStatusKind, { status: ChipStatus; label: string }> = {
  paid: { status: 'valid', label: 'Paid' },
  due: { status: 'pending', label: 'Due' },
  accruing: { status: 'assigned', label: 'Accruing' },
  verified: { status: 'valid', label: 'Verified' },
  pastdue: { status: 'danger', label: 'Past due' },
  failed: { status: 'danger', label: 'Failed' },
};

function BillStatus({ status }: { status: BillStatusKind }) {
  const m = BILL_STATUS_CHIP[status] ?? BILL_STATUS_CHIP.paid;
  return <Chip status={m.status} label={m.label} />;
}

// ═══════════════════════════════════════════════════════════════════════════
// Card + section title — settings-page card vocabulary (taller header than
// the shared DSCard so the title + sub reads as its own chunk)
// ═══════════════════════════════════════════════════════════════════════════

function SectionTitle({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--text-primary)',
          letterSpacing: -0.005,
          lineHeight: 1.2,
        }}
      >
        {children}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 11.5,
            fontWeight: 400,
            color: 'var(--text-tertiary)',
            marginTop: 2,
            letterSpacing: 0,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function BillCard({
  title,
  action,
  children,
  padded = true,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  padded?: boolean;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      {(title || action) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderBottom: '1px solid var(--border-hairline)',
            background: 'var(--bg-surface-2)',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.02 }}>{title}</div>
          {action}
        </div>
      )}
      <div style={{ padding: padded ? '12px 14px' : 0 }}>{children}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Big stat block — used in the hero + rail cards
// ═══════════════════════════════════════════════════════════════════════════

function BillStat({
  label,
  value,
  unit,
  sub,
  accent,
  size = 'lg',
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: React.ReactNode;
  accent?: boolean;
  size?: 'lg' | 'sm';
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="tw-label" style={{ fontSize: 10.5, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span
          className="num"
          style={{
            fontSize: size === 'lg' ? 26 : 22,
            fontWeight: 600,
            lineHeight: 1,
            letterSpacing: -0.02,
            color: accent ? 'var(--accent)' : 'var(--text-primary)',
          }}
        >
          {value}
        </span>
        {unit && (
          <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)', fontWeight: 500 }}>
            {unit}
          </span>
        )}
      </div>
      {sub && (
        <div
          style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 6, lineHeight: '15px' }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Usage trend chart — bars = loads per cycle. The open cycle shows a solid
// bar (billed-so-far) plus a hatched projection to run-rate. Hover any bar
// to read its loads + amount in the header readout.
// ═══════════════════════════════════════════════════════════════════════════

interface ChartPoint {
  key: string;
  label: string;
  short: string;
  loads: number;
  amount: number;
  kind: 'closed' | 'current';
  projected?: number;
}

function BillUsageChart({
  cycles,
  current,
  projected,
  rate,
  height = 208,
}: {
  cycles: ClosedCycle[];
  current: CurrentCycle;
  projected: number;
  rate: number;
  height?: number;
}) {
  const series = useMemo<ChartPoint[]>(
    () => [
      ...cycles.map((c) => ({
        key: c.periodKey,
        label: monthLabel(c.periodKey),
        short: monthLabel(c.periodKey).slice(0, 3),
        loads: c.loadsWritten,
        amount: c.amount,
        kind: 'closed' as const,
      })),
      {
        key: 'current',
        label: monthLabel(current.periodKey),
        short: monthLabel(current.periodKey).slice(0, 3),
        loads: current.loadsWritten,
        amount: current.loadsWritten * rate,
        projected,
        kind: 'current' as const,
      },
    ],
    [cycles, current, projected, rate],
  );

  const [hover, setHover] = useState('current');
  const active = series.find((s) => s.key === hover) ?? series[series.length - 1];
  const max =
    Math.max(1, ...series.map((s) => (s.kind === 'current' ? (s.projected ?? s.loads) : s.loads))) *
    1.12;
  // Tick rounding step scales down for small fleets so gridline labels stay distinct.
  const step = max >= 200 ? 50 : max >= 40 ? 10 : 1;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round((max * t) / step) * step);

  return (
    <div>
      {/* Readout */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            {active.label}
          </span>
          {active.kind === 'current' && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              so far · billed monthly
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
            <span className="num" style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
              {fmtNum(active.loads)}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>loads</span>
          </span>
          <span className="num" style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>
            {fmtMoney(active.amount)}
          </span>
        </div>
      </div>

      {/* Plot */}
      <div style={{ display: 'flex', gap: 12 }}>
        {/* Y axis */}
        <div style={{ position: 'relative', width: 34, height, flexShrink: 0 }}>
          {ticks.map((t, i) => (
            <div
              key={i}
              className="num"
              style={{
                position: 'absolute',
                right: 0,
                bottom: `calc(${(t / max) * 100}% - 6px)`,
                fontSize: 10,
                color: 'var(--text-tertiary)',
              }}
            >
              {t >= 1000 ? (t / 1000).toFixed(1) + 'k' : t}
            </div>
          ))}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ position: 'relative', height }}>
            {/* Gridlines */}
            {ticks.map((t, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: `${(t / max) * 100}%`,
                  borderTop: '1px solid var(--border-hairline)',
                  opacity: i === 0 ? 1 : 0.55,
                }}
              />
            ))}
            {/* Bars */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'flex-end',
                gap: 8,
              }}
            >
              {series.map((s) => {
                const isCur = s.kind === 'current';
                const solidH = (s.loads / max) * 100;
                const projH = isCur ? ((s.projected ?? 0) / max) * 100 : 0;
                const on = hover === s.key;
                const barColor = isCur
                  ? 'var(--accent)'
                  : on
                    ? 'var(--accent)'
                    : 'var(--bar-intransit-bd, rgba(46,92,255,0.35))';
                return (
                  <div
                    key={s.key}
                    onMouseEnter={() => setHover(s.key)}
                    style={{
                      flex: 1,
                      height: '100%',
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'flex-end',
                      cursor: 'default',
                    }}
                  >
                    {/* Projection cap for the open cycle */}
                    {isCur && projH > solidH && (
                      <div
                        style={{
                          position: 'absolute',
                          left: '50%',
                          transform: 'translateX(-50%)',
                          bottom: `${solidH}%`,
                          width: 'min(72%, 30px)',
                          height: `${projH - solidH}%`,
                          borderRadius: '4px 4px 0 0',
                          border: '1px dashed var(--accent)',
                          borderBottom: 0,
                          background:
                            'repeating-linear-gradient(-45deg, rgba(46,92,255,0.16) 0 4px, transparent 4px 8px)',
                        }}
                      />
                    )}
                    {/* Solid bar */}
                    <div
                      style={{
                        width: 'min(72%, 30px)',
                        margin: '0 auto',
                        height: `${solidH}%`,
                        background: barColor,
                        opacity: isCur ? 1 : on ? 1 : 0.85,
                        borderRadius: '4px 4px 0 0',
                        transition:
                          'background var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out)',
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
          {/* X labels */}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {series.map((s) => (
              <div
                key={s.key}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  fontSize: 10,
                  letterSpacing: 0.01,
                  color: hover === s.key ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  fontWeight: hover === s.key ? 600 : 400,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}
              >
                {s.label.replace(' 20', " '")}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          marginTop: 14,
          fontSize: 11,
          color: 'var(--text-tertiary)',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--accent)' }} />{' '}
          Loads billed
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              border: '1px dashed var(--accent)',
              background:
                'repeating-linear-gradient(-45deg, rgba(46,92,255,0.16) 0 3px, transparent 3px 6px)',
            }}
          />{' '}
          Projected to cycle close
        </span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Billing history table
// ═══════════════════════════════════════════════════════════════════════════

interface HistoryRow {
  key: string;
  label: string;
  kind: 'current' | 'closed';
  loads: number;
  amount: number;
  status?: 'paid' | 'due';
  subLabel: string;
}

function BillHistoryTable({
  rows,
  rate,
  onPreview,
}: {
  rows: HistoryRow[];
  rate: number;
  onPreview: (periodKey: string) => void;
}) {
  const cols = [
    { key: 'period', label: 'Billing cycle', width: '1.4fr', align: 'left' as const },
    { key: 'loads', label: 'Loads entered', width: '150px', align: 'right' as const },
    { key: 'rate', label: 'Rate', width: '110px', align: 'right' as const },
    { key: 'amount', label: 'Amount', width: '140px', align: 'right' as const },
    { key: 'status', label: 'Status', width: '150px', align: 'left' as const },
    { key: 'invoice', label: 'Invoice', width: '150px', align: 'right' as const },
  ];
  const grid = cols.map((c) => c.width).join(' ');

  return (
    <div>
      {/* Head */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: grid,
          background: 'var(--bg-surface-2)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        {cols.map((c, i) => (
          <div
            key={c.key}
            style={{
              padding: `10px ${i === cols.length - 1 ? 16 : 14}px 10px ${i === 0 ? 16 : 14}px`,
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: 0.04,
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
              textAlign: c.align,
            }}
          >
            {c.label}
          </div>
        ))}
      </div>
      {/* Rows */}
      {rows.map((r, i) => {
        const current = r.kind === 'current';
        return (
          <div
            key={r.key}
            style={{
              display: 'grid',
              gridTemplateColumns: grid,
              alignItems: 'center',
              borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--border-hairline)',
              background: current ? 'var(--bg-sidebar-active)' : 'var(--bg-surface)',
              transition: 'background var(--dur-fast) var(--ease-out)',
            }}
            onMouseEnter={(e) => {
              if (!current) e.currentTarget.style.background = 'var(--bg-row-hover)';
            }}
            onMouseLeave={(e) => {
              if (!current) e.currentTarget.style.background = 'var(--bg-surface)';
            }}
          >
            {/* Period */}
            <div
              style={{
                padding: '11px 14px 11px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  flexShrink: 0,
                  background: current ? 'var(--accent)' : 'var(--bg-surface-2)',
                  border: current ? 'none' : '1px solid var(--border-hairline)',
                  color: current ? '#fff' : 'var(--text-secondary)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <WIcon name="calendar" size={14} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{r.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{r.subLabel}</div>
              </div>
            </div>
            {/* Loads */}
            <div style={{ padding: '11px 14px', textAlign: 'right' }}>
              <span className="num" style={{ fontSize: 13, fontWeight: 600 }}>
                {fmtNum(r.loads)}
              </span>
              {current && (
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 4 }}>
                  so far
                </span>
              )}
            </div>
            {/* Rate */}
            <div style={{ padding: '11px 14px', textAlign: 'right' }}>
              <span className="num" style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                {fmtMoney(rate)}
              </span>
            </div>
            {/* Amount */}
            <div style={{ padding: '11px 14px', textAlign: 'right' }}>
              <span className="num" style={{ fontSize: 13, fontWeight: 600 }}>
                {fmtMoney(r.amount)}
              </span>
            </div>
            {/* Status */}
            <div style={{ padding: '11px 14px' }}>
              <BillStatus status={current ? 'accruing' : (r.status ?? 'paid')} />
            </div>
            {/* Invoice */}
            <div style={{ padding: '11px 16px 11px 14px', textAlign: 'right' }}>
              {current ? (
                <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                  Not yet invoiced
                </span>
              ) : (
                <button
                  className="focus-ring"
                  title={`Preview & download ${invoiceNo(r.key)}`}
                  onClick={() => onPreview(r.key)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 26,
                    padding: '0 8px',
                    borderRadius: 6,
                    background: 'transparent',
                    border: '1px solid var(--border-hairline)',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 11.5,
                    fontWeight: 500,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--bg-surface-2)';
                    e.currentTarget.style.color = 'var(--accent)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--text-secondary)';
                  }}
                >
                  <WIcon name="import" size={12} />
                  <span className="num">PDF</span>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Small key→value rows for rail cards ──────────────────────────────────

function BillRailRows({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <div>
      {rows.map(([k, vLabel], i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '7px 0',
            borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)',
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{k}</span>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              color: 'var(--text-primary)',
              textAlign: 'right',
            }}
          >
            {vLabel}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Right-rail: plan card ────────────────────────────────────────────────

function BillPlanCard({ rate, nextInvoice }: { rate: number; nextInvoice: string }) {
  return (
    <BillCard
      title={<SectionTitle sub="Metered — you pay only for what you enter.">Plan</SectionTitle>}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <span className="num" style={{ fontSize: 26, fontWeight: 600, letterSpacing: -0.02 }}>
          {fmtMoney(rate)}
        </span>
        <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)', fontWeight: 500 }}>
          / load written
        </span>
      </div>
      <BillRailRows
        rows={[
          ['Model', 'Metered · per load'],
          ['Billing cycle', 'Monthly'],
          ['What counts', 'Every load created'],
          ['Next invoice', nextInvoice],
        ]}
      />
      <div
        style={{
          marginTop: 12,
          padding: '8px 10px',
          borderRadius: 7,
          background: 'var(--bg-surface-2)',
          border: '1px solid var(--border-hairline)',
          fontSize: 11,
          color: 'var(--text-tertiary)',
          lineHeight: '15px',
          display: 'flex',
          gap: 8,
        }}
      >
        <WIcon name="help" size={13} style={{ marginTop: 1, flexShrink: 0 }} />
        <span>
          Every load written into Otoqa is billable, regardless of status. Editing or cancelling a
          load later does not remove the charge for the cycle it was created in.
        </span>
      </div>
    </BillCard>
  );
}

// ─── Right-rail: payment methods (bank / ACH + card) ─────────────────────

// Shared bank/card tile + Default badge — used by the rail rows and the
// manage-page rows (same art, two sizes).
function MethodTile({ kind, size = 'sm' }: { kind: 'bank' | 'card'; size?: 'sm' | 'lg' }) {
  const d =
    size === 'lg'
      ? { w: 52, h: 34, r: 7, icon: 17, fs: 11 }
      : { w: 44, h: 30, r: 6, icon: 15, fs: 10 };
  if (kind === 'bank') {
    return (
      <div
        style={{
          width: d.w,
          height: d.h,
          borderRadius: d.r,
          flexShrink: 0,
          background: 'var(--bg-surface-2)',
          border: '1px solid var(--border-hairline)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-secondary)',
        }}
      >
        <WIcon name="building" size={d.icon} />
      </div>
    );
  }
  return (
    <div
      style={{
        width: d.w,
        height: d.h,
        borderRadius: d.r,
        flexShrink: 0,
        background: 'linear-gradient(135deg, #1A47E6, #2E5CFF)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontSize: d.fs,
        fontWeight: 700,
        letterSpacing: 0.06,
      }}
    >
      VISA
    </div>
  );
}

function DefaultBadge() {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.02,
        padding: '1px 6px',
        borderRadius: 9,
        background: 'rgba(46,92,255,0.10)',
        color: 'var(--accent)',
      }}
    >
      Default
    </span>
  );
}

function BillMethodRow({ method, failed }: { method: PaymentMethod; failed?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <MethodTile kind={method.kind} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="num" style={{ fontSize: 13, fontWeight: 600 }}>
            {method.name}
          </span>
          {method.isDefault && <DefaultBadge />}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: failed ? '#B43030' : 'var(--text-tertiary)',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          {failed && (
            <span style={{ width: 5, height: 5, borderRadius: 999, background: '#EF4444' }} />
          )}
          {failed ? 'Payment failed' : method.detail}
        </div>
      </div>
    </div>
  );
}

function BillPaymentCard({
  paymentState,
  billingEmail,
  pauseOn,
  onManage,
}: {
  paymentState: PaymentState;
  billingEmail: string;
  pauseOn: string;
  onManage: () => void;
}) {
  const issue = paymentState === 'action-needed';
  return (
    <BillCard
      title={
        <SectionTitle sub="Autopay charges the default method on the due date.">
          Payment methods
        </SectionTitle>
      }
      action={
        <WBtn size="xs" variant="ghost" onClick={onManage}>
          Manage
        </WBtn>
      }
    >
      {issue && (
        <button
          onClick={onManage}
          className="focus-ring"
          style={{
            width: '100%',
            textAlign: 'left',
            marginBottom: 12,
            padding: '9px 11px',
            borderRadius: 8,
            cursor: 'pointer',
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.30)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'inherit',
          }}
        >
          <WIcon name="alert" size={14} color="#B43030" />
          <span style={{ fontSize: 11.5, color: '#B43030', lineHeight: '15px', fontWeight: 500 }}>
            Payment failed — resolve by {pauseOn} or service pauses.
          </span>
        </button>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <BillMethodRow method={PAYMENT_METHODS[0]} failed={issue && PAYMENT_METHODS[0].failable} />
        <div style={{ borderTop: '1px solid var(--border-hairline)' }} />
        <BillMethodRow method={PAYMENT_METHODS[1]} />
      </div>
      <button
        onClick={onManage}
        className="focus-ring"
        style={{
          marginTop: 12,
          width: '100%',
          height: 30,
          borderRadius: 7,
          background: 'transparent',
          border: '1px dashed var(--border-hairline-strong)',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 500,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--bg-surface-2)';
          e.currentTarget.style.color = 'var(--accent)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--text-secondary)';
        }}
      >
        <WIcon name="plus" size={12} /> Add bank account or card
      </button>
      <div
        style={{
          marginTop: 12,
          paddingTop: 10,
          borderTop: '1px solid var(--border-hairline)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Autopay</span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: '#0F8C5F',
            fontWeight: 600,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: 999, background: '#10B981' }} /> On ·
          ACH
        </span>
      </div>
      <div
        style={{
          marginTop: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Billing email</span>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{billingEmail || '—'}</span>
      </div>
    </BillCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Payment-issue alert — the "resolve or service pauses" banner. Shown at the
// top of the overview and the manage page when a collection has failed.
// ═══════════════════════════════════════════════════════════════════════════

interface IssueDetail {
  amount: number;
  invoice: string;
  cycle: string;
  method: string;
  reason: string;
  failedOn: string;
  nextRetry: string;
  pauseOn: string;
}

function BillIssueAlert({ issue, onFix, big }: { issue: IssueDetail; onFix: () => void; big?: boolean }) {
  return (
    <div
      style={{
        background: 'rgba(239,68,68,0.06)',
        border: '1px solid rgba(239,68,68,0.30)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', gap: 14, padding: big ? '18px 20px' : '14px 16px' }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            flexShrink: 0,
            background: 'rgba(239,68,68,0.12)',
            color: '#B43030',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <WIcon name="alert" size={18} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: big ? 15 : 13.5, fontWeight: 600, color: '#B43030' }}>
              Action needed — payment failed
            </span>
            <BillStatus status="pastdue" />
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--text-secondary)',
              marginTop: 6,
              lineHeight: '18px',
              maxWidth: 620,
            }}
          >
            We couldn&apos;t collect{' '}
            <strong className="num" style={{ color: 'var(--text-primary)' }}>
              {fmtMoney(issue.amount)}
            </strong>{' '}
            for the {issue.cycle} invoice ({issue.invoice}) from {issue.method} on {issue.failedOn}.{' '}
            <span style={{ color: '#B43030' }}>{issue.reason}.</span> Update or retry your payment
            by <strong style={{ color: 'var(--text-primary)' }}>{issue.pauseOn}</strong> or Otoqa
            access — new loads, dispatch, and reports — will be paused until the balance is cleared.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <WBtn size="sm" accent leading="refresh">
              Retry payment now
            </WBtn>
            <WBtn size="sm" onClick={onFix}>
              Update payment method
            </WBtn>
            <WBtn size="sm" variant="ghost">
              View invoice
            </WBtn>
          </div>
        </div>
      </div>
      {/* Grace timeline */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          borderTop: '1px solid rgba(239,68,68,0.22)',
          background: 'rgba(239,68,68,0.04)',
          padding: '9px 20px',
          flexWrap: 'wrap',
        }}
      >
        {[
          { label: 'Invoice failed', date: issue.failedOn, done: true, danger: false },
          { label: 'Auto-retry', date: issue.nextRetry, done: false, danger: false },
          { label: 'Service pauses', date: issue.pauseOn, done: false, danger: true },
        ].map((s, i, arr) => (
          <React.Fragment key={i}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: s.danger ? '#EF4444' : s.done ? '#B43030' : 'transparent',
                  border: s.danger || s.done ? 'none' : '1.5px solid #C99',
                }}
              />
              <span
                style={{
                  fontSize: 11.5,
                  color: s.danger ? '#B43030' : 'var(--text-secondary)',
                  fontWeight: s.danger ? 600 : 500,
                }}
              >
                {s.label}
              </span>
              <span className="num" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                {s.date}
              </span>
            </div>
            {i < arr.length - 1 && (
              <div
                style={{
                  flex: 1,
                  minWidth: 24,
                  height: 1,
                  background: 'rgba(239,68,68,0.28)',
                  margin: '0 12px',
                }}
              />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Manage payment methods — full sub-view (reached from "Manage")
// ═══════════════════════════════════════════════════════════════════════════

function BillMethodManageRow({
  method,
  failed,
  failedReason,
  last,
}: {
  method: PaymentMethod;
  failed?: boolean;
  failedReason?: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '14px 16px',
        borderBottom: last ? 'none' : '1px solid var(--border-hairline)',
        background: failed ? 'rgba(239,68,68,0.04)' : 'transparent',
      }}
    >
      <MethodTile kind={method.kind} size="lg" />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="num" style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
            {method.name}
          </span>
          {method.isDefault && <DefaultBadge />}
          {failed ? <BillStatus status="failed" /> : <BillStatus status="verified" />}
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-tertiary)',
            marginTop: 2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {method.detail} · {method.holder}
        </div>
        {failed && failedReason && (
          <div style={{ fontSize: 11.5, color: '#B43030', marginTop: 4 }}>{failedReason}</div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {failed && (
          <WBtn size="sm" accent leading="refresh">
            Retry
          </WBtn>
        )}
        {!method.isDefault && !failed && <WBtn size="sm">Set default</WBtn>}
        <button
          title="Edit"
          className="focus-ring"
          style={{
            width: 30,
            height: 30,
            border: '1px solid var(--border-hairline)',
            borderRadius: 7,
            background: 'transparent',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--accent)';
            e.currentTarget.style.borderColor = 'var(--border-hairline-strong)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-tertiary)';
            e.currentTarget.style.borderColor = 'var(--border-hairline)';
          }}
        >
          <WIcon name="edit" size={14} />
        </button>
        <button
          title="Remove"
          className="focus-ring"
          style={{
            width: 30,
            height: 30,
            border: '1px solid var(--border-hairline)',
            borderRadius: 7,
            background: 'transparent',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = '#B43030';
            e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-tertiary)';
            e.currentTarget.style.borderColor = 'var(--border-hairline)';
          }}
        >
          <WIcon name="trash" size={14} />
        </button>
      </div>
    </div>
  );
}

function PaymentMethodsView({
  paymentState,
  issue,
  companyName,
  billingEmail,
  onBack,
}: {
  paymentState: PaymentState;
  issue: IssueDetail;
  companyName: string;
  billingEmail: string;
  onBack: () => void;
}) {
  const hasIssue = paymentState === 'action-needed';
  return (
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      <SettingsHeader
        breadcrumb={
          <>
            <button
              onClick={onBack}
              className="focus-ring"
              style={{
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 12,
                color: 'var(--text-tertiary)',
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <WIcon name="chevron-left" size={12} /> Billing &amp; usage
            </button>
            <WIcon name="breadcrumb-sep" size={10} />
            <span style={{ color: 'var(--text-secondary)' }}>Payment methods</span>
          </>
        }
        title="Payment methods"
        actions={
          <WBtn size="sm" accent leading="plus">
            Add method
          </WBtn>
        }
      />

      <div
        className="scroll-thin flex-1 overflow-auto"
        style={{ background: 'var(--bg-canvas)' }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `minmax(0, 1fr) ${BILL_PANEL_W}px`,
            gap: 20,
            padding: 24,
            alignItems: 'start',
          }}
        >
          {/* Main */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            {hasIssue && <BillIssueAlert issue={issue} onFix={() => {}} big />}

            <BillCard
              title={
                <SectionTitle sub="Bank accounts (ACH) and cards Otoqa can charge. Autopay uses the default.">
                  Saved methods
                </SectionTitle>
              }
              padded={false}
            >
              {PAYMENT_METHODS.map((m, i) => (
                <BillMethodManageRow
                  key={m.id}
                  method={m}
                  failed={hasIssue && m.failable}
                  failedReason={`${issue.reason} · ${issue.failedOn}`}
                  last={i === PAYMENT_METHODS.length - 1}
                />
              ))}
              <div
                style={{
                  padding: '12px 16px',
                  borderTop: '1px solid var(--border-hairline)',
                  background: 'var(--bg-surface-2)',
                  display: 'flex',
                  gap: 8,
                }}
              >
                <WBtn size="sm" leading="building">
                  Add bank account
                </WBtn>
                <WBtn size="sm" leading="receipt">
                  Add card
                </WBtn>
              </div>
            </BillCard>

            <BillCard
              title={<SectionTitle sub="How and when Otoqa collects payment.">Autopay</SectionTitle>}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>Automatic payments</div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    Charges the default method ({PAYMENT_METHODS[0].name}) on each invoice&apos;s
                    due date.
                  </div>
                </div>
                <span
                  style={{
                    width: 34,
                    height: 20,
                    borderRadius: 999,
                    background: 'var(--accent)',
                    position: 'relative',
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: 2,
                      left: 16,
                      width: 16,
                      height: 16,
                      borderRadius: 999,
                      background: '#fff',
                    }}
                  />
                </span>
              </div>
            </BillCard>
          </div>

          {/* Rail */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              position: 'sticky',
              top: 0,
            }}
          >
            <BillCard
              title={
                <SectionTitle sub="Where receipts and dunning notices go.">
                  Billing contact
                </SectionTitle>
              }
            >
              <BillRailRows
                rows={[
                  ['Company', companyName || '—'],
                  ['Billing email', billingEmail || '—'],
                ]}
              />
              <WBtn size="sm" variant="ghost" leading="edit" style={{ marginTop: 10 }}>
                Edit contact
              </WBtn>
            </BillCard>

            <BillCard
              title={
                <SectionTitle sub="What happens if a payment fails.">Failed payments</SectionTitle>
              }
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(
                  [
                    ['On the due date', 'Autopay charges your default method.'],
                    ['If it fails', 'We email you and auto-retry after 3 days.'],
                    ['7-day grace', 'Keep using Otoqa while you fix the method or retry.'],
                    [
                      'After grace',
                      'Access is paused until the past-due balance clears. Your data is kept.',
                    ],
                  ] as const
                ).map(([k, vLabel], i) => (
                  <div key={i} style={{ display: 'flex', gap: 10 }}>
                    <span
                      className="num"
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 999,
                        flexShrink: 0,
                        marginTop: 1,
                        background: 'var(--bg-surface-2)',
                        border: '1px solid var(--border-hairline)',
                        color: 'var(--text-tertiary)',
                        fontSize: 10,
                        fontWeight: 600,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {i + 1}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{k}</div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: 'var(--text-tertiary)',
                          lineHeight: '15px',
                          marginTop: 1,
                        }}
                      >
                        {vLabel}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </BillCard>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Current-cycle hero ───────────────────────────────────────────────────

function BillHero({
  current,
  rate,
  projected,
}: {
  current: CurrentCycle;
  rate: number;
  projected: number;
}) {
  const projectedAmount = projected * rate;
  const pct = Math.round((current.dayOfCycle / current.daysInCycle) * 100);
  return (
    <BillCard padded={false}>
      <div style={{ padding: '18px 20px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 18,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="tw-label" style={{ fontSize: 10.5 }}>
              Current cycle
            </span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{monthLabel(current.periodKey)}</span>
            <BillStatus status="accruing" />
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
            {dateLabelShort(current.periodStartMs)}–{dateLabel(current.periodEndMs)} · invoices{' '}
            {dateLabel(current.nextInvoiceMs)}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
          <BillStat
            label="Loads entered"
            value={fmtNum(current.loadsWritten)}
            unit="loads"
            sub={`Since ${dateLabelShort(current.periodStartMs)} · ${current.dayOfCycle} of ${current.daysInCycle} days elapsed`}
          />
          <BillStat
            label="Billed so far"
            value={fmtMoney0(current.loadsWritten * rate)}
            accent
            sub={`at ${fmtMoney(rate)} per load written`}
          />
          <BillStat
            label="Projected at close"
            value={fmtMoney0(projectedAmount)}
            sub={`≈ ${fmtNum(projected)} loads at current run-rate`}
          />
        </div>

        {/* Cycle progress */}
        <div style={{ marginTop: 20 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Cycle progress</span>
            <span className="num" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {pct}%
            </span>
          </div>
          <div
            style={{
              height: 6,
              borderRadius: 999,
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-hairline)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: '100%',
                background: 'var(--accent)',
                borderRadius: 999,
              }}
            />
          </div>
        </div>
      </div>
    </BillCard>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────

function BillingSkeleton() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `minmax(0, 1fr) ${BILL_PANEL_W}px`,
        gap: 20,
        padding: 24,
        alignItems: 'start',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        {[168, 320, 420].map((h, i) => (
          <div
            key={i}
            className="animate-pulse"
            style={{
              height: h,
              borderRadius: 10,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {[120, 240, 260].map((h, i) => (
          <div
            key={i}
            className="animate-pulse"
            style={{
              height: h,
              borderRadius: 10,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Page
// ═══════════════════════════════════════════════════════════════════════════

export default function BillingPage() {
  const organizationId = useOrganizationId();
  const [view, setView] = useState<'overview' | 'methods'>('overview');
  // Org-tagged so a preview opened in one org can never render another
  // org's colliding periodKey after a switch; resolved to an effective key
  // below (derived — no reset effects needed).
  const [invoicePreview, setInvoicePreview] = useState<{ orgId: string; key: string } | null>(
    null,
  );
  const historyRef = useRef<HTMLDivElement>(null);

  const overview = useQuery(
    api.platformUsage.getBillingOverview,
    organizationId ? { workosOrgId: organizationId } : 'skip',
  );

  const rate = overview?.rate ?? 0;
  const cycles = useMemo(() => overview?.closedCycles ?? [], [overview]);
  const current = overview?.currentCycle;

  // Run-rate projection for the open cycle.
  const projected = current
    ? Math.round((current.loadsWritten / Math.max(1, current.dayOfCycle)) * current.daysInCycle)
    : 0;

  // History rows — newest first, open cycle pinned on top.
  const historyRows = useMemo<HistoryRow[]>(() => {
    if (!current) return [];
    return [
      {
        key: current.periodKey,
        label: monthLabel(current.periodKey),
        kind: 'current' as const,
        loads: current.loadsWritten,
        amount: current.loadsWritten * rate,
        subLabel: `Open · closes ${dateLabel(current.periodEndMs)}`,
      },
      ...[...cycles].reverse().map((c) => ({
        key: c.periodKey,
        label: monthLabel(c.periodKey),
        kind: 'closed' as const,
        loads: c.loadsWritten,
        amount: c.amount,
        status: c.status,
        subLabel:
          c.status === 'due'
            ? `Issued ${dateLabel(c.issuedMs)} · due ${dateLabel(c.dueMs)}`
            : `Paid ${dateLabel(c.paidMs ?? c.issuedMs)}`,
      })),
    ];
  }, [cycles, current, rate]);

  // Year-to-date (current year's closed cycles + open cycle).
  const ytd = useMemo(() => {
    if (!current) return { loads: 0, amount: 0 };
    const year = current.periodKey.slice(0, 4);
    const loads =
      cycles.filter((c) => c.periodKey.startsWith(year)).reduce((s, c) => s + c.loadsWritten, 0) +
      current.loadsWritten;
    return { loads, amount: loads * rate };
  }, [cycles, current, rate]);

  // The server marks at most one closed cycle 'due' (the latest).
  const dueCycle = useMemo(() => cycles.find((c) => c.status === 'due'), [cycles]);
  const outstanding = dueCycle?.amount ?? 0;

  // Invoiceable cycles for the preview sheet — newest first, matching the
  // history table. Only closed cycles are invoiceable (the open cycle has
  // no invoice yet).
  const invoiceCycles = useMemo<BillingInvoiceCycle[]>(
    () =>
      [...cycles].reverse().map((c) => {
        const [y, m] = c.periodKey.split('-').map(Number);
        return {
          periodKey: c.periodKey,
          label: monthLabel(c.periodKey),
          invoiceNo: invoiceNo(c.periodKey),
          loads: c.loadsWritten,
          rate,
          amount: c.amount,
          status: c.status,
          issuedOn: dateLabel(c.issuedMs),
          dueOn: dateLabel(c.dueMs),
          // Same fallback the history table uses ("Paid <issued>" when no
          // settlement date) so the invoice never disagrees with the table.
          paidOn: dateLabel(c.paidMs ?? c.issuedMs),
          periodStart: dateLabel(Date.UTC(y, m - 1, 1)),
          periodEnd: dateLabel(Date.UTC(y, m, 0)),
        };
      }),
    [cycles, rate],
  );

  // Effective preview key: only valid while we're still on the org it was
  // opened for AND the cycle is still in the history window — otherwise the
  // sheet closes itself (org switch, month rollover sliding the window).
  const invoicePreviewKey =
    invoicePreview &&
    invoicePreview.orgId === organizationId &&
    invoiceCycles.some((c) => c.periodKey === invoicePreview.key)
      ? invoicePreview.key
      : null;
  const openInvoicePreview = (key: string) => {
    if (organizationId) setInvoicePreview({ orgId: organizationId, key });
  };

  const invoiceBillTo = useMemo<BillingInvoiceBillTo>(() => {
    const a = overview?.billingAddress;
    return {
      companyName: overview?.companyName || '—',
      billingEmail: overview?.billingEmail ?? '',
      billingPhone: overview?.billingPhone,
      addressLines: a
        ? [
            a.addressLine1,
            ...(a.addressLine2 ? [a.addressLine2] : []),
            `${a.city}, ${a.state} ${a.zip}`,
            a.country,
          ].filter(Boolean)
        : [],
    };
  }, [overview]);

  const issue: IssueDetail = useMemo(
    () => ({
      method: PAYMENT_METHODS[0].name,
      reason: PAYMENT_ISSUE_REASON,
      amount: dueCycle?.amount ?? 0,
      invoice: dueCycle ? invoiceNo(dueCycle.periodKey) : '—',
      cycle: dueCycle ? monthLabel(dueCycle.periodKey) : '—',
      failedOn: dueCycle ? dateLabel(dueCycle.dueMs) : '—',
      nextRetry: dueCycle ? dateLabel(dueCycle.dueMs + 3 * 86400000) : '—',
      pauseOn: dueCycle ? dateLabel(dueCycle.dueMs + 7 * 86400000) : '—',
    }),
    [dueCycle],
  );
  const hasIssue = PAYMENT_STATE === 'action-needed';

  // Usage CSV — built from the same rows the table renders so the export
  // can never diverge from the on-screen history.
  const exportCsv = () => {
    if (!current || historyRows.length === 0) return;
    exportToCSV(
      historyRows,
      [
        { header: 'Billing cycle', accessor: (r) => r.label },
        { header: 'Loads entered', accessor: (r) => r.loads },
        { header: 'Rate', accessor: () => rate.toFixed(2) },
        { header: 'Amount', accessor: (r) => r.amount.toFixed(2) },
        {
          header: 'Status',
          accessor: (r) =>
            r.kind === 'current' ? 'Accruing' : r.status === 'due' ? 'Due' : 'Paid',
        },
        {
          header: 'Invoice',
          accessor: (r) => (r.kind === 'current' ? 'Not yet invoiced' : invoiceNo(r.key)),
        },
      ],
      `otoqa-usage-${current.periodKey}`,
    );
  };

  if (view === 'methods') {
    return (
      <PaymentMethodsView
        paymentState={PAYMENT_STATE}
        issue={issue}
        companyName={overview?.companyName ?? ''}
        billingEmail={overview?.billingEmail ?? ''}
        onBack={() => setView('overview')}
      />
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      <SettingsHeader
        eyebrow="Account & billing"
        title="Billing & usage"
        actions={
          <>
            <WBtn size="sm" leading="export" onClick={exportCsv} disabled={!overview}>
              Export usage CSV
            </WBtn>
            <WBtn
              size="sm"
              accent
              leading="receipt"
              disabled={!overview}
              onClick={() => {
                // Open the latest closed cycle's invoice; with no closed
                // cycles yet, fall back to scrolling to the history table.
                if (invoiceCycles.length > 0) openInvoicePreview(invoiceCycles[0].periodKey);
                else historyRef.current?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              View invoices
            </WBtn>
          </>
        }
      />

      <div className="scroll-thin flex-1 overflow-auto" style={{ background: 'var(--bg-canvas)' }}>
        {!overview || !current ? (
          <BillingSkeleton />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `minmax(0, 1fr) ${BILL_PANEL_W}px`,
              gap: 20,
              padding: 24,
              alignItems: 'start',
            }}
          >
            {/* Main */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
              {hasIssue && (
                <BillIssueAlert issue={issue} onFix={() => setView('methods')} big />
              )}
              <BillHero current={current} rate={rate} projected={projected} />
              <BillCard
                title={
                  <SectionTitle sub="Loads written into the system each billing cycle. Hover any bar for detail.">
                    Usage trend
                  </SectionTitle>
                }
              >
                <BillUsageChart
                  cycles={cycles.slice(-11)}
                  current={current}
                  projected={projected}
                  rate={rate}
                />
              </BillCard>
              <div ref={historyRef}>
                <BillCard
                  title={
                    <SectionTitle sub={`${cycles.length} closed cycles · newest first`}>
                      Billing history
                    </SectionTitle>
                  }
                  padded={false}
                  action={
                    <WBtn size="sm" leading="import" onClick={exportCsv}>
                      Download all
                    </WBtn>
                  }
                >
                  <BillHistoryTable
                    rows={historyRows}
                    rate={rate}
                    onPreview={openInvoicePreview}
                  />
                </BillCard>
              </div>
            </div>

            {/* Rail */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
                position: 'sticky',
                top: 0,
              }}
            >
              <BillCard
                title={
                  <SectionTitle sub={`Loads & spend across ${current.periodKey.slice(0, 4)}.`}>
                    Year to date
                  </SectionTitle>
                }
              >
                <div style={{ display: 'flex', gap: 20 }}>
                  <BillStat label="Loads entered" value={fmtNum(ytd.loads)} size="sm" />
                  <BillStat
                    label="Paid + accrued"
                    value={fmtMoney0(ytd.amount)}
                    size="sm"
                    accent
                  />
                </div>
                {outstanding > 0 && dueCycle && (
                  <div
                    style={{
                      marginTop: 14,
                      padding: '9px 11px',
                      borderRadius: 8,
                      background: hasIssue ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.10)',
                      border: hasIssue
                        ? '1px solid rgba(239,68,68,0.30)'
                        : '1px solid rgba(245,158,11,0.28)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <WIcon name="alert" size={14} color={hasIssue ? '#B43030' : '#A66800'} />
                    <span
                      style={{
                        fontSize: 11.5,
                        color: hasIssue ? '#B43030' : '#A66800',
                        lineHeight: '15px',
                      }}
                    >
                      {hasIssue ? (
                        <>
                          <strong className="num">{fmtMoney(outstanding)}</strong> past due —
                          resolve by {issue.pauseOn}.
                        </>
                      ) : (
                        <>
                          <strong className="num">{fmtMoney(outstanding)}</strong> due{' '}
                          {dateLabelShort(dueCycle.dueMs)} for the {monthLabel(dueCycle.periodKey)}{' '}
                          cycle.
                        </>
                      )}
                    </span>
                  </div>
                )}
              </BillCard>
              <BillPlanCard rate={rate} nextInvoice={dateLabel(current.nextInvoiceMs)} />
              <BillPaymentCard
                paymentState={PAYMENT_STATE}
                billingEmail={overview.billingEmail}
                pauseOn={issue.pauseOn}
                onManage={() => setView('methods')}
              />
            </div>
          </div>
        )}
      </div>

      <BillingInvoiceSheet
        isOpen={invoicePreviewKey !== null}
        onClose={() => setInvoicePreview(null)}
        cycles={invoiceCycles}
        activeKey={invoicePreviewKey}
        onNavigate={openInvoicePreview}
        billTo={invoiceBillTo}
      />
    </div>
  );
}
