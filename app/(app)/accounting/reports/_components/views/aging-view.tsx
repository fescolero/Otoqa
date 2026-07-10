'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { WIcon, DSCard, WBtn, Avatar } from '@/components/web';
import { exportToCSV } from '@/lib/csv-export';
import type { ReportViewContext } from '../reports-dashboard';
import { ReportKpiCard } from '../shell/report-kpi-card';
import { useRegisterExport } from '../shell/use-register-export';
import { AC_NEG, AC_WARN, AC_POS, acMoney } from '../shell/tokens';
import type { ResolvedRange } from '../shell/types';

// Aging buckets shared by the KPI row, the table, and the drills.
const BUCKETS = [
  { key: 'current', label: 'Current', long: 'Current (0–30)', color: AC_POS, test: (d: number) => d <= 30 },
  { key: 'days31to60', label: '31–60', long: '31–60 days', color: 'var(--accent)', test: (d: number) => d > 30 && d <= 60 },
  { key: 'days61to90', label: '61–90', long: '61–90 days', color: AC_WARN, test: (d: number) => d > 60 && d <= 90 },
  { key: 'days90plus', label: '90+', long: '90+ days', color: AC_NEG, test: (d: number) => d > 90 },
] as const;

type BucketKey = (typeof BUCKETS)[number]['key'];

const GRID = 'grid-cols-[1.7fr_1fr_1fr_1fr_1fr_1.1fr_28px]';

export function AgingView({ ctx }: { ctx: ReportViewContext }) {
  const customerId = useMemo<Id<'customers'> | undefined>(() => {
    const f = ctx.filters.find((x) => x.propId === 'customer');
    return f && f.values.length === 1 ? (f.values[0] as Id<'customers'>) : undefined;
  }, [ctx.filters]);
  const args = { workosOrgId: ctx.organizationId, dateRangeStart: ctx.range.start, dateRangeEnd: ctx.range.end, customerId };
  const summary = useAuthQuery(api.accountingReports.getReceivablesSummary, args);
  const rows = useAuthQuery(api.accountingReports.getAgingByCustomer, args);

  const handleExport = () => {
    if (!rows) return;
    exportToCSV(
      rows,
      [
        { header: 'Customer', accessor: (r) => r.name },
        { header: 'Current', accessor: (r) => r.current },
        { header: '31-60', accessor: (r) => r.days31to60 },
        { header: '61-90', accessor: (r) => r.days61to90 },
        { header: '90+', accessor: (r) => r.days90plus },
        { header: 'Total A/R', accessor: (r) => r.total },
        { header: 'Open invoices', accessor: (r) => r.invoiceCount },
      ],
      'ar-aging',
    );
  };
  useRegisterExport(ctx.registerExport, handleExport);

  if (!summary || !rows) return <LoadingCard />;

  const b = summary.agingBuckets;
  const totalAR = b.current + b.days31to60 + b.days61to90 + b.days90plus;
  const bucketVal: Record<BucketKey, number> = {
    current: b.current,
    days31to60: b.days31to60,
    days61to90: b.days61to90,
    days90plus: b.days90plus,
  };

  const totals = rows.reduce(
    (a, r) => ({
      current: a.current + r.current,
      days31to60: a.days31to60 + r.days31to60,
      days61to90: a.days61to90 + r.days61to90,
      days90plus: a.days90plus + r.days90plus,
      total: a.total + r.total,
    }),
    { current: 0, days31to60: 0, days61to90: 0, days90plus: 0, total: 0 },
  );

  const openBucketDrill = (bk: (typeof BUCKETS)[number]) =>
    ctx.onDrill({
      icon: 'receipt',
      title: `A/R aging — ${bk.long}`,
      subtitle: `${acMoney(bucketVal[bk.key])} outstanding`,
      body: <BucketDrill organizationId={ctx.organizationId} range={ctx.range} bucketKey={bk.key} customerId={customerId} />,
    });

  return (
    <div className="flex flex-col gap-4">
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <ReportKpiCard
          label="Total A/R"
          value={acMoney(totalAR)}
          delta={summary.avgDaysToPay != null ? `avg ${summary.avgDaysToPay}d to pay` : `${summary.outstandingCount} open`}
          tone="flat"
        />
        {BUCKETS.map((bk) => (
          <ReportKpiCard
            key={bk.key}
            label={bk.long}
            value={acMoney(bucketVal[bk.key])}
            delta={`${totalAR > 0 ? Math.round((bucketVal[bk.key] / totalAR) * 100) : 0}% of A/R`}
            tone={bk.key === 'days90plus' ? 'down' : 'flat'}
            onClick={() => openBucketDrill(bk)}
          />
        ))}
      </div>

      {/* Aging by customer */}
      <DSCard
        title="Aging by customer"
        bodyClassName="p-0"
        action={
          <WBtn variant="ghost" size="sm" leading="export" onClick={handleExport}>
            Export CSV
          </WBtn>
        }
      >
        <div className={`grid ${GRID} border-b border-[var(--border-hairline)] bg-[var(--bg-surface-2)]`}>
          {['Customer', 'Current', '31–60', '61–90', '90+', 'Total A/R'].map((c, i) => (
            <div
              key={c}
              className={`px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)] ${i === 0 ? 'text-left' : 'text-right'}`}
            >
              {c}
            </div>
          ))}
          <div />
        </div>

        {rows.length === 0 ? (
          <div className="px-3.5 py-9 text-center text-[12.5px] text-[var(--text-tertiary)]">
            No outstanding A/R for the selected range.
          </div>
        ) : (
          rows.map((r) => (
            <button
              key={r.customerId}
              type="button"
              onClick={() =>
                ctx.onDrill({
                  icon: 'briefcase',
                  title: r.name,
                  subtitle: `${r.invoiceCount} open invoice${r.invoiceCount === 1 ? '' : 's'}`,
                  metrics: [
                    { label: 'Total A/R', value: acMoney(r.total) },
                    { label: 'Current', value: acMoney(r.current) },
                    {
                      label: 'Past due',
                      value: acMoney(r.total - r.current),
                      tone: r.total - r.current > 0 ? AC_NEG : undefined,
                    },
                  ],
                  body: (
                    <CustomerDrill
                      organizationId={ctx.organizationId}
                      range={ctx.range}
                      customerId={r.customerId}
                    />
                  ),
                })
              }
              className={`grid w-full ${GRID} items-center border-b border-[var(--border-hairline)] text-left hover:bg-[var(--bg-row-hover)]`}
            >
              <div className="flex min-w-0 items-center gap-2.5 px-3.5 py-2">
                <Avatar name={r.name} size={22} />
                <span className="truncate text-[12.5px] font-medium">{r.name}</span>
              </div>
              <Cell v={r.current} />
              <Cell v={r.days31to60} />
              <Cell v={r.days61to90} tone={AC_WARN} />
              <Cell v={r.days90plus} tone={AC_NEG} />
              <div className="num px-3.5 py-2 text-right text-[13px] font-semibold">{acMoney(r.total)}</div>
              <div className="flex justify-center text-[var(--text-tertiary)] opacity-50">
                <WIcon name="chevron-right" size={13} />
              </div>
            </button>
          ))
        )}

        {rows.length > 0 && (
          <div className={`grid ${GRID} items-center bg-[var(--bg-surface-2)]`}>
            <div className="px-3.5 py-2 text-[12.5px] font-bold">Total · {rows.length} customers</div>
            <Cell v={totals.current} bold />
            <Cell v={totals.days31to60} bold />
            <Cell v={totals.days61to90} bold tone={AC_WARN} />
            <Cell v={totals.days90plus} bold tone={AC_NEG} />
            <div className="num px-3.5 py-2 text-right text-[14px] font-bold text-[var(--accent)]">
              {acMoney(totals.total)}
            </div>
            <div />
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-[var(--border-hairline)] px-3.5 py-2.5 text-[11.5px] text-[var(--text-tertiary)]">
          <WIcon name="info" size={13} />
          Buckets measured from invoice days outstanding. Past-due total{' '}
          {acMoney(totals.total - totals.current)}.
        </div>
      </DSCard>
    </div>
  );
}

function Cell({ v, tone, bold }: { v: number; tone?: string; bold?: boolean }) {
  return (
    <div
      className={`num px-3.5 py-2 text-right text-[12.5px] ${bold ? 'font-semibold' : ''}`}
      style={{ color: v === 0 ? 'var(--text-tertiary)' : tone }}
    >
      {v === 0 ? '—' : acMoney(v)}
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="flex min-h-[240px] items-center justify-center rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
      <p className="text-[12.5px] text-[var(--text-tertiary)]">Loading A/R aging…</p>
    </div>
  );
}

// ── Drill bodies (query invoice detail on demand) ─────────────────────────
function CustomerDrill({
  organizationId,
  range,
  customerId,
}: {
  organizationId: string;
  range: ResolvedRange;
  customerId: string;
}) {
  const detail = useAuthQuery(api.accountingReports.getReceivablesDetail, {
    workosOrgId: organizationId,
    dateRangeStart: range.start,
    dateRangeEnd: range.end,
    customerId: customerId as Id<'customers'>,
  });
  return <InvoiceList rows={detail} />;
}

function BucketDrill({
  organizationId,
  range,
  bucketKey,
  customerId,
}: {
  organizationId: string;
  range: ResolvedRange;
  bucketKey: BucketKey;
  customerId?: Id<'customers'>;
}) {
  const detail = useAuthQuery(api.accountingReports.getReceivablesDetail, {
    workosOrgId: organizationId,
    dateRangeStart: range.start,
    dateRangeEnd: range.end,
    customerId,
  });
  const test = BUCKETS.find((x) => x.key === bucketKey)!.test;
  const filtered = detail?.filter((r) => test(r.daysOutstanding));
  return <InvoiceList rows={filtered} showCustomer />;
}

type InvoiceRow = FunctionReturnType<typeof api.accountingReports.getReceivablesDetail>[number];

// Service-date anchor (invoiceDateNumeric) is a UTC-midnight timestamp, so
// format in UTC to avoid a Pacific-timezone off-by-one day.
const fmtInvoiceDate = (ts: number) =>
  new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function InvoiceList({ rows, showCustomer }: { rows: InvoiceRow[] | undefined; showCustomer?: boolean }) {
  if (!rows) return <div className="px-4 py-4 text-[12.5px] text-[var(--text-tertiary)]">Loading invoices…</div>;
  if (rows.length === 0)
    return <div className="px-4 py-4 text-[12.5px] text-[var(--text-tertiary)]">No open invoices.</div>;
  const sorted = [...rows].sort((a, b) => b.daysOutstanding - a.daysOutstanding);
  return (
    <div className="divide-y divide-[var(--border-hairline)]">
      {sorted.map((inv) => (
        <Link
          key={inv._id}
          href={`/invoices/${inv._id}/preview`}
          className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--bg-row-hover)]"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium group-hover:underline">{inv.invoiceNumber ?? '—'}</div>
            <div className="truncate text-[11px] text-[var(--text-tertiary)]">
              {showCustomer ? `${inv.customerName} · ` : ''}Load #{inv.loadOrderNumber} · {fmtInvoiceDate(inv.invoiceDate)}
            </div>
          </div>
          <div className="num text-[12.5px] font-semibold" style={inv.isOverdue ? { color: AC_NEG } : undefined}>
            {acMoney(inv.amount)}
          </div>
        </Link>
      ))}
    </div>
  );
}
