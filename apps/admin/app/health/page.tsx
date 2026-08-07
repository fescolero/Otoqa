'use client';

import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { formatCapped } from '@/lib/format';

export default function HealthPage() {
  return (
    <ConsoleShell>
      <h1>Integration health</h1>
      <p className="subtitle">
        Live rollups: FourKites push ticks per org and the external-tracking webhook queue.
      </p>
      <HealthBoard />
    </ConsoleShell>
  );
}

function SloSection() {
  const slo = useQuery(api.platform.slo.sloOverview, {});
  if (slo === undefined) return null;

  const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(2)}%`);
  const ms = (n: number | null) => (n === null ? '—' : `${n}ms`);

  return (
    <div className="kpi-row">
      <div className={slo.cron.failingNow > 0 ? 'kpi kpi-danger' : 'kpi'}>
        <div className="kpi-value">{pct(slo.cron.successRate)}</div>
        <div className="kpi-label">Cron success ({slo.cron.jobs} jobs, {slo.cron.failingNow} failing now)</div>
      </div>
      <div className="kpi">
        <div className="kpi-value">{ms(slo.partnerApi.p95Ms)}</div>
        <div className="kpi-label">Partner API p95 (last {slo.partnerApi.sample} reqs, p50 {ms(slo.partnerApi.p50Ms)})</div>
      </div>
      <div className={slo.partnerApi.errorRate !== null && slo.partnerApi.errorRate > 0.01 ? 'kpi kpi-danger' : 'kpi'}>
        <div className="kpi-value">{pct(slo.partnerApi.errorRate)}</div>
        <div className="kpi-label">Partner API 5xx rate</div>
      </div>
      <div className="kpi">
        <div className="kpi-value">{pct(slo.webhooks.successRate)}</div>
        <div className="kpi-label">Webhook delivery success (retained window)</div>
      </div>
    </div>
  );
}

function HealthBoard() {
  const health = useQuery(api.platform.health.integrationHealth, {});
  if (health === undefined) return <div className="empty">Loading…</div>;

  const { fourKites, webhookQueue } = health;

  return (
    <>
      <SloSection />
      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-value">{formatCapped(webhookQueue.pending, webhookQueue.countCap)}</div>
          <div className="kpi-label">Webhook deliveries pending</div>
        </div>
        <div className={webhookQueue.deadLetter > 0 ? 'kpi kpi-danger' : 'kpi'}>
          <div className="kpi-value">{formatCapped(webhookQueue.deadLetter, webhookQueue.countCap)}</div>
          <div className="kpi-label">Dead-lettered deliveries</div>
        </div>
      </div>

      <div className="panel">
        <h2>FourKites push — per org</h2>
        {fourKites.length === 0 ? (
          <div className="empty">No orgs with FourKites push configured.</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Org (WorkOS id)</th>
                  <th>Last tick</th>
                  <th>Consecutive transient</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {fourKites.map((row) => (
                  <tr key={row._id}>
                    <td className="muted">{row.workosOrgId}</td>
                    <td>
                      <span
                        className={
                          row.lastTickKind === 'ok' || row.lastTickKind === 'empty'
                            ? 'chip chip-ok'
                            : row.lastTickKind === 'all_failed'
                              ? 'chip chip-danger'
                              : 'chip chip-warn'
                        }
                      >
                        {row.lastTickKind ?? 'unknown'}
                      </span>
                    </td>
                    <td>{row.consecutiveTransientTicks ?? 0}</td>
                    <td className="danger-text">
                      {row.lastErrorKind
                        ? `${row.lastErrorKind}${row.lastErrorStatus ? ` (${row.lastErrorStatus})` : ''}`
                        : '—'}
                    </td>
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
