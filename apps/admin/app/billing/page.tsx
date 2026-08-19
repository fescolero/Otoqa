'use client';

import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { InvoicesBoard } from '@/components/InvoicesBoard';
import { PanelBoundary } from '@/components/PanelBoundary';
import { Badge, EmptyState, Kpi, PageHeader, Panel } from '@/components/ui';
import { formatMoney } from '@/lib/format';

export default function BillingPage() {
  return (
    <ConsoleShell>
      <PageHeader
        title="Platform billing"
        subtitle={
          <>
            Receivables from the frozen invoice ledger; the revenue trend below derives the open
            cycle from live usage and counts <strong>metered usage only</strong> — one-off invoices
            appear in the ledger above, not in the trend.
          </>
        }
      />
      <PanelBoundary label="Invoices">
        <InvoicesBoard />
      </PanelBoundary>
      <PanelBoundary label="Revenue">
        <Revenue />
      </PanelBoundary>
    </ConsoleShell>
  );
}

function Revenue() {
  const revenue = useQuery(api.platform.billing.revenueOverview, {});
  if (revenue === undefined) return <EmptyState>Loading…</EmptyState>;

  const open = revenue.months.find((m) => m.isOpenCycle);
  const lastClosed = [...revenue.months].reverse().find((m) => !m.isOpenCycle);
  const months = [...revenue.months].reverse();
  // The meter reads each cycle against the biggest one in the window, so the
  // trend is legible without a chart library.
  const peak = Math.max(1, ...revenue.months.map((m) => m.amount));

  return (
    <>
      <div className="kpi-row">
        <Kpi label={`Accruing (${revenue.currentPeriod})`} value={formatMoney(open?.amount ?? 0)} />
        <Kpi
          label={`Last closed cycle${lastClosed ? ` (${lastClosed.periodKey})` : ''}`}
          value={formatMoney(lastClosed?.amount ?? 0)}
        />
        <Kpi label="Billable orgs" value={String(revenue.billableOrgCount)} />
        <Kpi label="Default rate" value={`${formatMoney(revenue.defaultRate)}/load`} />
      </div>

      <Panel
        title="Monthly revenue"
        subtitle="last 12 cycles + open"
        flush
        footer="Metered usage only. The open cycle is derived from live usage and still moves."
      >
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Cycle</th>
                <th className="num">Loads</th>
                <th className="num">Amount</th>
                <th style={{ width: '38%' }}></th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.periodKey}>
                  <td className="mono">{m.periodKey}</td>
                  <td className="num">{m.loads.toLocaleString()}</td>
                  <td className="num">{formatMoney(m.amount)}</td>
                  <td>
                    <span className="row-meter" aria-hidden="true">
                      <span
                        className={m.isOpenCycle ? 'row-meter-fill open' : 'row-meter-fill'}
                        style={{ width: `${Math.round((m.amount / peak) * 100)}%` }}
                      />
                    </span>
                    {m.isOpenCycle ? <Badge tone="ok">accruing</Badge> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Top organizations"
        subtitle="current cycle"
        count={revenue.currentCycleTopOrgs.length}
        flush
      >
        {revenue.currentCycleTopOrgs.length === 0 ? (
          <EmptyState hint="Usage lands here as loads are written; the cycle closes on the 1st.">
            No metered usage yet this cycle.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th className="num">Loads</th>
                  <th className="num">Rate</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {revenue.currentCycleTopOrgs.map((o) => (
                  <tr key={o.organizationId}>
                    <td>{o.name}</td>
                    <td className="num">{o.loads.toLocaleString()}</td>
                    <td className="num">{formatMoney(o.rate)}</td>
                    <td className="num">{formatMoney(o.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
