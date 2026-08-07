'use client';

import { useQuery, useMutation } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';

export default function OverviewPage() {
  return (
    <ConsoleShell>
      <h1>Overview</h1>
      <p className="subtitle">Open alerts, needs-attention events, and recent staff activity.</p>
      <OpenAlerts />
      <NeedsAttention />
      <RecentStaffActivity />
    </ConsoleShell>
  );
}

function OpenAlerts() {
  const alerts = useQuery(api.platform.alerts.listAlerts, {});
  const ack = useMutation(api.platform.alerts.ackAlert);

  if (!alerts || alerts.length === 0) return null;
  return (
    <div className="panel panel-danger">
      <h2>Active alerts</h2>
      {alerts.map((a) => (
        <div className="audit-row" key={a._id}>
          <span className={a.severity === 'high' ? 'chip chip-danger' : 'chip chip-warn'}>
            {a.severity}
          </span>
          <span className="action">{a.kind}</span>
          <span>{a.message}</span>
          <span className="muted">×{a.count}</span>
          {a.status === 'open' ? (
            <button className="button button-sm" onClick={() => ack({ alertId: a._id })}>
              Ack
            </button>
          ) : (
            <span className="chip">acked by {a.acknowledgedBy}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function NeedsAttention() {
  const events = useQuery(api.platform.events.recentEvents, { minSeverity: 'warn', limit: 25 });

  return (
    <div className={events && events.length > 0 ? 'panel panel-attention' : 'panel'}>
      <h2>Needs attention</h2>
      {events === undefined ? (
        <div className="empty">Loading…</div>
      ) : events.length === 0 ? (
        <div className="empty">Nothing needs attention. 🎉</div>
      ) : (
        events.map((e) => (
          <div className="audit-row" key={e._id}>
            <span className="when">{new Date(e.createdAt).toLocaleString()}</span>
            <span className={`chip ${e.severity === 'critical' ? 'chip-danger' : e.severity === 'error' ? 'chip-danger' : 'chip-warn'}`}>
              {e.severity}
            </span>
            <span className="action">{e.code}</span>
            <span>{e.message}</span>
          </div>
        ))
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
