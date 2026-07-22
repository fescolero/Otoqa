'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { FunctionReturnType } from 'convex/server';
import { useAction } from 'convex/react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { WIcon, DSCard, WBtn } from '@/components/web';
import { exportToCSV } from '@/lib/csv-export';
import { cn } from '@/lib/utils';
import type { ReportViewContext } from '../reports-dashboard';
import { ReportKpiCard } from '../shell/report-kpi-card';
import { useRegisterExport } from '../shell/use-register-export';
import { AC_NEG, AC_POS, acMoney, acMoneyCents, acK } from '../shell/tokens';
import type { DrillContent } from '../shell/types';

type Direction = 'all' | 'underpaid' | 'overpaid';
type SortBy = 'invoiceNumber' | 'invoicedAmount' | 'paidAmount' | 'difference' | 'percentDiff' | 'paymentReference';

type IntelResult = FunctionReturnType<typeof api.accountingReports.getDiscrepancyIntelligence>;
type DetailResult = FunctionReturnType<typeof api.accountingReports.getDiscrepancyDetailSorted>;
type DetailRow = DetailResult['rows'][number];

const PAGE = 100;
const GRID =
  'grid-cols-[1.05fr_0.9fr_0.9fr_0.7fr_0.56fr_0.56fr_0.58fr_0.82fr_0.82fr_0.92fr_0.6fr_0.86fr_26px]';

// Backend paymentDifference: negative = underpaid. Design convention: positive =
// underpaid ("owed to us"). We flip the sign at this boundary.
const owed = (r: { difference: number }) => -r.difference;
const diffTone = (o: number) => (o > 0 ? AC_NEG : o < 0 ? AC_POS : 'var(--text-tertiary)');

export function DiscrepanciesView({ ctx }: { ctx: ReportViewContext }) {
  const router = useRouter();
  const getIntel = useAction(api.accountingReports.getDiscrepancyIntelligence);
  const getDetail = useAction(api.accountingReports.getDiscrepancyDetailSorted);

  const [intel, setIntel] = useState<IntelResult>();
  const [detail, setDetail] = useState<DetailResult>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [direction, setDirection] = useState<Direction>('underpaid');
  const [hcr, setHcr] = useState<string | null>(null);
  const [sort, setSort] = useState<{ by: SortBy; dir: 'asc' | 'desc' }>({ by: 'difference', dir: 'asc' });
  const [limit, setLimit] = useState(PAGE);

  // Single-customer scope from the FilterBar (actions accept one customerId).
  const customerId = useMemo<Id<'customers'> | undefined>(() => {
    const f = ctx.filters.find((x) => x.propId === 'customer');
    return f && f.values.length === 1 ? (f.values[0] as Id<'customers'>) : undefined;
  }, [ctx.filters]);

  const base = {
    workosOrgId: ctx.organizationId,
    dateRangeStart: ctx.range.start,
    dateRangeEnd: ctx.range.end,
    customerId,
  };
  const baseKey = `${ctx.organizationId}|${ctx.range.start}|${ctx.range.end}|${customerId ?? ''}`;

  // Summary + HCR roll-up over the full scoped set (independent of direction).
  useEffect(() => {
    let cancelled = false;
    void getIntel({ ...base, direction: 'all' }).then((r) => !cancelled && setIntel(r));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey, getIntel]);

  // Detail table — server-sorted + server-paginated.
  useEffect(() => {
    let cancelled = false;
    setDetailLoading(true);
    void getDetail({ ...base, direction, limit, sortBy: sort.by, sortDir: sort.dir })
      .then((r) => !cancelled && setDetail(r))
      .finally(() => !cancelled && setDetailLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey, direction, limit, sort.by, sort.dir, getDetail]);

  // Reset paging when the query shape changes.
  useEffect(() => setLimit(PAGE), [baseKey, direction, sort.by, sort.dir]);

  const s = intel?.summary;

  // HCR roll-up: underpaid shortfall to recover per route. Uses the per-route
  // underpaid sum (not the net) so routes with real underpayments surface even
  // when overpayments net them out — matching the "to recover" KPI.
  const hcrRows = useMemo(() => {
    if (!intel) return [];
    return intel.byHcr
      .map((h) => ({ name: h.name, under: h.underpaidSum, count: h.underpaidCount }))
      .filter((h) => h.under > 0)
      .sort((a, b) => b.under - a.under)
      .slice(0, 8);
  }, [intel]);

  const allRows = detail?.rows ?? [];
  const rows = hcr ? allRows.filter((r) => r.hcr === hcr) : allRows;
  const netInView = rows.reduce((acc, r) => acc + owed(r), 0);

  const toggleSort = (by: SortBy) =>
    setSort((p) => (p.by === by ? { by, dir: p.dir === 'desc' ? 'asc' : 'desc' } : { by, dir: by === 'invoiceNumber' || by === 'paymentReference' ? 'asc' : 'desc' }));

  const handleExport = () => {
    if (rows.length === 0) return;
    exportToCSV(
      rows,
      [
        { header: 'Invoice #', accessor: (r) => r.invoiceNumber ?? '' },
        { header: 'Customer', accessor: (r) => r.customerName },
        { header: 'HCR', accessor: (r) => r.hcr },
        { header: 'Load #', accessor: (r) => r.loadOrderNumber },
        { header: 'Eff miles', accessor: (r) => r.effectiveMiles ?? '' },
        { header: 'Paid miles', accessor: (r) => r.paymentMiles ?? '' },
        { header: 'Miles diff', accessor: (r) => r.milesDifference ?? '' },
        { header: 'Invoiced', accessor: (r) => r.invoicedAmount },
        { header: 'Paid', accessor: (r) => r.paidAmount },
        { header: 'Difference (owed to us)', accessor: (r) => owed(r) },
        { header: '% diff', accessor: (r) => r.percentDiff },
        { header: 'Payment ref', accessor: (r) => r.paymentReference ?? '' },
      ],
      'discrepancies',
    );
  };
  useRegisterExport(ctx.registerExport, handleExport);

  return (
    <div className="flex flex-col gap-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ReportKpiCard
          label="Net discrepancy"
          value={s ? acMoney(-s.netDiscrepancy) : '—'}
          delta={s ? (s.netDiscrepancy < 0 ? 'owed to us · invoiced − paid' : 'net overpaid') : ''}
          tone={s && s.netDiscrepancy < 0 ? 'down' : 'up'}
        />
        <ReportKpiCard
          label="Discrepant invoices"
          value={s ? s.totalDiscrepantInvoices.toLocaleString() : '—'}
          delta={s ? `${s.underpaidCount} under · ${s.overpaidCount} over` : ''}
          tone="flat"
        />
        <ReportKpiCard
          label="Underpaid"
          value={s ? s.underpaidCount.toLocaleString() : '—'}
          delta={s ? `${acMoney(s.underpaidSum)} to recover` : ''}
          tone="down"
          onClick={() => {
            setDirection('underpaid');
            setHcr(null);
          }}
        />
        <ReportKpiCard
          label="Largest underpayment"
          value={s ? acMoney(Math.abs(s.largestUnderpayment)) : '—'}
          delta="start here"
          tone="down"
        />
      </div>

      {/* HCR roll-up */}
      <DSCard
        title="Discrepancy by HCR"
        action={<span className="num text-[11.5px] text-[var(--text-tertiary)]">net underpaid per route · click to filter</span>}
      >
        <HcrBars rows={hcrRows} activeHcr={hcr} onPick={(h) => {
          setHcr((cur) => (cur === h ? null : h));
          setDirection('underpaid');
        }} />
      </DSCard>

      {/* Reconciliation table */}
      <DSCard
        title="Payment reconciliation"
        bodyClassName="p-0"
        action={
          <div className="flex items-center gap-2">
            <Segmented
              value={direction}
              onChange={(v) => setDirection(v as Direction)}
              options={[
                { value: 'all', label: 'All' },
                { value: 'underpaid', label: 'Underpaid' },
                { value: 'overpaid', label: 'Overpaid' },
              ]}
            />
            <WBtn variant="ghost" size="sm" leading="export" onClick={handleExport}>
              Export CSV
            </WBtn>
          </div>
        }
      >
        {hcr && (
          <div className="flex items-center gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-sidebar-active)] px-3.5 py-2">
            <WIcon name="route" size={13} className="text-[var(--accent)]" />
            <span className="text-[12px] text-[var(--text-secondary)]">
              Filtered to <strong className="text-foreground">{hcr}</strong>
            </span>
            <button
              type="button"
              onClick={() => setHcr(null)}
              className="ml-auto text-[11.5px] text-[var(--accent)]"
            >
              Clear
            </button>
          </div>
        )}

        <div className="overflow-x-auto">
          <div className="min-w-[1180px]">
            <div className={`grid ${GRID} border-b border-[var(--border-hairline)] bg-[var(--bg-surface-2)]`}>
              <SortHead id="invoiceNumber" label="Invoice #" sort={sort} onSort={toggleSort} />
              <PlainHead label="Customer" />
              <PlainHead label="HCR" />
              <PlainHead label="Load #" />
              <PlainHead label="Eff mi" align="right" />
              <PlainHead label="Paid mi" align="right" />
              <PlainHead label="Δ mi" align="right" />
              <SortHead id="invoicedAmount" label="Invoiced" align="right" sort={sort} onSort={toggleSort} />
              <SortHead id="paidAmount" label="Paid" align="right" sort={sort} onSort={toggleSort} />
              <SortHead id="difference" label="Difference" align="right" sort={sort} onSort={toggleSort} />
              <SortHead id="percentDiff" label="% diff" align="right" sort={sort} onSort={toggleSort} />
              <SortHead id="paymentReference" label="Payment ref" sort={sort} onSort={toggleSort} />
              <div />
            </div>

            {detailLoading && !detail ? (
              <div className="px-3.5 py-9 text-center text-[12.5px] text-[var(--text-tertiary)]">Loading reconciliation…</div>
            ) : rows.length === 0 ? (
              <div className="px-3.5 py-9 text-center text-[12.5px] text-[var(--text-tertiary)]">
                No discrepancy data found for the selected range.
              </div>
            ) : (
              rows.map((r) => (
                <Row
                  key={r._id}
                  r={r}
                  onOpen={() => ctx.onDrill(buildDrill(r, () => router.push(`/invoices/${r._id}/preview`)))}
                />
              ))
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-[var(--border-hairline)] px-3.5 py-3">
          <span className="num text-[12px] text-[var(--text-tertiary)]">
            Showing {rows.length.toLocaleString()}
            {detail && detail.total > allRows.length ? ` of ${detail.total.toLocaleString()}` : ''}
          </span>
          {detail?.hasMore && (
            <WBtn variant="ghost" size="sm" onClick={() => setLimit((v) => v + PAGE)} disabled={detailLoading}>
              {detailLoading ? 'Loading…' : 'Load more'}
            </WBtn>
          )}
          <div className="flex-1" />
          <span className="num text-[12px] font-semibold" style={{ color: diffTone(netInView) }}>
            {(netInView >= 0 ? '' : '−') + acMoney(Math.abs(netInView))} net in view
          </span>
        </div>
      </DSCard>
    </div>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────
function Row({ r, onOpen }: { r: DetailRow; onOpen: () => void }) {
  const o = owed(r);
  const md = r.milesDifference;
  const num = (v: React.ReactNode, extra?: string, style?: React.CSSProperties) => (
    <div className={cn('num px-3 py-2 text-right text-[12px]', extra)} style={style}>
      {v}
    </div>
  );
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`grid w-full ${GRID} items-center border-b border-[var(--border-hairline)] text-left hover:bg-[var(--bg-row-hover)]`}
    >
      <div className="num truncate px-3 py-2 text-[12px] font-semibold">{r.invoiceNumber ?? '—'}</div>
      <div className="truncate px-3 py-2 text-[12px] text-[var(--text-secondary)]">{r.customerName}</div>
      <div className="num truncate px-3 py-2 text-[12px]">{r.hcr}</div>
      <div className="num px-3 py-2 text-[12px] text-[var(--text-secondary)]">#{r.loadOrderNumber}</div>
      {num(r.effectiveMiles?.toLocaleString() ?? '—', undefined, { color: 'var(--text-secondary)' })}
      {num(r.paymentMiles?.toLocaleString() ?? '—', undefined, { color: 'var(--text-secondary)' })}
      {num(md == null ? '—' : (md > 0 ? '+' : '') + md.toLocaleString(), 'font-semibold', {
        color: md == null ? 'var(--text-tertiary)' : md < 0 ? AC_NEG : md > 0 ? AC_POS : 'var(--text-tertiary)',
      })}
      {num(acMoneyCents(r.invoicedAmount))}
      {num(acMoneyCents(r.paidAmount))}
      {num((o > 0 ? '+' : '−') + acMoneyCents(Math.abs(o)), 'font-bold', { color: diffTone(o) })}
      {num((o > 0 ? '' : '−') + Math.abs(r.percentDiff).toFixed(1) + '%', undefined, { color: diffTone(o) })}
      <div className="num truncate px-3 py-2 text-[11.5px] text-[var(--text-tertiary)]">{r.paymentReference ?? '—'}</div>
      <div className="flex justify-center text-[var(--text-tertiary)] opacity-50">
        <WIcon name="chevron-right" size={13} />
      </div>
    </button>
  );
}

// Dates are UTC-anchored (service date = firstStopDate parsed as UTC midnight,
// invoiceDateNumeric likewise), so format in UTC to avoid an off-by-one day.
const fmtDate = (v: string | number | null | undefined): string => {
  if (v == null || v === '') return '—';
  const d =
    typeof v === 'number'
      ? new Date(v)
      : new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T00:00:00Z' : v);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

// ── Drill content (mileage reconciliation) ────────────────────────────────
function buildDrill(r: DetailRow, onView: () => void): DrillContent {
  const o = owed(r);
  const under = o > 0;
  const tone = diffTone(o);
  const milesShort = r.effectiveMiles != null && r.paymentMiles != null ? r.effectiveMiles - r.paymentMiles : null;
  const line = (label: string, value: React.ReactNode, opts?: { strong?: boolean; tone?: string; first?: boolean; hl?: boolean }) => (
    <div
      className={cn('flex items-center gap-2.5 px-4 py-2.5', !opts?.first && 'border-t border-[var(--border-hairline)]')}
      style={opts?.hl ? { background: 'var(--bg-sidebar-active)' } : undefined}
    >
      <span className={cn('flex-1 text-[12px]', opts?.strong ? 'font-bold text-foreground' : 'text-[var(--text-secondary)]')}>{label}</span>
      <span className={cn('num text-[12.5px]', opts?.strong ? 'font-bold' : 'font-medium')} style={opts?.tone ? { color: opts.tone } : undefined}>
        {value}
      </span>
    </div>
  );
  return {
    icon: 'receipt',
    title: r.invoiceNumber ?? 'Invoice',
    subtitle: `${r.customerName} · ${r.hcr} · Load #${r.loadOrderNumber}`,
    metrics: [
      { label: 'Invoiced', value: acMoneyCents(r.invoicedAmount) },
      { label: 'Paid', value: acMoneyCents(r.paidAmount) },
      { label: under ? 'Underpaid' : 'Overpaid', value: (under ? '+' : '−') + acMoneyCents(Math.abs(o)), tone },
    ],
    body: (
      <div>
        <SectionLabel>Timeline</SectionLabel>
        {line('Load date', fmtDate(r.serviceDate), { first: true })}
        {line('Invoiced', fmtDate(r.invoiceDate))}
        {line('Paid', fmtDate(r.paymentDate))}
        <SectionLabel>Mileage reconciliation</SectionLabel>
        {line('Effective miles run', r.effectiveMiles?.toLocaleString() ?? '—', { first: true })}
        {line('Miles paid', r.paymentMiles?.toLocaleString() ?? '—')}
        {milesShort != null &&
          line(milesShort >= 0 ? 'Unpaid miles' : 'Excess miles paid', (milesShort >= 0 ? '−' : '+') + Math.abs(milesShort).toLocaleString() + ' mi', { tone })}
        <SectionLabel>Amounts</SectionLabel>
        {line('Invoiced', acMoneyCents(r.invoicedAmount), { first: true })}
        {line('Paid', acMoneyCents(r.paidAmount))}
        {line(under ? 'Balance owed to us' : 'Overpayment', (under ? '+' : '−') + acMoneyCents(Math.abs(o)), { strong: true, tone, hl: true })}
        <SectionLabel>Payment</SectionLabel>
        {line('Payment reference', r.paymentReference ?? '—', { first: true })}
        {line('% variance', (under ? '' : '−') + Math.abs(r.percentDiff).toFixed(1) + '%', { tone })}
      </div>
    ),
    footLabel: under ? `Underpaid · ${r.hcr}` : `Overpaid · ${r.hcr}`,
    footAction: { label: under ? 'Dispute short-pay' : 'View invoice', icon: under ? 'circle-alert' : 'receipt', onClick: onView },
  };
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="tw-label px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}

// ── HCR bars ──────────────────────────────────────────────────────────────
function HcrBars({
  rows,
  activeHcr,
  onPick,
}: {
  rows: { name: string; under: number; count: number }[];
  activeHcr: string | null;
  onPick: (name: string) => void;
}) {
  if (rows.length === 0)
    return <div className="py-2 text-[12.5px] text-[var(--text-tertiary)]">No underpaid routes in scope.</div>;
  const max = Math.max(...rows.map((r) => r.under), 1);
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r) => {
        const active = activeHcr === r.name;
        return (
          <button
            key={r.name}
            type="button"
            onClick={() => onPick(r.name)}
            className={cn(
              '-mx-2 flex items-center gap-2.5 rounded-md px-2 py-1 hover:bg-[var(--bg-row-hover)]',
              active && 'bg-[var(--bg-sidebar-active)]',
            )}
          >
            <span className="num w-[92px] truncate text-left text-[12px] font-medium">{r.name}</span>
            <div className="h-3.5 flex-1 overflow-hidden rounded bg-[var(--bg-surface-2)]">
              <div className="h-full rounded" style={{ width: `${(r.under / max) * 100}%`, background: AC_NEG, opacity: 0.8 }} />
            </div>
            <span className="num w-[84px] text-right text-[12.5px] font-semibold" style={{ color: AC_NEG }}>
              {acK(r.under)}
            </span>
            <span className="num w-9 text-right text-[11px] text-[var(--text-tertiary)]">{r.count}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── small controls ────────────────────────────────────────────────────────
function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="inline-flex gap-0.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface-2)] p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              'h-[26px] rounded-md px-2.5 text-[12px] font-medium',
              on ? 'bg-[var(--bg-surface)] text-[var(--accent)] shadow-[var(--shadow-popover)]' : 'text-[var(--text-secondary)]',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function PlainHead({ label, align }: { label: string; align?: 'right' }) {
  return (
    <div className={cn('px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]', align === 'right' ? 'text-right' : 'text-left')}>
      {label}
    </div>
  );
}

function SortHead({
  id,
  label,
  align,
  sort,
  onSort,
}: {
  id: SortBy;
  label: string;
  align?: 'right';
  sort: { by: SortBy; dir: 'asc' | 'desc' };
  onSort: (by: SortBy) => void;
}) {
  const on = sort.by === id;
  return (
    <button
      type="button"
      onClick={() => onSort(id)}
      className={cn(
        'flex items-center gap-1 px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-wide',
        align === 'right' ? 'justify-end' : 'justify-start',
        on ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]',
      )}
    >
      {label}
      <WIcon name={on && sort.dir === 'asc' ? 'sort-asc' : 'sort-desc'} size={11} className={on ? 'text-[var(--accent)]' : 'text-[var(--border-strong)]'} />
    </button>
  );
}
