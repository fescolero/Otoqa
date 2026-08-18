'use client';

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PanelBoundary } from '@/components/PanelBoundary';
import { ReasonAction } from '@/components/ReasonAction';
import { Badge, EmptyState, Kpi, PageHeader, Panel, type Tone } from '@/components/ui';
import { formatAgo, formatCapped, formatDuration } from '@/lib/format';

export default function HealthPage() {
  return (
    <ConsoleShell>
      <PageHeader
        title="Integration health"
        subtitle="What our customers connect, what we depend on, and the traffic in both directions."
      />
      <PanelBoundary label="Integration health">
        <HealthBoard />
      </PanelBoundary>
    </ConsoleShell>
  );
}

/** The state vocabulary, mapped once so the chip and the KPI agree. */
const STATE_TONE: Record<string, Tone> = {
  ok: 'ok',
  failing: 'danger',
  stale: 'danger',
  never_run: 'warn',
  disabled: 'neutral',
};

const STATE_HELP: Record<string, string> = {
  failing: 'Its last word was an error — a tick that logs no success is not a recovery.',
  stale: 'No activity within three expected cycles. Check the schedule, not the credentials.',
  never_run: 'Configured but has never reported. Usually credentials or a disabled cron.',
  disabled: 'Switched off in the org’s integration settings. Not alerting.',
  not_configured: 'No key set on this deployment, so it has never been callable.',
  never_called: 'Configured, but nothing has called it yet on this deployment.',
};

const SERVICE_TONE: Record<string, Tone> = {
  ok: 'ok',
  failing: 'danger',
  not_configured: 'warn',
  never_called: 'neutral',
};

function HealthBoard() {
  const health = useQuery(api.platform.health.integrationHealth, {});
  if (health === undefined) return <EmptyState>Loading…</EmptyState>;

  const { integrations, summary, webhookQueue } = health;
  const needsHuman = summary.failing + summary.stale + summary.neverRun;

  return (
    <>
      <div className="kpi-row">
        <Kpi
          label="Integrations configured"
          value={String(summary.total)}
          hint={summary.providers.length ? summary.providers.join(' · ') : 'no providers yet'}
        />
        <Kpi
          label="Needing a human"
          value={String(needsHuman)}
          tone={needsHuman > 0 ? 'danger' : 'ok'}
          hint={`${summary.failing} failing · ${summary.stale} stale · ${summary.neverRun} never run`}
        />
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

      <Integrations rows={integrations} />
      <PanelBoundary label="Our dependencies">
        <ExternalServices />
      </PanelBoundary>
      <DeadLetters />
      <InboundApi />
    </>
  );
}

/**
 * One row per org × provider, straight off `orgIntegrations`. A provider that
 * gets configured tomorrow appears here without a code change — which is the
 * whole reason this replaced the FourKites-only panel.
 */
function Integrations({
  rows,
}: {
  rows: NonNullable<
    ReturnType<typeof useQuery<typeof api.platform.health.integrationHealth>>
  >['integrations'];
}) {
  return (
    <Panel
      title="Integrations"
      count={rows.length}
      subtitle="worst first"
      flush
      footer="Driven by each org's integration settings, so any provider configured appears here. Cadence comes from the integration's own pull interval where it declares one, otherwise from the cron that drives it."
    >
      {rows.length === 0 ? (
        <EmptyState hint="Orgs configure these in their own integration settings; nothing is provisioned from this console.">
          No integrations configured on any organization.
        </EmptyState>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Organization</th>
                <th>State</th>
                <th>Direction</th>
                <th>Last activity</th>
                <th>Every</th>
                <th className="num">Records</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._id}>
                  <td className="mono">{r.provider}</td>
                  <td className="muted mono">{r.workosOrgId}</td>
                  <td>
                    <span title={STATE_HELP[r.state] ?? ''}>
                      <Badge tone={STATE_TONE[r.state] ?? 'neutral'}>
                        {r.state.replace('_', ' ')}
                      </Badge>
                    </span>
                  </td>
                  <td className="muted">
                    {[r.pullEnabled ? 'pull' : null, r.pushEnabled ? 'push' : null]
                      .filter(Boolean)
                      .join(' + ') || '—'}
                  </td>
                  <td className="muted">
                    {r.lastActivityAt ? formatAgo(r.lastActivityAt) : 'never'}
                  </td>
                  <td className="muted">{formatDuration(r.cadenceMs)}</td>
                  <td className="num">{r.recordsProcessed ?? '—'}</td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {r.lastError ? (
                      <span className="danger-text">{r.lastError}</span>
                    ) : r.samsaraPingsLastTick !== null ? (
                      <span className="muted">{r.samsaraPingsLastTick} pings last tick</span>
                    ) : r.pushTickKind ? (
                      <span className="muted">
                        last tick {r.pushTickKind}
                        {r.consecutiveTransientTicks
                          ? ` · ${r.consecutiveTransientTicks} consecutive transient`
                          : ''}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
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
      subtitle="outbound, to partners"
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

/**
 * The inbound half, kept separate and labelled.
 *
 * These figures come from apiAuditLog — partners calling OUR API — which is
 * the opposite direction from everything above. They sat in the same KPI row
 * as the outbound integrations, which made "Partner API 5xx rate" read as a
 * partner being down when it means we were returning errors to them.
 */
function InboundApi() {
  const slo = useQuery(api.platform.slo.sloOverview, {});
  if (slo === undefined) return null;

  const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(2)}%`);
  const ms = (n: number | null) => (n === null ? '—' : `${n}ms`);
  const errorRateHigh = slo.partnerApi.errorRate !== null && slo.partnerApi.errorRate > 0.01;

  return (
    <Panel
      title="Inbound partner API"
      subtitle="partners calling us"
      footer="Response times and error rate we served to partner API keys, over the retained window. Cron success covers all scheduled jobs and lives on the Jobs board."
    >
      <div className="kpi-row" style={{ marginBottom: 0 }}>
        <Kpi
          label="p95 response"
          value={ms(slo.partnerApi.p95Ms)}
          hint={`last ${slo.partnerApi.sample} reqs · p50 ${ms(slo.partnerApi.p50Ms)}`}
        />
        <Kpi
          label="5xx we returned"
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
        <Kpi
          label="Cron success"
          value={pct(slo.cron.successRate)}
          meter={slo.cron.successRate ?? undefined}
          tone={slo.cron.failingNow > 0 ? 'danger' : 'ok'}
          hint={`${slo.cron.jobs} jobs · ${slo.cron.failingNow} failing now`}
        />
      </div>
    </Panel>
  );
}

/**
 * The services WE call out to, as opposed to the ones a customer configures.
 *
 * Every declared dependency is listed even if it has never been called —
 * "we depend on this and have never seen it work" is exactly the finding a
 * board like this exists to surface, and it cannot be expressed by a list of
 * only what has reported.
 */
function ExternalServices() {
  const health = useQuery(api.platform.health.externalServiceHealth, {});
  if (health === undefined) return null;
  const { services, summary } = health;

  return (
    <Panel
      title="Our dependencies"
      subtitle="services we call out to"
      count={services.length}
      tone={summary.failing > 0 ? 'danger' : 'neutral'}
      flush
      footer={
        <>
          {summary.ok} healthy · {summary.failing} failing · {summary.neverCalled} never called ·{' '}
          {summary.notConfigured} not configured. Recorded on every outbound call; successful calls
          write at most once a minute per service, so a timestamp can be up to a minute behind.
          There is no <strong>stale</strong> state here — these are called on demand, so silence is
          not a symptom.
        </>
      }
    >
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>What it does</th>
              <th>State</th>
              <th>Last ok</th>
              <th className="num">Consecutive failures</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => (
              <tr key={s.key}>
                <td>{s.label}</td>
                <td className="muted">{s.purpose}</td>
                <td>
                  <span title={STATE_HELP[s.state] ?? ''}>
                    <Badge tone={SERVICE_TONE[s.state] ?? 'neutral'}>
                      {s.state.replace('_', ' ')}
                    </Badge>
                  </span>
                </td>
                <td className="muted">{s.lastOkAt ? formatAgo(s.lastOkAt) : '—'}</td>
                <td className="num">
                  {s.consecutiveFailures > 0 ? (
                    <span className="danger-text">{s.consecutiveFailures}</span>
                  ) : (
                    '0'
                  )}
                </td>
                <td style={{ whiteSpace: 'normal' }}>
                  {s.state === 'not_configured' ? (
                    /* The variable NAME helps fix it; the value never leaves the server. */
                    <span className="muted mono">{s.env} not set</span>
                  ) : s.lastError ? (
                    <span className="danger-text">
                      {s.lastError}
                      {s.lastErrorAt ? <span className="muted"> · {formatAgo(s.lastErrorAt)}</span> : null}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
