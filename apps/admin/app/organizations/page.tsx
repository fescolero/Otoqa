'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PanelBoundary } from '@/components/PanelBoundary';
import { formatAgo, formatCapped } from '@/lib/format';

export default function OrganizationsPage() {
  return (
    <ConsoleShell>
      <h1>Organizations</h1>
      <p className="subtitle">
        Health snapshots rebuilt every 15 minutes — counts cap at 500.
      </p>
      <PanelBoundary label="Organization directory">
        <OrgDirectory />
      </PanelBoundary>
    </ConsoleShell>
  );
}

function OrgDirectory() {
  const orgs = useQuery(api.platform.orgs.listOrgs, {});
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!orgs) return undefined;
    const q = search.trim().toLowerCase();
    const rows = q
      ? orgs.filter(
          (o) =>
            o.name.toLowerCase().includes(q) ||
            (o.workosOrgId ?? '').toLowerCase().includes(q),
        )
      : [...orgs];
    rows.sort((a, b) => b.loadsThisCycle - a.loadsThisCycle);
    return rows;
  }, [orgs, search]);

  return (
    <div className="panel">
      <input
        className="search"
        placeholder="Search by name or WorkOS org id…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {filtered === undefined ? (
        <div className="empty">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="empty">No organizations match.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Organization</th>
                <th>Type</th>
                <th>Loads (cycle)</th>
                <th>Drivers</th>
                <th>Members</th>
                <th>Active shifts</th>
                <th>Open alerts</th>
                <th>Flags</th>
                <th>Snapshot</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr key={o._id}>
                  <td>
                    <Link href={`/organizations/${o.organizationId}`} className="row-link">
                      {o.name}
                    </Link>
                    {o.isDeleted ? <span className="chip chip-danger">deleted</span> : null}
                  </td>
                  <td>{o.orgType ?? '—'}</td>
                  <td>{formatCapped(o.loadsThisCycle)}</td>
                  <td>{formatCapped(o.driverCount)}</td>
                  <td>{formatCapped(o.memberCount)}</td>
                  <td>{formatCapped(o.activeSessionCount)}</td>
                  <td>
                    {o.openDispatchAlerts > 0 ? (
                      <span className="chip chip-warn">{formatCapped(o.openDispatchAlerts)}</span>
                    ) : (
                      '0'
                    )}
                  </td>
                  <td>{formatCapped(o.flagOverrideCount)}</td>
                  <td className="muted">{formatAgo(o.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
