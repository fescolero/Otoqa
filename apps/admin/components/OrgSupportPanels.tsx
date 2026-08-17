'use client';

import { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '@otoqa/convex-client';
import type { Id } from '@otoqa/convex-client';
import { formatAgo, formatMoney, formatWhen } from '@/lib/format';
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
          <CreditsPanel workosOrgId={workosOrgId} />
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
  const correctPhone = useMutation(api.platform.support.correctDriverPhone);

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
            {/* The driver row's phone is what the driver app authenticates
                against — distinct from the identity link's phone below, and
                the two can genuinely disagree. */}
            <ReasonAction
              label="Fix phone"
              danger
              onSubmit={async (reason, form) => {
                const phone = String(new FormData(form).get('phone') ?? '').trim();
                if (!phone) throw new Error('Phone is required');
                await correctPhone({ driverId: d._id, phone, reason });
              }}
            >
              <input className="input" name="phone" placeholder="+1555…" />
            </ReasonAction>
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

/**
 * The rate schedule as an editable list rather than a one-way "next cycle"
 * field. Back-dating is allowed by the backend when nothing from that period
 * on is billed; when it isn't, the error names the periods that block it.
 */
export function RateSchedulePanel({
  organizationId,
  schedule,
  currentRate,
}: {
  organizationId: Id<'organizations'>;
  schedule: { effectiveFromPeriod: string; ratePerLoad: number }[];
  currentRate?: number | null;
}) {
  const setStep = useMutation(api.platform.invoices.setRateStep);
  const removeStep = useMutation(api.platform.invoices.removeRateStep);
  const sorted = [...schedule].sort((a, b) =>
    a.effectiveFromPeriod.localeCompare(b.effectiveFromPeriod),
  );

  return (
    <div className="panel">
      <h2>Rate schedule</h2>
      <p className="subtitle">
        Base rate {currentRate != null ? `$${currentRate.toFixed(2)}` : 'platform default'} unless a
        step below covers the cycle. A step applies from its period onward, so it can only be added
        or removed while no invoice from that period on has been committed.
      </p>
      {sorted.length === 0 ? (
        <div className="empty">No scheduled steps — every cycle bills at the base rate.</div>
      ) : (
        sorted.map((step) => (
          <div className="audit-row" key={step.effectiveFromPeriod}>
            <span className="action">{step.effectiveFromPeriod} onward</span>
            <span>${step.ratePerLoad.toFixed(2)}/load</span>
            <ReasonAction
              label="Remove"
              danger
              onSubmit={async (reason) => {
                await removeStep({
                  organizationId,
                  effectiveFromPeriod: step.effectiveFromPeriod,
                  reason,
                });
              }}
            />
          </div>
        ))
      )}
      <ReasonAction
        label="Set a rate step"
        danger
        onSubmit={async (reason, form) => {
          const data = new FormData(form);
          const effectiveFromPeriod = String(data.get('period') ?? '').trim();
          const ratePerLoad = Number(data.get('rate'));
          if (!effectiveFromPeriod) throw new Error('Period is required (YYYY-MM)');
          if (!Number.isFinite(ratePerLoad) || ratePerLoad <= 0) {
            throw new Error('Rate must be a positive number');
          }
          await setStep({ organizationId, effectiveFromPeriod, ratePerLoad, reason });
        }}
      >
        <input className="input" name="period" placeholder="From period (YYYY-MM)" />
        <input className="input" name="rate" placeholder="Rate/load" />
      </ReasonAction>
    </div>
  );
}

/** Org credit balance + the ledger behind it. */
export function CreditsPanel({ workosOrgId }: { workosOrgId: string }) {
  const balance = useQuery(api.platform.credits.creditBalance, { workosOrgId });
  const credits = useQuery(api.platform.credits.listCredits, { workosOrgId });
  const createCredit = useMutation(api.platform.credits.createCredit);
  const voidCredit = useMutation(api.platform.credits.voidCredit);

  return (
    <div className="panel">
      <h2>
        Account credit{' '}
        {balance ? <span className="chip chip-ok">${balance.available.toFixed(2)} available</span> : null}
      </h2>
      <p className="subtitle">
        Applied automatically to the balance when the next invoice is issued — never to the taxable
        subtotal. Overpayments post here on their own.
      </p>
      {credits === undefined ? (
        <div className="empty">Loading…</div>
      ) : credits.length === 0 ? (
        <div className="empty">No credits on this account.</div>
      ) : (
        credits.map((c) => (
          <div className="audit-row" key={c._id}>
            <span
              className={`chip ${
                c.status === 'available' ? 'chip-ok' : c.status === 'void' ? 'chip-danger' : ''
              }`}
            >
              {c.status}
            </span>
            <span className="action">{c.source.replace('_', ' ')}</span>
            <span>
              ${c.amount.toFixed(2)}
              {c.remaining !== c.amount ? ` (${c.remaining.toFixed(2)} left)` : ''}
            </span>
            <span className="muted">{c.reason}</span>
            {c.applications.length > 0 ? (
              <span className="muted">
                → {c.applications.map((a) => a.invoiceNumber).join(', ')}
              </span>
            ) : null}
            <span className="muted">{formatAgo(c.createdAt)}</span>
            {c.status === 'available' && c.applications.length === 0 ? (
              <ReasonAction
                label="Void"
                danger
                onSubmit={async (reason) => {
                  await voidCredit({ creditId: c._id, reason });
                }}
              />
            ) : null}
          </div>
        ))
      )}
      <ReasonAction
        label="Issue a credit"
        danger
        onSubmit={async (reason, form) => {
          const data = new FormData(form);
          const amount = Number(data.get('amount'));
          if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a positive amount');
          const raw = String(data.get('createdAt') ?? '').trim();
          const createdAt = raw ? Date.parse(`${raw}T12:00:00Z`) : undefined;
          if (createdAt !== undefined && Number.isNaN(createdAt)) {
            throw new Error('Enter the date as YYYY-MM-DD');
          }
          await createCredit({
            workosOrgId,
            amount,
            source: data.get('source') as 'goodwill' | 'dispute' | 'service_credit' | 'manual',
            ...(createdAt !== undefined ? { createdAt } : {}),
            reason,
          });
        }}
      >
        <input className="input" name="amount" placeholder="Amount $" />
        <select className="input" name="source" defaultValue="goodwill">
          <option value="goodwill">Goodwill</option>
          <option value="dispute">Dispute</option>
          <option value="service_credit">Service credit (SLA)</option>
          <option value="manual">Manual</option>
        </select>
        <input className="input" type="date" name="createdAt" title="Date the credit arose (blank = today)" />
      </ReasonAction>
    </div>
  );
}

/**
 * One transfer, split across whatever is open — the arrears case. Shows what is
 * outstanding before, and exactly where the money landed after.
 */
export function AllocatePaymentPanel({ workosOrgId }: { workosOrgId: string }) {
  const invoices = useQuery(api.platform.invoices.listInvoices, { workosOrgId });
  const allocate = useMutation(api.platform.invoices.allocatePayment);
  const allocateCredit = useMutation(api.platform.invoices.allocateCredit);
  const [creditResult, setCreditResult] = useState<string | null>(null);
  const [result, setResult] = useState<{
    applied: { invoiceNumber: string; periodKey: string; amount: number; status: string }[];
    creditPosted: number;
  } | null>(null);

  const open = (invoices ?? [])
    .filter(
      (i) =>
        i.status === 'issued' || i.status === 'sent' || i.status === 'partially_paid',
    )
    .map((i) => ({ ...i, balance: Math.round((i.total - i.amountPaid) * 100) / 100 }))
    .filter((i) => i.balance > 0)
    .sort(
      (a, b) =>
        (a.dueAt ?? a.issuedAt ?? 0) - (b.dueAt ?? b.issuedAt ?? 0) ||
        a.periodKey.localeCompare(b.periodKey),
    );
  const owed = Math.round(open.reduce((s, i) => s + i.balance, 0) * 100) / 100;

  return (
    <div className="panel">
      <h2>Record a payment across invoices</h2>
      <p className="subtitle">
        Settles the oldest due invoice first and works forward. Anything beyond what is owed
        becomes account credit and applies to the next invoice issued.
      </p>

      {invoices === undefined ? (
        <div className="empty">Loading…</div>
      ) : open.length === 0 ? (
        <div className="empty">Nothing outstanding — a payment here would post entirely as credit.</div>
      ) : (
        <>
          <div className="audit-row">
            <span className="chip chip-warn">{open.length} open</span>
            <strong>{formatMoney(owed)} outstanding</strong>
            <span className="muted">in the order it will be applied:</span>
          </div>
          {open.map((i) => (
            <div className="audit-row" key={i._id}>
              <span className="action">{i.invoiceNumber}</span>
              <span className="muted">{i.periodKey}</span>
              <span>{formatMoney(i.balance)}</span>
              <span className="muted">
                {i.dueAt ? `due ${formatWhen(i.dueAt)}` : 'no due date'}
              </span>
            </div>
          ))}
        </>
      )}

      {result ? (
        <div className="panel panel-attention">
          <h2>Allocated</h2>
          {result.applied.map((a) => (
            <div className="audit-row" key={a.invoiceNumber}>
              <span className="chip chip-ok">{a.status.replace('_', ' ')}</span>
              <span className="action">{a.invoiceNumber}</span>
              <span className="muted">{a.periodKey}</span>
              <span>{formatMoney(a.amount)}</span>
            </div>
          ))}
          {result.creditPosted > 0 ? (
            <div className="audit-row">
              <span className="chip chip-ok">credit</span>
              <span>
                {formatMoney(result.creditPosted)} beyond what was owed — posted to account credit.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Credit is never swept in automatically — spending a customer's
          balance is a decision, so it gets its own button. */}
      <ReasonAction
        label="Apply credit across invoices"
        onSubmit={async (reason, form) => {
          const raw = String(new FormData(form).get('creditAmount') ?? '').trim();
          const amount = raw === '' ? undefined : Number(raw);
          if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
            throw new Error('Enter a positive amount, or leave blank to use all of it');
          }
          const outcome = await allocateCredit({
            workosOrgId,
            ...(amount !== undefined ? { amount } : {}),
            reason,
          });
          setCreditResult(
            `Applied to ${outcome.applied.length} invoice(s). Still owed ${formatMoney(
              outcome.stillOwed,
            )}; credit remaining ${formatMoney(outcome.creditRemaining)}.`,
          );
        }}
      >
        <input
          className="input"
          name="creditAmount"
          placeholder="Amount (blank = all available credit)"
        />
      </ReasonAction>
      {creditResult ? <p className="muted">{creditResult}</p> : null}

      <ReasonAction
        label="Record payment"
        onSubmit={async (reason, form) => {
          const data = new FormData(form);
          const amount = Number(data.get('amount'));
          if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a positive amount');
          const raw = String(data.get('receivedAt') ?? '').trim();
          const receivedAt = raw ? Date.parse(`${raw}T12:00:00Z`) : undefined;
          if (receivedAt !== undefined && Number.isNaN(receivedAt)) {
            throw new Error('Enter the date as YYYY-MM-DD');
          }
          const outcome = await allocate({
            workosOrgId,
            amount,
            method: data.get('method') as 'ach' | 'check' | 'wire' | 'other',
            reference: String(data.get('reference') ?? '') || undefined,
            ...(receivedAt !== undefined ? { receivedAt } : {}),
            reason,
          });
          setResult(outcome);
        }}
      >
        <input className="input" name="amount" placeholder={`Amount (owed ${formatMoney(owed)})`} />
        <select className="input" name="method" defaultValue="wire">
          <option value="wire">Wire</option>
          <option value="ach">ACH</option>
          <option value="check">Check</option>
          <option value="other">Other</option>
        </select>
        <input className="input" name="reference" placeholder="Reference / check #" />
        <input className="input" type="date" name="receivedAt" title="Date received" />
      </ReasonAction>
    </div>
  );
}

/** Contract/commercial fields — previously display-only on this page. */
export function ContractPanel({
  organizationId,
  current,
}: {
  organizationId: Id<'organizations'>;
  current: {
    billingEmail?: string;
    billingContactName?: string | null;
    billingPhone?: string | null;
    platformContractNumber?: string | null;
    platformLicenseStart?: string | null;
    platformLicenseEnd?: string | null;
  };
}) {
  const update = useMutation(api.platform.invoices.updateContract);
  const expired =
    current.platformLicenseEnd != null &&
    current.platformLicenseEnd < new Date().toISOString().slice(0, 10);

  return (
    <div className="panel">
      <h2>Contract</h2>
      <div className="detail-grid">
        <span className="muted">Billing contact</span>
        <span>
          {current.billingContactName ?? '—'} · {current.billingEmail ?? '—'}
          {current.billingPhone ? ` · ${current.billingPhone}` : ''}
        </span>
        <span className="muted">Contract number</span>
        <span>{current.platformContractNumber ?? '—'}</span>
        <span className="muted">License window</span>
        <span>
          {current.platformLicenseStart ?? '—'} → {current.platformLicenseEnd ?? '—'}
          {expired ? <span className="chip chip-warn">expired</span> : null}
        </span>
      </div>
      <ReasonAction
        label="Edit contract"
        onSubmit={async (reason, form) => {
          const data = new FormData(form);
          const text = (name: string) => {
            const raw = String(data.get(name) ?? '').trim();
            return raw === '' ? undefined : raw;
          };
          const email = text('billingEmail');
          await update({
            organizationId,
            ...(email !== undefined ? { billingEmail: email } : {}),
            ...(text('contactName') !== undefined ? { billingContactName: text('contactName') } : {}),
            ...(text('contractNumber') !== undefined
              ? { platformContractNumber: text('contractNumber') }
              : {}),
            ...(text('licenseStart') !== undefined
              ? { platformLicenseStart: text('licenseStart') }
              : {}),
            ...(text('licenseEnd') !== undefined ? { platformLicenseEnd: text('licenseEnd') } : {}),
            reason,
          });
        }}
      >
        <input className="input" name="billingEmail" placeholder="Billing email" />
        <input className="input" name="contactName" placeholder="Billing contact name" />
        <input className="input" name="contractNumber" placeholder="Contract number" />
        <input className="input" name="licenseStart" placeholder="License start (YYYY-MM-DD)" />
        <input className="input" name="licenseEnd" placeholder="License end (YYYY-MM-DD)" />
      </ReasonAction>
    </div>
  );
}

/** One-off charges: onboarding, services, hardware. */
export function ManualInvoicePanel({
  organizationId,
}: {
  organizationId: Id<'organizations'>;
}) {
  const create = useMutation(api.platform.invoices.createManualInvoice);
  const thisPeriod = new Date().toISOString().slice(0, 7);

  return (
    <div className="panel">
      <h2>One-off invoice</h2>
      <p className="subtitle">
        For anything that isn&apos;t metered usage. Lands in the same ledger as a draft and follows
        the same lifecycle; it never collides with the cycle&apos;s invoice.
      </p>
      <ReasonAction
        label="Raise a one-off invoice"
        onSubmit={async (reason, form) => {
          const data = new FormData(form);
          const label = String(data.get('label') ?? '').trim();
          const amount = Number(data.get('amount'));
          const periodKey = String(data.get('period') ?? '').trim() || thisPeriod;
          if (!label) throw new Error('A line label is required');
          if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a positive amount');
          await create({ organizationId, periodKey, lines: [{ label, amount }], reason });
        }}
      >
        <input className="input" name="label" placeholder="Line description" />
        <input className="input" name="amount" placeholder="Amount $" />
        <input className="input" name="period" placeholder={`Period (default ${thisPeriod})`} />
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
