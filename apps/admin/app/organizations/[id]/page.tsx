'use client';

import { use } from 'react';
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

  if (detail === undefined) return <div className="empty">Loading…</div>;
  if (detail === null) return <div className="empty">Organization not found.</div>;

  const { org, snapshot, members, identityLinks, flags, usage, recentAudit, fkTickHealth, recentLoads } =
    detail;

  return (
    <>
      <h1>
        {org.name}
        {org.isDeleted ? <span className="chip chip-danger">deleted</span> : null}
      </h1>
      <p className="subtitle">
        {org.orgType ?? 'unknown type'} · {org.workosOrgId ?? 'no WorkOS id'}
        {org.platformContractNumber ? ` · contract ${org.platformContractNumber}` : ''}
      </p>

      {snapshot ? (
        <div className="kpi-row">
          <Kpi label="Loads this cycle" value={formatCapped(snapshot.loadsThisCycle)} />
          <Kpi label="Drivers" value={formatCapped(snapshot.driverCount)} />
          <Kpi label="Members" value={formatCapped(snapshot.memberCount)} />
          <Kpi label="Active shifts" value={formatCapped(snapshot.activeSessionCount)} />
          <Kpi label="Open alerts" value={formatCapped(snapshot.openDispatchAlerts)} />
        </div>
      ) : null}

      <div className="panel">
        <h2>Billing</h2>
        <div className="detail-grid">
          <span className="muted">Rate/load</span>
          <span>{org.billingRatePerLoad != null ? formatMoney(org.billingRatePerLoad) : 'default'}</span>
          <span className="muted">Billing email</span>
          <span>{org.billingEmail ?? '—'}</span>
          <span className="muted">License</span>
          <span>
            {org.platformLicenseStart ?? '—'} → {org.platformLicenseEnd ?? '—'}
          </span>
        </div>
        {usage.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th>Loads written</th>
                </tr>
              </thead>
              <tbody>
                {[...usage].reverse().map((u) => (
                  <tr key={u.periodKey}>
                    <td>{u.periodKey}</td>
                    <td>{u.loadsWritten}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No metered usage recorded.</div>
        )}
      </div>

      {fkTickHealth ? (
        <div className="panel">
          <h2>FourKites push health</h2>
          <div className="detail-grid">
            <span className="muted">Last tick</span>
            <span>
              <TickChip kind={fkTickHealth.lastTickKind} /> {formatAgo(fkTickHealth.lastTickAt)}
            </span>
            <span className="muted">Consecutive transient</span>
            <span>{fkTickHealth.consecutiveTransientTicks ?? 0}</span>
            {fkTickHealth.lastErrorKind ? (
              <>
                <span className="muted">Last error</span>
                <span>
                  {fkTickHealth.lastErrorKind} {fkTickHealth.lastErrorStatus ?? ''}
                </span>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="panel">
        <h2>Members ({members.length})</h2>
        {members.length === 0 ? (
          <div className="empty">No synced members.</div>
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
      </div>

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

      <div className="panel">
        <h2>Recent loads (read-only view)</h2>
        {recentLoads.length === 0 ? (
          <div className="empty">No loads.</div>
        ) : (
          recentLoads.map((l) => (
            <div className="audit-row" key={l._id}>
              <span className="action">{l.internalId ?? l._id}</span>
              <span className="chip">{l.status}</span>
              <span className="muted">first stop {l.firstStopDate ?? '—'}</span>
              <span className="muted">{formatAgo(l.createdAt)}</span>
            </div>
          ))
        )}
      </div>

      {org.workosOrgId ? <StaffActionsOnOrg workosOrgId={org.workosOrgId} /> : null}

      <div className="panel">
        <h2>Recent tenant activity</h2>
        {recentAudit.length === 0 ? (
          <div className="empty">No audit entries.</div>
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
      </div>
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
    <div className="panel">
      <h2>Platform-staff actions on this org</h2>
      {rows === undefined ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">No staff has acted on this organization.</div>
      ) : (
        rows.map((r) => (
          <div className="audit-row" key={r._id}>
            <span className="when">{formatWhen(r.timestamp)}</span>
            <span className="action">{r.action}</span>
            <span className="muted">{r.actorEmail}</span>
            {r.reason ? <span>— {r.reason}</span> : null}
          </div>
        ))
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

function TickChip({ kind }: { kind?: string }) {
  if (!kind) return <span className="chip">unknown</span>;
  const cls =
    kind === 'ok' ? 'chip chip-ok' : kind === 'all_failed' ? 'chip chip-danger' : 'chip chip-warn';
  return <span className={cls}>{kind}</span>;
}
