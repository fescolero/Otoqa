'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FunctionReturnType } from 'convex/server';
import { useAction } from 'convex/react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { WIcon, DSCard, WBtn, Avatar } from '@/components/web';
import { exportToCSV } from '@/lib/csv-export';
import { cn } from '@/lib/utils';
import type { ReportViewContext } from '../reports-dashboard';
import { ReportKpiCard } from '../shell/report-kpi-card';
import { useRegisterExport } from '../shell/use-register-export';
import { AC_NEG, AC_POS, AC_WARN, acMoney, acK } from '../shell/tokens';
import type { ResolvedRange } from '../shell/types';

type Breakdown = FunctionReturnType<typeof api.accountingReports.getProfitabilityBreakdown>;
type ProfitRow = Breakdown['byCustomer'][number];
type By = 'customer' | 'lane';

const GRID = 'grid-cols-[1.7fr_0.7fr_1fr_1fr_1fr_0.9fr_0.9fr_28px]';

export function ProfitabilityView({ ctx }: { ctx: ReportViewContext }) {
  const run = useAction(api.accountingReports.getProfitabilityBreakdown);
  const [data, setData] = useState<Breakdown>();
  const [loading, setLoading] = useState(false);
  const [by, setBy] = useState<By>('customer');

  const customerId = useMemo<Id<'customers'> | undefined>(() => {
    const f = ctx.filters.find((x) => x.propId === 'customer');
    return f && f.values.length === 1 ? (f.values[0] as Id<'customers'>) : undefined;
  }, [ctx.filters]);

  const baseKey = `${ctx.organizationId}|${ctx.range.start}|${ctx.range.end}|${customerId ?? ''}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void run({
      workosOrgId: ctx.organizationId,
      dateRangeStart: ctx.range.start,
      dateRangeEnd: ctx.range.end,
      customerId,
    })
      .then((r) => !cancelled && setData(r))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey, run]);

  const handleExport = () => {
    if (!data) return;
    const rowsForExport = by === 'lane' ? data.byLane : data.byCustomer;
    exportToCSV(
      rowsForExport,
      [
        { header: by === 'lane' ? 'Lane' : 'Customer', accessor: (r) => r.name },
        { header: 'Loads', accessor: (r) => r.loads },
        { header: 'Revenue', accessor: (r) => r.revenue },
        { header: 'Cost', accessor: (r) => r.cost },
        { header: 'Profit', accessor: (r) => r.profit },
        { header: 'Margin %', accessor: (r) => r.margin },
      ],
      `profitability-by-${by}`,
    );
  };
  useRegisterExport(ctx.registerExport, handleExport);

  if (loading && !data) return <LoadingCard />;
  if (!data) return <LoadingCard />;

  const fleet = data.fleet;
  const rows = by === 'lane' ? data.byLane : data.byCustomer;
  const revPerLoad = fleet.loads > 0 ? fleet.revenue / fleet.loads : 0;

  return (
    <div className="flex flex-col gap-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ReportKpiCard label="Revenue in scope" value={acMoney(fleet.revenue)} delta={`${fleet.loads.toLocaleString()} loads`} tone="flat" />
        <ReportKpiCard label="Total profit" value={acMoney(fleet.profit)} delta={`${fleet.margin}% contribution`} tone={fleet.profit >= 0 ? 'up' : 'down'} />
        <ReportKpiCard label="Revenue / load" value={acMoney(revPerLoad)} delta="avg all-in rate" tone="flat" />
        <ReportKpiCard label="Fleet margin" value={`${fleet.margin}%`} delta="contribution benchmark" tone="flat" />
      </div>

      <DSCard
        title={`Profitability by ${by === 'lane' ? 'lane' : 'customer'}`}
        bodyClassName="p-0"
        action={
          <div className="flex items-center gap-2">
            <Segmented
              value={by}
              onChange={(v) => setBy(v as By)}
              options={[
                { value: 'customer', label: 'By customer' },
                { value: 'lane', label: 'By lane' },
              ]}
            />
            <WBtn variant="ghost" size="sm" leading="export" onClick={handleExport}>
              Export CSV
            </WBtn>
          </div>
        }
      >
        <div className={`grid ${GRID} border-b border-[var(--border-hairline)] bg-[var(--bg-surface-2)]`}>
          {[by === 'lane' ? 'Lane' : 'Customer', 'Loads', 'Revenue', 'Cost', 'Profit', 'Margin', 'vs fleet'].map((c, i) => (
            <div
              key={c}
              className={cn('px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]', i === 0 ? 'text-left' : 'text-right')}
            >
              {c}
            </div>
          ))}
          <div />
        </div>

        {rows.length === 0 ? (
          <div className="px-3.5 py-9 text-center text-[12.5px] text-[var(--text-tertiary)]">
            No completed-load profitability in the selected range.
          </div>
        ) : (
          rows.map((r) => {
            const delta = r.margin - fleet.margin;
            const good = delta >= 0;
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => ctx.onDrill(buildDrill(r, by, fleet.margin, ctx))}
                className={`grid w-full ${GRID} items-center border-b border-[var(--border-hairline)] text-left hover:bg-[var(--bg-row-hover)]`}
              >
                <div className="flex min-w-0 items-center gap-2.5 px-3.5 py-2">
                  {by === 'lane' ? (
                    <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] bg-[rgba(46,92,255,0.10)] text-[var(--accent)]">
                      <WIcon name="route" size={13} />
                    </span>
                  ) : (
                    <Avatar name={r.name} size={22} />
                  )}
                  <span className="truncate text-[12.5px] font-medium">{r.name}</span>
                </div>
                <div className="num px-3.5 py-2 text-right text-[12.5px] text-[var(--text-secondary)]">{r.loads.toLocaleString()}</div>
                <div className="num px-3.5 py-2 text-right text-[12.5px]">{acMoney(r.revenue)}</div>
                <div className="num px-3.5 py-2 text-right text-[12.5px] text-[var(--text-secondary)]">{acMoney(r.cost)}</div>
                <div className="num px-3.5 py-2 text-right text-[13px] font-semibold" style={{ color: r.profit < 0 ? AC_NEG : 'var(--text-primary)' }}>
                  {acMoney(r.profit)}
                </div>
                <div className="num px-3.5 py-2 text-right text-[12.5px] font-semibold" style={{ color: r.margin < 8 ? AC_WARN : 'var(--text-primary)' }}>
                  {r.margin}%
                </div>
                <div className="px-3.5 py-2 text-right">
                  <span
                    className="num rounded-full px-2 py-0.5 text-[11.5px] font-semibold"
                    style={{ color: good ? AC_POS : AC_NEG, background: good ? 'rgba(15,140,95,0.10)' : 'rgba(195,60,60,0.10)' }}
                  >
                    {(good ? '+' : '−') + Math.abs(delta).toFixed(1)}pp
                  </span>
                </div>
                <div className="flex justify-center text-[var(--text-tertiary)] opacity-50">
                  <WIcon name="chevron-right" size={13} />
                </div>
              </button>
            );
          })
        )}

        <div className="flex items-center gap-2 border-t border-[var(--border-hairline)] px-3.5 py-2.5 text-[11.5px] text-[var(--text-tertiary)]">
          <WIcon name="info" size={13} />
          Revenue from finalized invoices; cost is directly-attributable driver + carrier pay (margin is contribution — fuel/DEF are fleet-level, see P&amp;L).
          {data.truncated ? ` Top ${data.processed.toLocaleString()} of ${data.total.toLocaleString()} invoices.` : ''}
        </div>
      </DSCard>
    </div>
  );
}

// ── Drill ─────────────────────────────────────────────────────────────────
function buildDrill(r: ProfitRow, by: By, fleetMargin: number, ctx: ReportViewContext) {
  const delta = r.margin - fleetMargin;
  return {
    icon: by === 'lane' ? ('route' as const) : ('briefcase' as const),
    title: r.name,
    subtitle: `${r.loads.toLocaleString()} loads · ${by === 'lane' ? 'lane' : 'customer'}`,
    metrics: [
      { label: 'Revenue', value: acMoney(r.revenue) },
      { label: 'Profit', value: acMoney(r.profit), tone: r.profit < 0 ? AC_NEG : AC_POS },
      { label: 'Margin', value: `${r.margin}%`, tone: delta >= 0 ? AC_POS : AC_NEG },
    ],
    body:
      by === 'customer' ? (
        <CustomerLoadsDrill organizationId={ctx.organizationId} range={ctx.range} customerId={r.key as Id<'customers'>} />
      ) : (
        <div className="px-4 py-4 text-[12.5px] text-[var(--text-tertiary)]">
          Cost {acMoney(r.cost)} · Profit {acMoney(r.profit)} · {r.loads.toLocaleString()} loads on this lane.
        </div>
      ),
  };
}

function CustomerLoadsDrill({ organizationId, range, customerId }: { organizationId: string; range: ResolvedRange; customerId: Id<'customers'> }) {
  const data = useAuthQuery(api.accountingReports.getProfitabilityByLoad, {
    workosOrgId: organizationId,
    dateRangeStart: range.start,
    dateRangeEnd: range.end,
    customerId,
  });
  if (!data) return <div className="px-4 py-4 text-[12.5px] text-[var(--text-tertiary)]">Loading loads…</div>;
  if (data.loads.length === 0) return <div className="px-4 py-4 text-[12.5px] text-[var(--text-tertiary)]">No completed loads.</div>;
  return (
    <div className="divide-y divide-[var(--border-hairline)]">
      {data.loads.map((l) => (
        <div key={l.loadId} className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium">#{l.orderNumber}</div>
            <div className="truncate text-[11px] text-[var(--text-tertiary)]">{l.laneLabel}</div>
          </div>
          <div className="num text-right text-[12.5px] font-semibold" style={{ color: l.profit < 0 ? AC_NEG : AC_POS }}>
            {acMoney(l.profit)}
            <div className="text-[10.5px] font-normal text-[var(--text-tertiary)]">{l.margin}%</div>
          </div>
        </div>
      ))}
      {data.hasMore && (
        <div className="px-4 py-2.5 text-[11px] text-[var(--text-tertiary)]">Showing {data.showing} of {data.totalLoads} loads.</div>
      )}
    </div>
  );
}

// ── controls ──────────────────────────────────────────────────────────────
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

function LoadingCard() {
  return (
    <div className="flex min-h-[240px] items-center justify-center rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
      <p className="text-[12.5px] text-[var(--text-tertiary)]">Loading profitability…</p>
    </div>
  );
}
