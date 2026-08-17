'use client';

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PanelBoundary } from '@/components/PanelBoundary';
import { ReasonAction } from '@/components/ReasonAction';
import { Badge, EmptyState, Kpi, PageHeader, Panel, toneFor } from '@/components/ui';
import { formatAgo, formatCapped } from '@/lib/format';

export default function HealthPage() {
  return (
    <ConsoleShell>
      <PageHeader
        title="Integration health"
        subtitle="Live rollups: FourKites push ticks per org and the external-tracking webhook queue."
      />
      <PanelBoundary label="Integration health">
        <HealthBoard />
      </PanelBoundary>
    </ConsoleShell>
  );
}

function SloSection() {
  const slo = useQuery(api.platform.slo.sloOverview, {});
  if (slo === undefined) return null;

  const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(2)}%`);
  const ms = (n: number | null) => (n === null ? '—' : `${n}ms`);
  const errorRateHigh = slo.partnerApi.errorRate !== null && slo.partnerApi.errorRate > 0.01;

  return (
    <div className="kpi-row">
      <Kpi
        label="Cron success"
        value={pct(slo.cron.successRate)}
        meter={slo.cron.successRate ?? undefined}
        tone={slo.cron.failingNow > 0 ? 'danger' : 'ok'}
        hint={`${slo.cron.jobs} jobs · ${slo.cron.failingNow} failing now`}
      />
      <Kpi
        label="Partner API p95"
        value={ms(slo.partnerApi.p95Ms)}
        hint={`last ${slo.partnerApi.sample} reqs · p50 ${ms(slo.partnerApi.p50Ms)}`}
      />
      <Kpi
        label="Partner API 5xx rate"
        value={pct(slo.partnerApi.errorRate)}
        tone={errorRateHigh ? 'danger' : 'neutral'}
        hint={errorRateHigh ? 'above the 1% budget' : 'within the 1% budget'}
      />
      <Kpi
        label="Webhook delivery success"
        value={pct(slo.webhooks.successRate)}
        meter={slo.webhooks.successRate ?? undefined}
        tone="ok"
        hint="retained window only"
      />
    </div>
  );
}

/**
 * Dead-lettered deliveries with the action that was missing: the alert has
 * fired since Phase 2 with no remedy anywhere in the codebase, so the only
 * fix was a CLI edit. Requeue resets attempts and reschedules immediately;
 * the partner's own idempotency key makes a duplicate safe on their side.
 */
function DeadLetters() {
  const rows = useQuery(api.platform.support.listDeadLetters, {});
  const requeue = useMutation(api.platform.support.requeueDeadLetters);
  const [result, setResult] = useState<string | null>(null);

  if (rows === undefined || rows.length === 0) return null;

  return (
    <Panel
      title="Dead-lettered webhook deliveries"
      count={rows.length}
      tone="warn"
      flush
      footer={result}
      actions={
        <ReasonAction
          label={`Requeue all ${rows.length}`}
          danger
          onSubmit={async (reason) => {
            const r = await requeue({ reason });
            setResult(
              `Requeued ${r.requeued}; skipped ${r.skipped} (already moving or endpoint gone).`,
            );
          }}
        />
      }
    >
      {rows.map((r) => (
        <div className="audit-row" key={r._id}>
          <span className="mono">{r.workosOrgId}</span>
          <span className="action">{r.eventType}</span>
          <span className="muted">{r.attempts} attempts</span>
          <span className="danger-text">
            {r.lastHttpStatus ?? ''} {r.lastErrorMessage ?? ''}
          </span>
          <span className="muted">{formatAgo(r.createdAt)}</span>
          <span className="row-actions">
            <ReasonAction
              label="Requeue"
              onSubmit={async (reason) => {
                await requeue({ deliveryIds: [r._id], reason });
              }}
            />
          </span>
        </div>
      ))}
    </Panel>
  );
}

function HealthBoard() {
  const health = useQuery(api.platform.health.integrationHealth, {});
  if (health === undefined) return <EmptyState>Loading…</EmptyState>;

  const { fourKites, webhookQueue } = health;

  return (
    <>
      <SloSection />
      <div className="kpi-row">
        <Kpi
          label="Webhook deliveries pending"
          value={formatCapped(webhookQueue.pending, webhookQueue.countCap)}
          hint={`counts cap at ${webhookQueue.countCap}`}
        />
        <Kpi
          label="Dead-lettered deliveries"
          value={formatCapped(webhookQueue.deadLetter, webhookQueue.countCap)}
          tone={webhookQueue.deadLetter > 0 ? 'danger' : 'neutral'}
          hint={webhookQueue.deadLetter > 0 ? 'requeue below' : 'nothing stuck'}
        />
      </div>

      <DeadLetters />

      <Panel title="FourKites push" subtitle="per org" count={fourKites.length} flush>
        {fourKites.length === 0 ? (
          <EmptyState>No orgs with FourKites push configured.</EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Org (WorkOS id)</th>
                  <th>Last tick</th>
                  <th className="num">Consecutive transient</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {fourKites.map((row) => (
                  <tr key={row._id}>
                    <td className="mono">{row.workosOrgId}</td>
                    <td>
                      <Badge tone={toneFor(row.lastTickKind ?? 'unknown')}>
                        {row.lastTickKind ?? 'unknown'}
                      </Badge>
                    </td>
                    <td className="num">{row.consecutiveTransientTicks ?? 0}</td>
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
      </Panel>
    </>
  );
}
