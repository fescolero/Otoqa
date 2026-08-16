'use client';

import { useQuery, useMutation } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PanelBoundary } from '@/components/PanelBoundary';
import { ReasonAction } from '@/components/ReasonAction';
import { formatAgo } from '@/lib/format';

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
      <h1>Overview</h1>
      <p className="subtitle">Open alerts, needs-attention events, and recent staff activity.</p>
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
      <div className="panel">
        <h2>Self-check</h2>
        <div className="audit-row">
          <span className="chip chip-ok">healthy</span>
          <span className="muted">
            {check.jobs.ok}/{check.jobs.total} jobs on schedule · alert evaluator ran{' '}
            {formatAgo(check.evaluator!.lastRunAt)} · {check.staffAllowlistSize} staff on the
            allowlist
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="panel panel-attention">
      <h2>Self-check</h2>
      {check.evaluator === null ? (
        <div className="audit-row">
          <span className="chip chip-danger">alerting</span>
          <span>
            The alert evaluator has never run on this deployment — no alert in this console can
            fire.
          </span>
        </div>
      ) : check.evaluator.state !== 'ok' ? (
        <div className="audit-row">
          <span className="chip chip-danger">alerting</span>
          <span>
            Alert evaluator is <strong>{check.evaluator.state}</strong> (last run{' '}
            {formatAgo(check.evaluator.lastRunAt)}) — alerts may be silently stalled.
          </span>
        </div>
      ) : null}

      {unconfigured.map((i) => (
        <div className="audit-row" key={i.key}>
          <span className="chip chip-warn">not configured</span>
          <span className="action">{i.label}</span>
          <span className="muted">{i.impact}</span>
        </div>
      ))}

      {jobsBad > 0 ? (
        <div className="audit-row">
          <span className="chip chip-warn">jobs</span>
          <span>
            {check.jobs.stale} stale · {check.jobs.hung} hung · {check.jobs.failing} failing
          </span>
          <a className="button button-sm" href="/jobs">
            Jobs board
          </a>
        </div>
      ) : null}

      {check.jobs.unknown > 0 ? (
        <div className="audit-row">
          <span className="chip">pending</span>
          <span className="muted">
            {check.jobs.unknown} job(s) have no declared cadence recorded yet — they can&apos;t be
            checked for staleness until their next tick.
          </span>
        </div>
      ) : null}
    </div>
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
    <div className="panel panel-danger">
      <h2>Active alerts</h2>
      {alerts.map((a) => (
        <div className="ticket-row" key={a._id}>
          <div className="audit-row">
            <span className={a.severity === 'high' ? 'chip chip-danger' : 'chip chip-warn'}>
              {a.severity}
            </span>
            <span className="action">{a.kind}</span>
            <span>{a.message}</span>
            <span className="muted">×{a.count}</span>
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
          </div>
          <div className="audit-row">
            <span className="muted">
              first seen {formatAgo(a.firstSeenAt)}
              {a.acknowledgedBy ? ` · acked by ${a.acknowledgedBy}` : ''}
              {a.note ? ` · note: ${a.note}${a.noteBy ? ` (${a.noteBy})` : ''}` : ''}
            </span>
            {a.status === 'open' ? (
              <button className="button button-sm" onClick={() => ack({ alertId: a._id })}>
                Ack
              </button>
            ) : (
              <span className="chip">{a.status}</span>
            )}
            {/* A note without changing state — "who is on this and what have
                they tried" is what the next person needs mid-incident. */}
            <ReasonAction
              label="Note"
              onSubmit={async (note) => {
                await annotate({ alertId: a._id, note });
              }}
            />
            <ReasonAction
              label="Resolve"
              requireReason={false}
              onSubmit={async (note) => {
                await resolve({ alertId: a._id, note: note || undefined });
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
              <select className="input" name="hours" defaultValue="4">
                <option value="1">1 hour</option>
                <option value="4">4 hours</option>
                <option value="24">1 day</option>
                <option value="72">3 days</option>
              </select>
            </ReasonAction>
          </div>
        </div>
      ))}
    </div>
  );
}

function NeedsAttention() {
  const events = useQuery(api.platform.events.recentEvents, { minSeverity: 'warn', limit: 25 });
  const ack = useMutation(api.platform.events.ackEvent);
  const ackAll = useMutation(api.platform.events.ackAllEvents);

  return (
    <div className={events && events.length > 0 ? 'panel panel-attention' : 'panel'}>
      <h2>Needs attention</h2>
      {events === undefined ? (
        <div className="empty">Loading…</div>
      ) : events.length === 0 ? (
        <div className="empty">Nothing needs attention. 🎉</div>
      ) : (
        <>
          {events.map((e) => (
            <div className="audit-row" key={e._id}>
              <span className="when">{new Date(e.lastSeenAt ?? e.createdAt).toLocaleString()}</span>
              <span
                className={`chip ${
                  e.severity === 'critical' || e.severity === 'error' ? 'chip-danger' : 'chip-warn'
                }`}
              >
                {e.severity}
              </span>
              <span className="action">{e.code}</span>
              <span>{e.message}</span>
              {(e.occurrences ?? 1) > 1 ? (
                <span className="muted">×{e.occurrences}</span>
              ) : null}
              <button className="button button-sm" onClick={() => ack({ eventId: e._id })}>
                Ack
              </button>
            </div>
          ))}
          {/* Acking is safe: an event that recurs after its ack comes back,
              so the feed can be driven to zero without hiding live problems. */}
          <ReasonAction
            label="Ack everything older than a day"
            requireReason={false}
            onSubmit={async () => {
              await ackAll({ olderThanMs: 24 * 60 * 60 * 1000 });
            }}
          />
        </>
      )}
    </div>
  );
}

function RecentStaffActivity() {
  const rows = useQuery(api.platform.access.recentAuditLog, { limit: 50 });

  return (
    <div className="panel">
      <h2>Recent platform-staff activity</h2>
      {rows === undefined ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">No staff actions recorded yet.</div>
      ) : (
        rows.map((row) => (
          <div className="audit-row" key={row._id}>
            <span className="when">{new Date(row.timestamp).toLocaleString()}</span>
            <span className="action">{row.action}</span>
            <span>{row.actorEmail}</span>
            {row.targetOrgId ? <span>org: {row.targetOrgId}</span> : null}
            {row.reason ? <span>— {row.reason}</span> : null}
          </div>
        ))
      )}
    </div>
  );
}
