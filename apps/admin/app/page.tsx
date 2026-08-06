'use client';

import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';

export default function OverviewPage() {
  return (
    <ConsoleShell>
      <h1>Overview</h1>
      <p className="subtitle">Needs-attention events and recent staff activity.</p>
      <NeedsAttention />
      <RecentStaffActivity />
    </ConsoleShell>
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
