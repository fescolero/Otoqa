'use client';

import Link from 'next/link';
import { Plus, Timer } from 'lucide-react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PanelBoundary } from '@/components/PanelBoundary';
import { ReasonAction } from '@/components/ReasonAction';
import { Badge, EmptyState, Kpi, MoreRows, PageHeader, Panel } from '@/components/ui';
import { formatAgo, formatCapped } from '@/lib/format';

/**
 * Runbooks live in the repo so they version with the code that raises the
 * alert. Override per environment if they ever move to a wiki.
 */
const RUNBOOK_BASE =
  process.env.NEXT_PUBLIC_RUNBOOK_BASE_URL ??
  'https://github.com/fescolero/Otoqa/blob/main/docs/runbooks';

export default function OverviewPage() {
  return (
    <ConsoleShell>
      <PageHeader
        title="Overview"
        subtitle="Open alerts, needs-attention events, and recent staff activity."
        actions={
          <Link className="button button-solid" href="/tickets">
            <Plus strokeWidth={1.75} aria-hidden="true" />
            File a ticket
          </Link>
        }
      />
      <PanelBoundary label="Platform pulse">
        <Pulse />
      </PanelBoundary>
      <PanelBoundary label="Self-check">
        <SelfCheck />
      </PanelBoundary>
      <PanelBoundary label="Alerts">
        <OpenAlerts />
      </PanelBoundary>
      <PanelBoundary label="Needs attention">
        <NeedsAttention />
      </PanelBoundary>
      <PanelBoundary label="Staff activity">
        <RecentStaffActivity />
      </PanelBoundary>
    </ConsoleShell>
  );
}

/**
 * The four numbers that describe the platform right now.
 *
 * Every meter here is a genuine ratio — cycle progress under the load count,
 * cron success under its own percentage. A meter under a bare count would be
 * decoration pretending to be information.
 */
function Pulse() {
  const pulse = useQuery(api.platform.pulse.platformPulse, {});
  const slo = useQuery(api.platform.slo.sloOverview, {});
  const counts = useQuery(api.platform.navCounts.navCounts, {});
  if (pulse === undefined) return null;

  if (pulse.snapshotAt === null) {
    return (
      <Panel title="Platform pulse" tone="warn">
        <p style={{ margin: 0 }}>
          No org health snapshot has ever been built on this deployment — load, driver and alert
          counts have no source until <span className="mono">org-health-snapshots</span> runs.
        </p>
      </Panel>
    );
  }

  const acked = Math.max(0, (counts?.alerts ?? 0) - (counts?.alertsHigh ?? 0));
  return (
    <div className="kpi-row">
      <Kpi
        label={`Loads this cycle (${pulse.periodKey})`}
        value={formatCapped(pulse.loadsThisCycle, 100_000)}
        meter={pulse.cycleProgress}
        hint={`${Math.round(pulse.cycleProgress * 100)}% through the cycle · ${pulse.orgCount} orgs`}
      />
      <Kpi
        label="Active driver shifts"
        value={String(pulse.activeDriverShifts)}
        hint={`of ${pulse.driverCount} drivers · snapshot ${formatAgo(pulse.snapshotAt)}`}
      />
      <Kpi
        label="Open alerts"
        value={String(counts?.alerts ?? 0)}
        tone={counts?.alerts ? 'danger' : 'neutral'}
        hint={
          counts?.alerts
            ? `${counts.alertsHigh} high · ${acked} other`
            : 'nothing raised right now'
        }
      />
      <Kpi
        label="Cron success"
        value={slo?.cron.successRate == null ? '—' : `${(slo.cron.successRate * 100).toFixed(2)}%`}
        meter={slo?.cron.successRate ?? undefined}
        tone={slo && slo.cron.failingNow > 0 ? 'danger' : 'ok'}
        hint={slo ? `${slo.cron.jobs} jobs · ${slo.cron.failingNow} failing now` : undefined}
      />
    </div>
  );
}

/**
 * Is the console's own machinery running? Alerting that is switched off looks
 * exactly like alerting with nothing to say, and that ambiguity is the failure
 * mode this panel exists to remove.
 */
function SelfCheck() {
  const check = useQuery(api.platform.selfCheck.consoleSelfCheck, {});
  if (check === undefined) return null;

  const unconfigured = check.integrations.filter((i) => !i.configured);
  const jobsBad = check.jobs.stale + check.jobs.hung + check.jobs.failing;
  const evaluatorBad = check.evaluator === null || check.evaluator.state !== 'ok';

  if (unconfigured.length === 0 && jobsBad === 0 && !evaluatorBad) {
    return (
      <Panel title="Self-check" tone="ok" flush>
        <div className="audit-row">
          <span className="action">alerts.evaluate</span>
          <span>
            {check.jobs.ok}/{check.jobs.total} jobs on schedule · {check.staffAllowlistSize} staff
            on the allowlist
          </span>
          <span className="muted">last run {formatAgo(check.evaluator!.lastRunAt)}</span>
          <span className="row-actions">
            <Badge tone="ok" dot>
              healthy
            </Badge>
          </span>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Self-check" tone="warn" flush>
      {check.evaluator === null ? (
        <div className="audit-row">
          <span className="action">alerts.evaluate</span>
          <span>
            Has never run on this deployment — no alert in this console can fire.
          </span>
          <span className="row-actions">
            <Badge tone="danger" dot>
              never run
            </Badge>
          </span>
        </div>
      ) : check.evaluator.state !== 'ok' ? (
        <div className="audit-row">
          <span className="action">alerts.evaluate</span>
          <span>
            Last run {formatAgo(check.evaluator.lastRunAt)} — alerts may be silently stalled.
          </span>
          <span className="row-actions">
            <Badge tone="danger" dot>
              {check.evaluator.state}
            </Badge>
          </span>
        </div>
      ) : null}

      {unconfigured.map((i) => (
        <div className="audit-row" key={i.key}>
          <span className="action">{i.key}</span>
          <span>{i.impact}</span>
          <span className="row-actions">
            <Badge tone="warn">not configured</Badge>
          </span>
        </div>
      ))}

      {jobsBad > 0 ? (
        <div className="audit-row">
          <span className="action">jobs</span>
          <span className="danger-text">
            {check.jobs.stale} stale · {check.jobs.hung} hung · {check.jobs.failing} failing
          </span>
          <span className="row-actions">
            <Link className="button button-sm" href="/jobs">
              <Timer strokeWidth={1.75} aria-hidden="true" />
              Jobs board
            </Link>
          </span>
        </div>
      ) : null}

      {check.jobs.unknown > 0 ? (
        <div className="audit-row">
          <span className="action">jobs.cadence</span>
          <span className="muted">
            {check.jobs.unknown} job(s) have no declared cadence recorded yet — they can&apos;t be
            checked for staleness until their next tick.
          </span>
          <span className="row-actions">
            <Badge>pending</Badge>
          </span>
        </div>
      ) : null}
    </Panel>
  );
}

function OpenAlerts() {
  const alerts = useQuery(api.platform.alerts.listAlerts, {});
  const ack = useMutation(api.platform.alerts.ackAlert);
  const resolve = useMutation(api.platform.alerts.resolveAlert);
  const snooze = useMutation(api.platform.alerts.snoozeAlert);
  const annotate = useMutation(api.platform.alerts.annotateAlert);

  if (!alerts || alerts.length === 0) return null;
  return (
    <Panel title="Active alerts" count={alerts.length} tone="danger" flush>
      {alerts.map((a) => (
        /* One row, not two: an alert is a single thing to decide about, and
           splitting the evidence from the buttons made the decision scroll. */
        <div className="audit-row alert-row" key={a._id}>
          <span className="action">{a.kind}</span>
          <span className="alert-message">{a.message}</span>
          <span className="muted">
            ×{a.count} · first seen {formatAgo(a.firstSeenAt)}
            {a.acknowledgedBy ? ` · acked by ${a.acknowledgedBy}` : ''}
            {a.note ? ` · note: ${a.note}${a.noteBy ? ` (${a.noteBy})` : ''}` : ''}
          </span>
          <span className="row-actions">
            <Badge tone={a.severity === 'high' ? 'danger' : 'warn'}>{a.severity}</Badge>
            {/* Runbook filenames match the alert kind exactly — see
                docs/runbooks/README.md. An alert without a remedy attached is
                just a notification. */}
            <a
              className="button button-sm"
              href={`${RUNBOOK_BASE}/${a.kind}.md`}
              target="_blank"
              rel="noreferrer"
            >
              Runbook ↗
            </a>
            {a.status === 'open' ? (
              <button className="button button-sm" onClick={() => ack({ alertId: a._id })}>
                Ack
              </button>
            ) : (
              <Badge outline>{a.status}</Badge>
            )}
            {/* A note without changing state — "who is on this and what have
                they tried" is what the next person needs mid-incident. */}
            <ReasonAction
              label="Note"
              onSubmit={async (note) => {
                await annotate({ alertId: a._id, note });
              }}
            />
            {/* Snooze exists because a manual resolve on a condition that is
                still true re-opens on the next 5-minute tick. */}
            <ReasonAction
              label="Snooze"
              requireReason={false}
              onSubmit={async (note, form) => {
                const hours = Number(new FormData(form).get('hours'));
                if (!Number.isFinite(hours) || hours <= 0) throw new Error('Pick a window');
                await snooze({ alertId: a._id, hours, note: note || undefined });
              }}
            >
              <select className="input input-sm" name="hours" defaultValue="4">
                <option value="1">1 hour</option>
                <option value="4">4 hours</option>
                <option value="24">1 day</option>
                <option value="72">3 days</option>
              </select>
            </ReasonAction>
            <ReasonAction
              label="Resolve"
              requireReason={false}
              onSubmit={async (note) => {
                await resolve({ alertId: a._id, note: note || undefined });
              }}
            />
          </span>
        </div>
      ))}
    </Panel>
  );
}

function NeedsAttention() {
  const events = useQuery(api.platform.events.recentEvents, { minSeverity: 'warn', limit: 25 });
  const ack = useMutation(api.platform.events.ackEvent);
  const ackAll = useMutation(api.platform.events.ackAllEvents);

  return (
    <Panel
      title="Needs attention"
      count={events?.length}
      tone={events && events.length > 0 ? 'warn' : 'neutral'}
      flush
      actions={
        events && events.length > 0 ? (
          /* Acking is safe: an event that recurs after its ack comes back, so
             the feed can be driven to zero without hiding live problems. */
          <ReasonAction
            label="Ack everything older than a day"
            requireReason={false}
            onSubmit={async () => {
              await ackAll({ olderThanMs: 24 * 60 * 60 * 1000 });
            }}
          />
        ) : null
      }
    >
      {events === undefined ? (
        <EmptyState>Loading…</EmptyState>
      ) : events.length === 0 ? (
        <EmptyState hint="Warn-and-above events land here. An acked event returns if the condition recurs.">
          Nothing needs attention.
        </EmptyState>
      ) : (
        events.map((e) => (
          <div className="audit-row" key={e._id}>
            <span className="when">{new Date(e.lastSeenAt ?? e.createdAt).toLocaleString()}</span>
            <span className="action">{e.code}</span>
            <Badge tone={e.severity === 'critical' || e.severity === 'error' ? 'danger' : 'warn'}>
              {e.severity}
            </Badge>
            <span>{e.message}</span>
            {(e.occurrences ?? 1) > 1 ? <span className="muted">×{e.occurrences}</span> : null}
            <span className="row-actions">
              <button className="button button-sm" onClick={() => ack({ eventId: e._id })}>
                Ack
              </button>
            </span>
          </div>
        ))
      )}
    </Panel>
  );
}

function RecentStaffActivity() {
  const rows = useQuery(api.platform.access.recentAuditLog, { limit: 50 });

  return (
    <Panel
      title="Recent platform-staff activity"
      count={rows?.length}
      flush
      actions={
        <Link className="button button-sm" href="/audit">
          Open audit trail
        </Link>
      }
      footer="The recent window only. The audit trail keeps 7 years and is searchable by actor, org and reason."
    >
      {rows === undefined ? (
        <EmptyState>Loading…</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState hint="Every staff write is recorded here, including the reason it was given.">
          No staff actions recorded yet.
        </EmptyState>
      ) : (
        <MoreRows max={8} moreLabel={(n) => `+${n} more in the recent window`}>
          {rows.map((row) => (
            <div className="audit-row" key={row._id}>
              <span className="when">{new Date(row.timestamp).toLocaleString()}</span>
              <span className="action">{row.action}</span>
              <span>{row.actorEmail}</span>
              {row.targetOrgId ? <span className="mono">{row.targetOrgId}</span> : null}
              {row.reason ? <span className="muted">— {row.reason}</span> : null}
            </div>
          ))}
        </MoreRows>
      )}
    </Panel>
  );
}
