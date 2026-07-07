'use client';

import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { WIcon, DSCard, WBtn } from '@/components/web';
import { exportToCSV } from '@/lib/csv-export';
import { cn } from '@/lib/utils';
import type { ReportViewContext } from '../reports-dashboard';
import { ReportKpiCard } from '../shell/report-kpi-card';
import { useRegisterExport } from '../shell/use-register-export';
import { useCustomerFilter, useCustomerContribution } from '../shell/use-customer-scope';
import { AC_NEG, AC_POS, acMoney } from '../shell/tokens';

const COST_LINES = [
  { key: 'totalDriverPay', label: 'Driver settlements', color: '#2E5CFF' },
  { key: 'totalCarrierPay', label: 'Carrier & owner-op pay', color: '#7C3AED' },
  { key: 'totalFuel', label: 'Fuel', color: '#A66800' },
  { key: 'totalDef', label: 'DEF', color: '#0D9488' },
] as const;

type StackPart = { label: string; v: number; c: string };

export function PlView({ ctx }: { ctx: ReportViewContext }) {
  const customerId = useCustomerFilter(ctx.filters);
  const scoped = !!customerId;
  const p = useAuthQuery(
    api.accountingReports.getProfitabilitySummary,
    scoped ? 'skip' : { workosOrgId: ctx.organizationId, dateRangeStart: ctx.range.start, dateRangeEnd: ctx.range.end },
  );
  const contribution = useCustomerContribution(ctx.organizationId, ctx.range, customerId);

  // Normalized statement model. Scoped → contribution (revenue − attributable
  // driver+carrier pay); unscoped → org gross profit with full direct-cost lines.
  const model = scoped
    ? contribution && {
        revenue: contribution.revenue,
        costLines: [{ label: 'Attributable pay (driver · carrier)', amount: contribution.cost }],
        totalCost: contribution.cost,
        bottom: contribution.profit,
        bottomLabel: 'Contribution',
        margin: contribution.margin,
        stack: [
          { label: 'Attributable pay', v: contribution.cost, c: '#2E5CFF' },
          { label: 'Contribution', v: Math.max(0, contribution.profit), c: AC_POS },
        ] as StackPart[],
        note: 'Fuel, DEF & overhead are fleet-level — clear the customer filter for the org-wide statement.',
      }
    : p && {
        revenue: p.totalRevenue,
        costLines: COST_LINES.map((l) => ({ label: l.label, amount: p[l.key] })),
        totalCost: p.totalCosts,
        bottom: p.grossProfit,
        bottomLabel: 'Gross profit',
        margin: p.profitMargin,
        stack: [
          ...COST_LINES.map((l) => ({ label: l.label, v: p[l.key], c: l.color })),
          { label: 'Gross profit', v: Math.max(0, p.grossProfit), c: AC_POS },
        ] as StackPart[],
        note: 'Operating expenses & net operating income arrive once an expense ledger exists — this statement ends at gross profit.',
      };

  const handleExport = () => {
    if (!model) return;
    const r = model.revenue;
    const pctNum = (n: number) => (r > 0 ? Math.round((n / r) * 1000) / 10 : 0);
    const lines = [
      { account: 'Total revenue', amount: model.revenue, pct: pctNum(model.revenue) },
      ...model.costLines.map((l) => ({ account: l.label, amount: -l.amount, pct: pctNum(l.amount) })),
      { account: 'Total costs', amount: -model.totalCost, pct: pctNum(model.totalCost) },
      { account: model.bottomLabel, amount: model.bottom, pct: model.margin },
    ];
    exportToCSV(
      lines,
      [
        { header: 'Account', accessor: (l) => l.account },
        { header: 'Amount', accessor: (l) => l.amount },
        { header: '% of revenue', accessor: (l) => l.pct },
      ],
      scoped ? 'contribution' : 'profit-loss',
    );
  };
  useRegisterExport(ctx.registerExport, handleExport);

  if (!model) return <LoadingCard />;

  const rev = model.revenue;
  const pct = (n: number) => (rev > 0 ? `${((n / rev) * 100).toFixed(1)}%` : '—');

  return (
    <div className="flex flex-col gap-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ReportKpiCard label="Total revenue" value={acMoney(rev)} delta="finalized invoices" tone="flat" />
        <ReportKpiCard
          label={scoped ? 'Attributable cost' : 'Direct costs'}
          value={acMoney(model.totalCost)}
          delta={`${pct(model.totalCost)} of revenue`}
          tone="flat"
        />
        <ReportKpiCard label={model.bottomLabel} value={acMoney(model.bottom)} delta={`${model.margin}% margin`} tone={model.bottom >= 0 ? 'up' : 'down'} />
        <ReportKpiCard label={`${model.bottomLabel} margin`} value={`${model.margin}%`} delta="revenue − costs" tone="flat" />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* Income statement */}
        <DSCard
          title={`${scoped ? 'Contribution statement' : 'Income statement'} — ${ctx.range.label}`}
          bodyClassName="p-0"
          action={
            <WBtn variant="ghost" size="sm" leading="export" onClick={handleExport}>
              Export CSV
            </WBtn>
          }
        >
          <div className="grid grid-cols-[1.8fr_1fr_0.7fr] border-b border-[var(--border-hairline)] bg-[var(--bg-surface)]">
            {['Account', 'Amount', '% rev'].map((c, i) => (
              <div
                key={c}
                className={cn('px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]', i === 0 ? 'text-left' : 'text-right')}
              >
                {c}
              </div>
            ))}
          </div>

          <SectionHead label="Revenue" />
          <StmtRow label="Total revenue" amount={rev} pct={pct(rev)} />

          <SectionHead label={scoped ? 'Attributable costs' : 'Direct costs'} />
          {model.costLines.map((l) => (
            <StmtRow key={l.label} label={l.label} amount={l.amount} pct={pct(l.amount)} sign="−" />
          ))}
          {!scoped && <StmtRow label="Total direct costs" amount={model.totalCost} pct={pct(model.totalCost)} sign="−" strong />}

          {/* Bottom line */}
          <div className="grid grid-cols-[1.8fr_1fr_0.7fr] items-center" style={{ background: 'var(--bg-sidebar-active)' }}>
            <div className="px-4 py-3 text-[13.5px] font-bold">{model.bottomLabel}</div>
            <div className="num px-4 py-3 text-right text-[16px] font-bold text-[var(--accent)]">{acMoney(model.bottom)}</div>
            <div className="num px-4 py-3 text-right text-[12px] font-semibold text-[var(--accent)]">{model.margin}%</div>
          </div>

          <div className="flex items-center gap-2 border-t border-[var(--border-hairline)] px-4 py-2.5 text-[11.5px] text-[var(--text-tertiary)]">
            <WIcon name="info" size={13} />
            {model.note}
          </div>
        </DSCard>

        {/* Cost structure */}
        <DSCard title="Cost structure">
          <CostStack parts={model.stack} />
        </DSCard>
      </div>
    </div>
  );
}

function SectionHead({ label }: { label: string }) {
  return (
    <div className="border-b border-[var(--border-hairline)] bg-[var(--bg-surface-2)] px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">
      {label}
    </div>
  );
}

function StmtRow({ label, amount, pct, sign, strong }: { label: string; amount: number; pct: string; sign?: string; strong?: boolean }) {
  return (
    <div className={cn('grid grid-cols-[1.8fr_1fr_0.7fr] items-center border-b', strong ? 'border-[var(--border-hairline-strong)] bg-[var(--bg-surface-2)]' : 'border-[var(--border-hairline)]')}>
      <div className={cn('px-4 py-2 text-[12.5px]', strong ? 'font-bold' : 'text-foreground')}>{label}</div>
      <div className={cn('num px-4 py-2 text-right text-[12.5px]', strong ? 'font-bold' : 'font-medium')}>
        {sign === '−' ? '−' : ''}
        {acMoney(amount)}
      </div>
      <div className="num px-4 py-2 text-right text-[11.5px] text-[var(--text-tertiary)]">{pct}</div>
    </div>
  );
}

function CostStack({ parts }: { parts: StackPart[] }) {
  const total = parts.reduce((s, x) => s + x.v, 0) || 1;
  return (
    <div>
      <div className="mb-3.5 flex h-4 overflow-hidden rounded bg-[var(--bg-surface-2)]">
        {parts.map((x, i) => (
          <div key={i} title={`${x.label}: ${acMoney(x.v)}`} style={{ width: `${(x.v / total) * 100}%`, background: x.c, opacity: 0.9 }} />
        ))}
      </div>
      {parts.map((x, i) => (
        <div key={i} className={cn('flex items-center gap-2.5 py-1.5', i > 0 && 'border-t border-[var(--border-hairline)]')}>
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: x.c }} />
          <span className="flex-1 text-[12.5px] text-[var(--text-secondary)]">{x.label}</span>
          <span className="num w-10 text-right text-[11px] text-[var(--text-tertiary)]">{Math.round((x.v / total) * 100)}%</span>
          <span className="num w-[80px] text-right text-[12.5px] font-semibold">{acMoney(x.v)}</span>
        </div>
      ))}
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="flex min-h-[240px] items-center justify-center rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
      <p className="text-[12.5px] text-[var(--text-tertiary)]">Loading profit &amp; loss…</p>
    </div>
  );
}
