'use client';

import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';

export default function OverviewPage() {
  return (
    <ConsoleShell>
      <h1>Overview</h1>
      <p className="subtitle">
        Phase 0 — staff access, audit trail, and the shell. Boards land in Phase 1.
      </p>
      <RecentStaffActivity />
    </ConsoleShell>
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
