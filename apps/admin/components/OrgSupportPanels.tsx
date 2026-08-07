'use client';

import { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '@otoqa/convex-client';
import type { Id } from '@otoqa/convex-client';
import { formatAgo, formatWhen } from '@/lib/format';
import { ReasonAction } from '@/components/ReasonAction';

/**
 * The interactive support sections of the org detail page (Phase 2). Every
 * action here is a staff-gated Convex mutation that writes platformAuditLog;
 * destructive ones also demand a recent sign-in (step-up) — the error
 * message from the backend is shown inline when that trips.
 */

export function OrgSupportPanels({
  organizationId,
  workosOrgId,
  orgName,
  isDeleted,
  flags,
  identityLinks,
}: {
  organizationId: Id<'organizations'>;
  workosOrgId: string | null;
  orgName: string;
  isDeleted: boolean;
  flags: { _id: string; key: string; value: string }[];
  identityLinks: {
    _id: Id<'userIdentityLinks'>;
    clerkUserId: string;
    role: string;
    phone?: string;
    email?: string;
  }[];
}) {
  return (
    <>
      {workosOrgId ? (
        <>
          <ActiveSessionsPanel workosOrgId={workosOrgId} />
          <SessionEndAlertsPanel workosOrgId={workosOrgId} />
          <FlagsEditorPanel workosOrgId={workosOrgId} flags={flags} />
          <DriversPanel workosOrgId={workosOrgId} />
        </>
      ) : null}
      <IdentityLinksPanel links={identityLinks} />
      <DangerZone organizationId={organizationId} orgName={orgName} isDeleted={isDeleted} />
    </>
  );
}

function ActiveSessionsPanel({ workosOrgId }: { workosOrgId: string }) {
  const sessions = useQuery(api.platform.support.listActiveSessions, { workosOrgId });
  const forceEnd = useMutation(api.platform.support.forceEndSession);

  return (
    <div className="panel">
      <h2>Active driver sessions {sessions ? `(${sessions.length})` : ''}</h2>
      {sessions === undefined ? (
        <div className="empty">Loading…</div>
      ) : sessions.length === 0 ? (
        <div className="empty">No active sessions.</div>
      ) : (
        sessions.map((s) => (
          <div className="audit-row" key={s._id}>
            <span>{s.driverName}</span>
            <span className="muted">started {formatAgo(s.startedAt)}</span>
            <span className="muted">
              last ping {s.lastPingAt ? formatAgo(s.lastPingAt) : 'never'}
            </span>
            <ReasonAction
              label="Force end"
              danger
              onSubmit={async (reason, form) => {
                const code = new FormData(form).get('reasonCode') as
                  | 'emergency'
                  | 'unreachable_driver'
                  | 'phone_issues';
                await forceEnd({ sessionId: s._id, reasonCode: code, reason });
              }}
            >
              <select className="input" name="reasonCode" defaultValue="unreachable_driver">
                <option value="unreachable_driver">Unreachable driver</option>
                <option value="phone_issues">Phone issues</option>
                <option value="emergency">Emergency</option>
              </select>
            </ReasonAction>
          </div>
        ))
      )}
    </div>
  );
}

function SessionEndAlertsPanel({ workosOrgId }: { workosOrgId: string }) {
  const rows = useQuery(api.platform.support.listUnackedSessionEndAlerts, { workosOrgId });
  const ack = useMutation(api.platform.support.ackSessionEndAlert);

  if (!rows || rows.length === 0) return null;
  return (
    <div className="panel panel-attention">
      <h2>Sessions ended with active loads (unacknowledged)</h2>
      {rows.map((r) => (
        <div className="audit-row" key={r._id}>
          <span className="when">{formatWhen(r.endedAt)}</span>
          <span>{r.driverName}</span>
          <span className="muted">
            {r.endReason} · {r.affectedLegs} leg(s) affected
          </span>
          <button className="button button-sm" onClick={() => ack({ id: r._id })}>
            Acknowledge
          </button>
        </div>
      ))}
    </div>
  );
}

function FlagsEditorPanel({
  workosOrgId,
  flags,
}: {
  workosOrgId: string;
  flags: { _id: string; key: string; value: string }[];
}) {
  const setFlag = useMutation(api.platform.support.setOrgFlag);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="panel">
      <h2>Feature flags (org overrides)</h2>
      {flags.length === 0 ? <div className="empty">No org-scoped overrides.</div> : null}
      {flags.map((f) => (
        <div className="audit-row" key={f._id}>
          <span className="action">{f.key}</span>
          <span>{f.value}</span>
          <ReasonAction
            label="Remove"
            danger
            requireReason={false}
            onSubmit={async (reason) => {
              await setFlag({ workosOrgId, key: f.key, value: null, reason: reason || undefined });
            }}
          />
        </div>
      ))}
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!newKey.trim()) return;
          setError(null);
          try {
            await setFlag({ workosOrgId, key: newKey.trim(), value: newValue });
            setNewKey('');
            setNewValue('');
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <input className="input" placeholder="flag key" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
        <input
          className="input"
          placeholder="value (string)"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
        />
        <button className="button button-sm" type="submit">
          Set flag
        </button>
        {error ? <div className="danger-text form-error">{error}</div> : null}
      </form>
    </div>
  );
}

function DriversPanel({ workosOrgId }: { workosOrgId: string }) {
  const drivers = useQuery(api.platform.support.listDriversForOrg, { workosOrgId });
  const resync = useAction(api.platform.support.resyncDriverClerk);

  return (
    <div className="panel">
      <h2>Drivers {drivers ? `(${drivers.length})` : ''}</h2>
      {drivers === undefined ? (
        <div className="empty">Loading…</div>
      ) : drivers.length === 0 ? (
        <div className="empty">No drivers.</div>
      ) : (
        drivers.map((d) => (
          <div className="audit-row" key={d._id}>
            <span>{d.name}</span>
            <span className="muted">{d.phone}</span>
            <span className={d.clerkUserId ? 'chip chip-ok' : 'chip chip-warn'}>
              {d.clerkUserId ? 'clerk linked' : (d.clerkSyncStatus ?? 'no clerk user')}
            </span>
            <ReasonAction
              label="Resync Clerk"
              requireReason={false}
              onSubmit={async (reason) => {
                const result = await resync({ driverId: d._id, reason: reason || undefined });
                if (!result.success) throw new Error(result.error ?? 'Resync failed');
              }}
            />
          </div>
        ))
      )}
    </div>
  );
}

function IdentityLinksPanel({
  links,
}: {
  links: {
    _id: Id<'userIdentityLinks'>;
    clerkUserId: string;
    role: string;
    phone?: string;
    email?: string;
  }[];
}) {
  const updatePhone = useMutation(api.platform.support.updateIdentityLinkPhone);
  const deleteLink = useMutation(api.platform.support.deleteIdentityLink);

  if (links.length === 0) return null;
  return (
    <div className="panel">
      <h2>Identity link actions</h2>
      {links.map((l) => (
        <div className="audit-row" key={l._id}>
          <span className="chip">{l.role}</span>
          <span>{l.phone ?? l.email ?? l.clerkUserId}</span>
          <ReasonAction
            label="Change phone"
            danger
            onSubmit={async (reason, form) => {
              const phone = String(new FormData(form).get('phone') ?? '').trim();
              if (!phone) throw new Error('Phone is required');
              await updatePhone({ linkId: l._id, phone, reason });
            }}
          >
            <input className="input" name="phone" placeholder="+1555…" />
          </ReasonAction>
          <ReasonAction
            label="Unlink"
            danger
            onSubmit={async (reason) => {
              await deleteLink({ linkId: l._id, reason });
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function BillingConfigPanel({
  organizationId,
  current,
}: {
  organizationId: Id<'organizations'>;
  current: {
    billingRatePerLoad?: number | null;
    rateSchedule?: { effectiveFromPeriod: string; ratePerLoad: number }[] | null;
    billingTerms?: { kind: 'net'; days: number } | { kind: 'dayOfMonth'; day: number } | null;
    taxRatePercent?: number | null;
    taxJurisdiction?: string | null;
    minimumMonthlyCharge?: number | null;
  };
}) {
  const update = useMutation(api.platform.invoices.updateBillingConfig);
  const pendingStep = (current.rateSchedule ?? [])
    .slice()
    .sort((a, b) => a.effectiveFromPeriod.localeCompare(b.effectiveFromPeriod))
    .at(-1);

  return (
    <div className="panel">
      <h2>Billing configuration</h2>
      <div className="detail-grid">
        <span className="muted">Current rate</span>
        <span>
          {current.billingRatePerLoad != null ? `$${current.billingRatePerLoad.toFixed(2)}/load` : 'default'}
          {pendingStep ? (
            <span className="muted">
              {' '}
              → ${pendingStep.ratePerLoad.toFixed(2)} from {pendingStep.effectiveFromPeriod}
            </span>
          ) : null}
        </span>
        <span className="muted">Terms</span>
        <span>
          {current.billingTerms
            ? current.billingTerms.kind === 'net'
              ? `net-${current.billingTerms.days}`
              : `due on day ${current.billingTerms.day}`
            : 'net-15 (default)'}
        </span>
        <span className="muted">Tax</span>
        <span>
          {current.taxRatePercent != null
            ? `${current.taxRatePercent}% (${current.taxJurisdiction ?? 'no jurisdiction'})`
            : 'not configured — invoices state "tax not included"'}
        </span>
        <span className="muted">Monthly minimum</span>
        <span>{current.minimumMonthlyCharge != null ? `$${current.minimumMonthlyCharge.toFixed(2)}` : 'none'}</span>
      </div>
      <ReasonAction
        label="Update billing config"
        danger
        onSubmit={async (reason, form) => {
          const data = new FormData(form);
          const num = (name: string) => {
            const raw = String(data.get(name) ?? '').trim();
            if (!raw) return undefined;
            const n = Number(raw);
            if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
            return n;
          };
          const rate = num('rate');
          const termsKind = String(data.get('termsKind') ?? '');
          const termsValue = num('termsValue');
          const tax = num('tax');
          const minimum = num('minimum');
          await update({
            organizationId,
            ...(rate !== undefined ? { ratePerLoadNextCycle: rate } : {}),
            ...(termsKind && termsValue !== undefined
              ? {
                  billingTerms:
                    termsKind === 'net'
                      ? { kind: 'net' as const, days: termsValue }
                      : { kind: 'dayOfMonth' as const, day: termsValue },
                }
              : {}),
            ...(tax !== undefined ? { taxRatePercent: tax } : {}),
            ...(minimum !== undefined ? { minimumMonthlyCharge: minimum } : {}),
            reason,
          });
        }}
      >
        <input className="input" name="rate" placeholder="Rate/load (next cycle)" />
        <select className="input" name="termsKind" defaultValue="">
          <option value="">terms unchanged</option>
          <option value="net">net-N days</option>
          <option value="dayOfMonth">due day of month</option>
        </select>
        <input className="input" name="termsValue" placeholder="N (days or day)" />
        <input className="input" name="tax" placeholder="Tax % (e.g. 8.25)" />
        <input className="input" name="minimum" placeholder="Monthly minimum $" />
      </ReasonAction>
    </div>
  );
}

function DangerZone({
  organizationId,
  orgName,
  isDeleted,
}: {
  organizationId: Id<'organizations'>;
  orgName: string;
  isDeleted: boolean;
}) {
  const softDelete = useMutation(api.platform.support.softDeleteOrg);
  const restore = useMutation(api.platform.support.restoreOrg);

  return (
    <div className="panel panel-danger">
      <h2>Danger zone</h2>
      {isDeleted ? (
        <ReasonAction
          label="Restore organization"
          onSubmit={async (reason) => {
            await restore({ organizationId, reason });
          }}
        />
      ) : (
        <ReasonAction
          label="Soft-delete organization"
          danger
          confirmText={orgName}
          onSubmit={async (reason) => {
            await softDelete({ organizationId, reason });
          }}
        />
      )}
    </div>
  );
}
