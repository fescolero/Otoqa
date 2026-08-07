'use client';

import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { InvoicesBoard } from '@/components/InvoicesBoard';
import { formatMoney } from '@/lib/format';

export default function BillingPage() {
  return (
    <ConsoleShell>
      <h1>Platform billing</h1>
      <p className="subtitle">
        Receivables from the frozen invoice ledger; the revenue trend below derives the open
        cycle from live usage.
      </p>
      <InvoicesBoard />
      <Revenue />
    </ConsoleShell>
  );
}

function Revenue() {
  const revenue = useQuery(api.platform.billing.revenueOverview, {});
  if (revenue === undefined) return <div className="empty">Loading…</div>;

  const open = revenue.months.find((m) => m.isOpenCycle);
  const lastClosed = [...revenue.months].reverse().find((m) => !m.isOpenCycle);

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

      <div className="panel">
        <h2>Monthly revenue (last 12 cycles + open)</h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Cycle</th>
                <th>Loads</th>
                <th>Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {[...revenue.months].reverse().map((m) => (
                <tr key={m.periodKey}>
                  <td>{m.periodKey}</td>
                  <td>{m.loads}</td>
                  <td>{formatMoney(m.amount)}</td>
                  <td>{m.isOpenCycle ? <span className="chip chip-ok">accruing</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Top organizations — current cycle</h2>
        {revenue.currentCycleTopOrgs.length === 0 ? (
          <div className="empty">No metered usage yet this cycle.</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Loads</th>
                  <th>Rate</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {revenue.currentCycleTopOrgs.map((o) => (
                  <tr key={o.organizationId}>
                    <td>{o.name}</td>
                    <td>{o.loads}</td>
                    <td>{formatMoney(o.rate)}</td>
                    <td>{formatMoney(o.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}
