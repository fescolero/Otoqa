'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PanelBoundary } from '@/components/PanelBoundary';
import { Badge, EmptyState, PageHeader, Panel } from '@/components/ui';
import { formatAgo, formatCapped } from '@/lib/format';

export default function OrganizationsPage() {
  return (
    <ConsoleShell>
      <PageHeader
        title="Organizations"
        subtitle="Otoqa's own customers — brokers and broker-carriers. Health snapshots rebuilt every 15 minutes; counts cap at 500."
      />
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
      ? orgs.rows.filter(
          (o) =>
            o.name.toLowerCase().includes(q) || (o.workosOrgId ?? '').toLowerCase().includes(q),
        )
      : [...orgs.rows];
    rows.sort((a, b) => b.loadsThisCycle - a.loadsThisCycle);
    return rows;
  }, [orgs, search]);

  return (
    <Panel
      title="Directory"
      count={filtered?.length}
      subtitle="sorted by loads this cycle"
      flush
      actions={
        <input
          className="search"
          style={{ marginBottom: 0, maxWidth: 260 }}
          placeholder="Search name or org id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      }
      footer={
        orgs && orgs.hiddenCarrierCount > 0
          ? `${orgs.hiddenCarrierCount} carrier org(s) hidden — carriers onboarded by a broker are that broker's counterparties, not our customers, and they are never invoiced here. An org we have billed stays listed whatever its type says.`
          : null
      }
    >
      {filtered === undefined ? (
        <EmptyState>Loading…</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState hint={search ? 'Search matches name and WorkOS org id.' : undefined}>
          {search ? 'No organizations match that search.' : 'No organizations yet.'}
        </EmptyState>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Organization</th>
                <th>Type</th>
                <th className="num">Loads (cycle)</th>
                <th className="num">Drivers</th>
                <th className="num">Members</th>
                <th className="num">Active shifts</th>
                <th className="num">Open alerts</th>
                <th className="num">Flags</th>
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
                    {o.isDeleted ? <Badge tone="danger">deleted</Badge> : null}
                  </td>
                  <td className="muted">{o.orgType ?? '—'}</td>
                  <td className="num">{formatCapped(o.loadsThisCycle)}</td>
                  <td className="num">{formatCapped(o.driverCount)}</td>
                  <td className="num">{formatCapped(o.memberCount)}</td>
                  <td className="num">{formatCapped(o.activeSessionCount)}</td>
                  <td className="num">
                    {o.openDispatchAlerts > 0 ? (
                      <Badge tone="warn">{formatCapped(o.openDispatchAlerts)}</Badge>
                    ) : (
                      '0'
                    )}
                  </td>
                  <td className="num">{formatCapped(o.flagOverrideCount)}</td>
                  <td className="muted">{formatAgo(o.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
