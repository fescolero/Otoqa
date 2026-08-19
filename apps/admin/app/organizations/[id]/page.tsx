'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import type { Id } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PanelBoundary } from '@/components/PanelBoundary';
import {
  OrgSupportPanels,
  BillingConfigPanel,
  RateSchedulePanel,
  ContractPanel,
  ManualInvoicePanel,
  AllocatePaymentPanel,
} from '@/components/OrgSupportPanels';
import { Badge, DetailGrid, EmptyState, Kpi, PageHeader, Panel, toneFor } from '@/components/ui';
import { formatAgo, formatCapped, formatMoney, formatWhen } from '@/lib/format';

export default function OrgDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <ConsoleShell>
      <PanelBoundary label="Organization detail">
        <OrgDetail organizationId={id as Id<'organizations'>} />
      </PanelBoundary>
    </ConsoleShell>
  );
}

function OrgDetail({ organizationId }: { organizationId: Id<'organizations'> }) {
  const detail = useQuery(api.platform.orgs.getOrgDetail, { organizationId });

  if (detail === undefined) return <EmptyState>Loading…</EmptyState>;
  if (detail === null) return <EmptyState>Organization not found.</EmptyState>;

  const { org, snapshot, members, identityLinks, flags, usage, recentAudit, fkTickHealth, recentLoads } =
    detail;

  return (
    <>
      <PageHeader
        back={<Link href="/organizations">← Organizations</Link>}
        title={org.name}
        badge={org.isDeleted ? <Badge tone="danger">deleted</Badge> : null}
        subtitle={
          <>
            {org.orgType ?? 'unknown type'} · <span className="mono">{org.workosOrgId ?? 'no WorkOS id'}</span>
            {org.platformContractNumber ? ` · contract ${org.platformContractNumber}` : ''}
          </>
        }
      />

      {snapshot ? (
        <div className="kpi-row">
          <Kpi label="Loads this cycle" value={formatCapped(snapshot.loadsThisCycle)} />
          <Kpi label="Drivers" value={formatCapped(snapshot.driverCount)} />
          <Kpi label="Members" value={formatCapped(snapshot.memberCount)} />
          <Kpi label="Active shifts" value={formatCapped(snapshot.activeSessionCount)} />
          <Kpi label="Open alerts" value={formatCapped(snapshot.openDispatchAlerts)} />
        </div>
      ) : null}

      <Panel title="Billing">
        <DetailGrid
          items={[
            {
              label: 'Rate/load',
              value:
                org.billingRatePerLoad != null ? formatMoney(org.billingRatePerLoad) : 'default',
            },
            { label: 'Billing email', value: org.billingEmail ?? '—' },
            {
              label: 'License',
              value: `${org.platformLicenseStart ?? '—'} → ${org.platformLicenseEnd ?? '—'}`,
            },
          ]}
        />
        {usage.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th className="num">Loads written</th>
                </tr>
              </thead>
              <tbody>
                {[...usage].reverse().map((u) => (
                  <tr key={u.periodKey}>
                    <td className="mono">{u.periodKey}</td>
                    <td className="num">{u.loadsWritten.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No metered usage recorded.</EmptyState>
        )}
      </Panel>

      {fkTickHealth ? (
        <Panel title="FourKites push health">
          <DetailGrid
            items={[
              {
                label: 'Last tick',
                value: (
                  <>
                    <Badge tone={toneFor(fkTickHealth.lastTickKind ?? 'unknown')}>
                      {fkTickHealth.lastTickKind ?? 'unknown'}
                    </Badge>{' '}
                    {formatAgo(fkTickHealth.lastTickAt)}
                  </>
                ),
              },
              {
                label: 'Consecutive transient',
                value: fkTickHealth.consecutiveTransientTicks ?? 0,
              },
              ...(fkTickHealth.lastErrorKind
                ? [
                    {
                      label: 'Last error',
                      value: `${fkTickHealth.lastErrorKind} ${fkTickHealth.lastErrorStatus ?? ''}`,
                    },
                  ]
                : []),
            ]}
          />
        </Panel>
      ) : null}

      <Panel title="Members" count={members.length} flush>
        {members.length === 0 ? (
          <EmptyState hint="Members sync from WorkOS; an empty list usually means the directory connection is not set up.">
            No synced members.
          </EmptyState>
        ) : (
          members.map((m) => (
            <div className="audit-row" key={m.workosUserId}>
              <span>
                {m.firstName ?? ''} {m.lastName ?? ''}
              </span>
              <span className="muted">{m.email ?? m.workosUserId}</span>
            </div>
          ))
        )}
      </Panel>

      <ContractPanel organizationId={organizationId} current={org} />

      <BillingConfigPanel organizationId={organizationId} current={org} />

      <RateSchedulePanel
        organizationId={organizationId}
        schedule={org.rateSchedule ?? []}
        currentRate={org.billingRatePerLoad}
      />

      <ManualInvoicePanel organizationId={organizationId} />

      {org.workosOrgId ? <AllocatePaymentPanel workosOrgId={org.workosOrgId} /> : null}

      <OrgSupportPanels
        organizationId={organizationId}
        workosOrgId={org.workosOrgId ?? null}
        orgName={org.name}
        isDeleted={org.isDeleted}
        flags={flags}
        identityLinks={identityLinks}
      />

      <Panel
        title="Recent loads"
        subtitle="read-only"
        count={recentLoads.length}
        flush
        footer={`The newest ${recentLoads.length} of this org's loads. The dispatch app owns loads — this is a window onto it, not the list.`}
      >
        {recentLoads.length === 0 ? (
          <EmptyState>No loads.</EmptyState>
        ) : (
          recentLoads.map((l) => (
            <div className="audit-row" key={l._id}>
              <span className="action">{l.internalId ?? l._id}</span>
              <Badge tone={toneFor(l.status)}>{l.status}</Badge>
              <span className="muted">first stop {l.firstStopDate ?? '—'}</span>
              <span className="muted">{formatAgo(l.createdAt)}</span>
            </div>
          ))
        )}
      </Panel>

      {org.workosOrgId ? <StaffActionsOnOrg workosOrgId={org.workosOrgId} /> : null}

      <Panel title="Recent tenant activity" count={recentAudit.length} flush>
        {recentAudit.length === 0 ? (
          <EmptyState hint="This is the org's own audit log, written by their staff — not ours.">
            No audit entries.
          </EmptyState>
        ) : (
          recentAudit.map((a) => (
            <div className="audit-row" key={a._id}>
              <span className="when">{formatWhen(a.timestamp)}</span>
              <span className="action">
                {a.entityType}.{a.action}
              </span>
              <span>{a.entityName ?? ''}</span>
              <span className="muted">{a.performedByName ?? a.performedByEmail ?? ''}</span>
            </div>
          ))
        )}
      </Panel>
    </>
  );
}

/**
 * What have WE already done to this account — the first question in any
 * support interaction, and previously unanswerable in the console even though
 * the by_target_org index existed.
 */
function StaffActionsOnOrg({ workosOrgId }: { workosOrgId: string }) {
  const rows = useQuery(api.platform.access.recentAuditLog, { targetOrgId: workosOrgId, limit: 25 });

  return (
    <Panel
      title="Platform-staff actions on this org"
      count={rows?.length}
      flush
      actions={
        <a className="button button-sm" href={`/audit`}>
          Full trail
        </a>
      }
    >
      {rows === undefined ? (
        <EmptyState>Loading…</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState hint="This is the first question in any support conversation, so it gets its own panel.">
          No staff has acted on this organization.
        </EmptyState>
      ) : (
        rows.map((r) => (
          <div className="audit-row" key={r._id}>
            <span className="when">{formatWhen(r.timestamp)}</span>
            <span className="action">{r.action}</span>
            <span className="muted">{r.actorEmail}</span>
            {r.reason ? <span className="muted">— {r.reason}</span> : null}
          </div>
        ))
      )}
    </Panel>
  );
}
