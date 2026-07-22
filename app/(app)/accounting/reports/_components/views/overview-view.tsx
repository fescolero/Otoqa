'use client';

import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { WIcon, DSCard, WBtn, Avatar } from '@/components/web';
import { exportToCSV } from '@/lib/csv-export';
import type { ReportViewContext } from '../reports-dashboard';
import { ReportKpiCard } from '../shell/report-kpi-card';
import { useRegisterExport } from '../shell/use-register-export';
import { useCustomerFilter, useCustomerContribution } from '../shell/use-customer-scope';
import type { ResolvedRange } from '../shell/types';
import { AC_NEG, AC_POS, AC_WARN, acMoney, acK } from '../shell/tokens';

const SNAPSHOT_BUCKETS = [
  { key: 'current', label: 'Current (0–30)', color: AC_POS },
  { key: 'days31to60', label: '31–60 days', color: 'var(--accent)' },
  { key: 'days61to90', label: '61–90 days', color: AC_WARN },
  { key: 'days90plus', label: '90+ days', color: AC_NEG },
] as const;

export function OverviewView({ ctx }: { ctx: ReportViewContext }) {
  const customerId = useCustomerFilter(ctx.filters);
  const scoped = !!customerId;
  const orgArgs = { workosOrgId: ctx.organizationId, dateRangeStart: ctx.range.start, dateRangeEnd: ctx.range.end };

  // Receivables works in both modes (customerId optional). The org-only,
  // period-stats-backed queries are skipped when a customer is scoped; the
  // invoice-driven per-customer sources take over instead.
  const recv = useAuthQuery(api.accountingReports.getReceivablesSummary, { ...orgArgs, customerId });
  const rev = useAuthQuery(api.accountingReports.getRevenueSummary, scoped ? 'skip' : orgArgs);
  const prof = useAuthQuery(api.accountingReports.getProfitabilitySummary, scoped ? 'skip' : orgArgs);
  const orgTrend = useAuthQuery(api.accountingReports.getRevenueOverTime, scoped ? 'skip' : orgArgs);
  const byCust = useAuthQuery(api.accountingReports.getRevenueByCustomer, scoped ? 'skip' : orgArgs);
  const custTrend = useAuthQuery(
    api.accountingReports.getCustomerRevenueTrend,
    scoped && customerId ? { ...orgArgs, customerId } : 'skip',
  );
  const contribution = useCustomerContribution(ctx.organizationId, ctx.range, customerId);

  const handleExport = () => {
    if (scoped) {
      if (!contribution) return;
      exportToCSV(
        [contribution],
        [
          { header: 'Customer', accessor: (r) => r.name },
          { header: 'Invoices', accessor: (r) => r.loads },
          { header: 'Revenue', accessor: (r) => r.revenue },
          { header: 'Attributable cost', accessor: (r) => r.cost },
          { header: 'Contribution', accessor: (r) => r.profit },
          { header: 'Margin %', accessor: (r) => r.margin },
        ],
        'customer-contribution',
      );
      return;
    }
    if (!byCust) return;
    exportToCSV(
      byCust,
      [
        { header: 'Customer', accessor: (r) => r.name },
        { header: 'Invoices', accessor: (r) => r.invoiceCount },
        { header: 'Revenue', accessor: (r) => r.totalRevenue },
        { header: '% of total', accessor: (r) => r.percentOfTotal },
      ],
      'revenue-by-customer',
    );
  };
  useRegisterExport(ctx.registerExport, handleExport);

  const loaded = scoped ? recv && contribution && custTrend : rev && recv && prof && orgTrend && byCust;
  if (!loaded) return <LoadingCard />;

  // Normalized model — one render path for both org and customer-scoped modes.
  const revenueBilled = scoped ? contribution!.revenue : rev!.totalRevenue;
  // Org keeps its period-stats collected (unchanged); scoped uses the
  // invoice-driven per-customer collected from receivables.
  const collected = scoped ? recv!.totalCollected : rev!.totalCollected;
  const bottomLabel = scoped ? 'Contribution' : 'Gross profit';
  const bottomValue = scoped ? contribution!.profit : prof!.grossProfit;
  const bottomMargin = scoped ? contribution!.margin : prof!.profitMargin;
  const directCosts = scoped ? contribution!.cost : prof!.totalCosts;
  const invoiceCount = scoped ? contribution!.loads : rev!.invoiceCount;
  const trendData = scoped ? custTrend! : orgTrend!;

  return (
    <div className="flex flex-col gap-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ReportKpiCard label="Revenue billed" value={acMoney(revenueBilled)} delta={`${invoiceCount} invoices`} tone="flat" />
        <ReportKpiCard
          label="A/R outstanding"
          value={acMoney(recv!.totalOutstanding)}
          delta={`${recv!.overdueCount} overdue`}
          tone={recv!.overdueCount > 0 ? 'down' : 'flat'}
          onClick={() => ctx.onView('aging')}
        />
        <ReportKpiCard label="Collected" value={acMoney(collected)} delta={`vs ${acMoney(revenueBilled)} billed`} tone="flat" />
        <ReportKpiCard
          label={scoped ? 'Contribution' : 'Gross profit'}
          value={acMoney(bottomValue)}
          delta={`${bottomMargin}% margin`}
          tone={bottomValue >= 0 ? 'up' : 'down'}
          onClick={() => ctx.onView('pl')}
        />
      </div>

      {/* Trend + attention */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.7fr_1fr]">
        <DSCard title="Revenue & collections">
          <TrendChart data={trendData} range={ctx.range} />
        </DSCard>
        <DSCard title="Needs attention">
          <Attention overdueCount={recv!.overdueCount} overdueAmount={recv!.totalOverdue} onReview={() => ctx.onView('aging')} />
        </DSCard>
      </div>

      {/* Aging snapshot + P&L / contribution */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <DSCard title="A/R aging">
          <AgingSnapshot buckets={recv!.agingBuckets} onOpen={() => ctx.onView('aging')} />
        </DSCard>
        <DSCard title={scoped ? 'Contribution — summary' : 'Profit & loss — summary'}>
          <PlSummary
            revenue={revenueBilled}
            direct={directCosts}
            bottom={bottomValue}
            margin={bottomMargin}
            bottomLabel={bottomLabel}
            directLabel={scoped ? 'Attributable cost (driver · carrier)' : 'Direct costs (driver · carrier · fuel)'}
          />
        </DSCard>
      </div>

      {/* Revenue-by-customer is redundant when scoped to one customer. */}
      {!scoped && (
        <DSCard
          title="Revenue by customer"
          action={
            <WBtn variant="ghost" size="sm" leading="export" onClick={handleExport}>
              Export CSV
            </WBtn>
          }
        >
          <CustomerBars rows={byCust!} />
        </DSCard>
      )}
    </div>
  );
}

// ── Revenue trend (grouped bars over the selected timeline) ───────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Every "YYYY-MM" from start..end inclusive (UTC, to match period keys). */
function monthKeysInRange(start: number, end: number): string[] {
  const keys: string[] = [];
  const s = new Date(start);
  const e = new Date(end);
  let y = s.getUTCFullYear();
  let m = s.getUTCMonth();
  const ey = e.getUTCFullYear();
  const em = e.getUTCMonth();
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard++ < 120) {
    keys.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return keys;
}

function TrendChart({
  data,
  range,
}: {
  data: { period: string; totalInvoiced: number; totalCollected: number }[];
  range: ResolvedRange;
}) {
  // Continuous monthly timeline across EXACTLY the selected range, zero-filling
  // months with no activity. We intentionally do NOT union in data periods
  // outside the range — a query returning an out-of-range month must not add a
  // stray bar (e.g. a July bar in a "Last month = June" view).
  const byKey = new Map(data.map((d) => [d.period, d]));
  const keys = monthKeysInRange(range.start, range.end);
  const series = keys.map((k) => ({
    period: k,
    invoiced: byKey.get(k)?.totalInvoiced ?? 0,
    collected: byKey.get(k)?.totalCollected ?? 0,
  }));

  const multiYear = keys.length > 0 && keys[0].slice(0, 4) !== keys[keys.length - 1].slice(0, 4);
  const monthLabel = (k: string) => {
    const [y, m] = k.split('-');
    return MONTHS[parseInt(m, 10) - 1] + (multiYear ? ` ’${y.slice(2)}` : '');
  };

  if (!series.some((s) => s.invoiced > 0 || s.collected > 0)) {
    return (
      <div className="flex h-[172px] flex-col items-center justify-center gap-1 text-center">
        <p className="text-[12.5px] font-medium text-[var(--text-secondary)]">No revenue in this range</p>
        <p className="text-[11.5px] text-[var(--text-tertiary)]">
          {range.label} · {range.sub}
        </p>
      </div>
    );
  }

  const W = 640;
  const H = 172;
  const padT = 8;
  const chartH = H - padT - 2;
  const max = Math.max(...series.map((s) => Math.max(s.invoiced, s.collected)), 1) * 1.1;
  const n = series.length;
  const slot = W / n;
  const pairW = Math.min(slot * 0.62, 46);
  const barW = Math.max(3, pairW / 2 - 1);
  const showEvery = n <= 8 ? 1 : Math.ceil(n / 8);

  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[172px]">
        {[0, 0.25, 0.5, 0.75, 1].map((g) => {
          const y = padT + chartH * g;
          return <line key={g} x1={0} y1={y} x2={W} y2={y} stroke="var(--border-hairline)" strokeWidth="1" vectorEffect="non-scaling-stroke" />;
        })}
        {series.map((s, i) => {
          const cx = slot * i + slot / 2;
          const hi = (s.invoiced / max) * chartH;
          const hc = (s.collected / max) * chartH;
          return (
            <g key={i}>
              <rect x={cx - barW - 1} y={padT + chartH - hi} width={barW} height={hi} rx="1.5" fill="var(--accent)">
                <title>{`${monthLabel(s.period)} · Invoiced ${acMoney(s.invoiced)}`}</title>
              </rect>
              <rect x={cx + 1} y={padT + chartH - hc} width={barW} height={hc} rx="1.5" fill={AC_POS} opacity="0.85">
                <title>{`${monthLabel(s.period)} · Collected ${acMoney(s.collected)}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="mt-1.5 flex">
        {series.map((s, i) => (
          <div key={i} className="num flex-1 truncate text-center text-[9.5px] text-[var(--text-tertiary)]">
            {i % showEvery === 0 ? monthLabel(s.period) : ''}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3 text-[11px] text-[var(--text-tertiary)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-[var(--accent)]" /> Invoiced
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm" style={{ background: AC_POS, opacity: 0.85 }} /> Collected
        </span>
      </div>
    </div>
  );
}

// ── Attention band ────────────────────────────────────────────────────────
function Attention({
  overdueCount,
  overdueAmount,
  onReview,
}: {
  overdueCount: number;
  overdueAmount: number;
  onReview: () => void;
}) {
  if (overdueCount === 0)
    return (
      <div className="flex items-center gap-2.5 py-2 text-[12.5px] text-[var(--text-tertiary)]">
        <WIcon name="check-circle" size={15} style={{ color: AC_POS }} /> Nothing needs attention in this range.
      </div>
    );
  return (
    <button
      type="button"
      onClick={onReview}
      className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-[var(--bg-row-hover)]"
    >
      <span
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px]"
        style={{ background: 'rgba(195,60,60,0.10)', color: AC_NEG }}
      >
        <WIcon name="circle-alert" size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium">Overdue invoices</div>
        <div className="text-[11px] text-[var(--text-tertiary)]">{acMoney(overdueAmount)} past due — collect</div>
      </div>
      <span className="num text-[15px] font-semibold" style={{ color: AC_NEG }}>
        {overdueCount}
      </span>
      <WIcon name="chevron-right" size={13} className="text-[var(--text-tertiary)]" />
    </button>
  );
}

// ── A/R aging snapshot ────────────────────────────────────────────────────
function AgingSnapshot({
  buckets,
  onOpen,
}: {
  buckets: { current: number; days31to60: number; days61to90: number; days90plus: number };
  onOpen: () => void;
}) {
  const total = buckets.current + buckets.days31to60 + buckets.days61to90 + buckets.days90plus || 1;
  return (
    <div>
      <div className="mb-3.5 flex h-3 overflow-hidden rounded-md bg-[var(--bg-surface-2)]">
        {SNAPSHOT_BUCKETS.map((b) => (
          <div key={b.key} style={{ width: `${(buckets[b.key] / total) * 100}%`, background: b.color, opacity: 0.9 }} />
        ))}
      </div>
      {SNAPSHOT_BUCKETS.map((b, i) => (
        <button
          key={b.key}
          type="button"
          onClick={onOpen}
          className={`-mx-2 flex w-[calc(100%+1rem)] items-center gap-2.5 px-2 py-1.5 hover:bg-[var(--bg-row-hover)] ${i > 0 ? 'border-t border-[var(--border-hairline)]' : ''}`}
        >
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: b.color }} />
          <span className="flex-1 text-left text-[12.5px] text-[var(--text-secondary)]">{b.label}</span>
          <span className="num w-10 text-right text-[11px] text-[var(--text-tertiary)]">
            {Math.round((buckets[b.key] / total) * 100)}%
          </span>
          <span
            className="num w-[78px] text-right text-[12.5px] font-semibold"
            style={{ color: b.key === 'days90plus' ? AC_NEG : 'var(--text-primary)' }}
          >
            {acMoney(buckets[b.key])}
          </span>
        </button>
      ))}
      <div className="mt-0.5 flex items-center gap-2.5 border-t border-[var(--border-hairline-strong)] py-2.5">
        <span className="flex-1 text-[12.5px] font-bold">Total A/R</span>
        <span className="num text-[14px] font-bold text-[var(--accent)]">{acMoney(total === 1 ? 0 : total)}</span>
      </div>
    </div>
  );
}

// ── P&L / contribution summary ────────────────────────────────────────────
function PlSummary({
  revenue,
  direct,
  bottom,
  margin,
  bottomLabel,
  directLabel,
}: {
  revenue: number;
  direct: number;
  bottom: number;
  margin: number;
  bottomLabel: string;
  directLabel: string;
}) {
  const line = (label: string, value: string, opts?: { strong?: boolean; tone?: string; first?: boolean }) => (
    <div className={`flex items-center gap-2.5 py-2 ${opts?.first ? '' : 'border-t border-[var(--border-hairline)]'}`}>
      <span className={`flex-1 text-[12.5px] ${opts?.strong ? 'font-bold text-foreground' : 'text-[var(--text-secondary)]'}`}>
        {label}
      </span>
      <span className={`num text-[12.5px] ${opts?.strong ? 'font-bold' : 'font-medium'}`} style={opts?.tone ? { color: opts.tone } : undefined}>
        {value}
      </span>
    </div>
  );
  return (
    <div>
      {line('Total revenue', acMoney(revenue), { first: true })}
      {line(directLabel, '−' + acMoney(direct))}
      {line(bottomLabel, acMoney(bottom), { strong: true, tone: bottom >= 0 ? AC_POS : AC_NEG })}
      <div className="mt-2 flex items-center gap-2.5 rounded-lg bg-[var(--bg-sidebar-active)] px-3 py-2.5">
        <span className="flex-1 text-[12.5px] font-semibold">{bottomLabel} margin</span>
        <span className="num text-[18px] font-bold text-[var(--accent)]">{margin}%</span>
      </div>
    </div>
  );
}

// ── Revenue by customer bars ──────────────────────────────────────────────
const BAR_COLORS = ['#2E5CFF', '#0F8C5F', '#A66800', '#7C3AED', '#0D9488', '#C33C3C', '#5A6172'];
function CustomerBars({ rows }: { rows: { customerId: string; name: string; totalRevenue: number; percentOfTotal: number }[] }) {
  const top = rows.slice(0, 8);
  if (top.length === 0)
    return <div className="py-2 text-[12.5px] text-[var(--text-tertiary)]">No customer revenue in scope.</div>;
  const max = Math.max(...top.map((c) => c.totalRevenue), 1);
  return (
    <div className="flex flex-col gap-3">
      {top.map((c, i) => (
        <div key={c.customerId} className="flex items-center gap-2.5">
          <div className="flex w-[150px] min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: BAR_COLORS[i % BAR_COLORS.length] }} />
            <span className="truncate text-[12px] font-medium">{c.name}</span>
          </div>
          <div className="h-4 flex-1 overflow-hidden rounded bg-[var(--bg-surface-2)]">
            <div
              className="h-full rounded"
              style={{ width: `${(c.totalRevenue / max) * 100}%`, background: BAR_COLORS[i % BAR_COLORS.length], opacity: 0.85 }}
            />
          </div>
          <div className="flex w-[112px] items-baseline justify-end gap-1.5">
            <span className="num text-[12.5px] font-semibold">{acK(c.totalRevenue)}</span>
            <span className="num text-[11px] text-[var(--text-tertiary)]">{Math.round(c.percentOfTotal)}%</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="flex min-h-[240px] items-center justify-center rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
      <p className="text-[12.5px] text-[var(--text-tertiary)]">Loading overview…</p>
    </div>
  );
}
