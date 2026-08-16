'use client';

import { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { formatMoney, formatWhen } from '@/lib/format';
import { ReasonAction } from '@/components/ReasonAction';

/**
 * A date input gives 'YYYY-MM-DD'. Midday UTC, not midnight, so the date the
 * operator typed is the date every timezone renders back.
 */
function dateToMs(value: FormDataEntryValue | null): number | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const ms = Date.parse(`${raw}T12:00:00Z`);
  if (Number.isNaN(ms)) throw new Error('Enter the date as YYYY-MM-DD');
  return ms;
}

type InvoiceStatus =
  | 'draft'
  | 'issued'
  | 'sent'
  | 'partially_paid'
  | 'paid'
  | 'written_off'
  | 'void';
const FILTERS: (InvoiceStatus | 'all')[] = [
  'all',
  'draft',
  'issued',
  'sent',
  'partially_paid',
  'paid',
  'written_off',
  'void',
];

export function InvoicesBoard() {
  const aging = useQuery(api.platform.invoices.agingOverview, {});
  const [filter, setFilter] = useState<InvoiceStatus | 'all'>('all');
  const invoices = useQuery(
    api.platform.invoices.listInvoices,
    filter === 'all' ? {} : { status: filter },
  );

  return (
    <>
      {aging ? (
        <div className="kpi-row">
          <Kpi label="Outstanding" value={formatMoney(aging.outstanding)} />
          <Kpi label="Current" value={formatMoney(aging.buckets.current)} />
          <Kpi label="1–30 overdue" value={formatMoney(aging.buckets.d1_30)} danger={aging.buckets.d1_30 > 0} />
          <Kpi
            label="31+ overdue"
            value={formatMoney(aging.buckets.d31_60 + aging.buckets.d61_90 + aging.buckets.d90_plus)}
            danger={aging.buckets.d31_60 + aging.buckets.d61_90 + aging.buckets.d90_plus > 0}
          />
          <Kpi label="Drafts awaiting review" value={String(aging.draftCount)} />
          {aging.creditAvailable > 0 ? (
            <Kpi label="Credit owed to orgs" value={formatMoney(aging.creditAvailable)} />
          ) : null}
          {aging.writtenOffCount > 0 ? (
            <Kpi
              label={`Written off (${aging.writtenOffCount})`}
              value={formatMoney(aging.writtenOffAmount)}
            />
          ) : null}
          {aging.driftCount > 0 ? <Kpi label="Drift flags" value={String(aging.driftCount)} danger /> : null}
        </div>
      ) : null}

      <LedgerGaps />

      <div className="chip-row">
        {FILTERS.map((s) => (
          <button
            key={s}
            className={`chip chip-button${filter === s ? ' chip-ok' : ''}`}
            onClick={() => setFilter(s)}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="panel">
        <h2>Invoices</h2>
        {invoices === undefined ? (
          <div className="empty">Loading…</div>
        ) : invoices.length === 0 ? (
          <div className="empty">
            No invoices{filter !== 'all' ? ` with status ${filter}` : ''} — cycle close runs on
            the 2nd, or run the backfill for history.
          </div>
        ) : (
          invoices.map((inv) => <InvoiceRow key={inv._id} inv={inv} />)
        )}
      </div>
    </>
  );
}

/**
 * Invoices that claim money they can't evidence: `amountPaid` above the sum of
 * their payment entries. Historical backfill rows are the usual source — they
 * were created paid with an empty ledger — as is anything settled before the
 * console could record payments.
 */
function LedgerGaps() {
  const gaps = useQuery(api.platform.invoices.paymentLedgerGaps, {});
  if (gaps === undefined || gaps.length === 0) return null;

  return (
    <div className="panel panel-attention">
      <h2>Payments without a record ({gaps.length})</h2>
      <p className="subtitle">
        These are marked paid but carry no matching payment entry, so there is nothing to
        reconcile against a bank statement and nothing to reverse. Open the invoice and use
        <strong> Document payment</strong> to fill in how and when the money arrived — it records
        the payment without changing what was paid.
      </p>
      {gaps.map((g) => (
        <div className="audit-row" key={g._id}>
          <span className="chip">{g.status.replace('_', ' ')}</span>
          <strong>{g.invoiceNumber}</strong>
          <span className="muted">{g.workosOrgId}</span>
          <span className="muted">{g.periodKey}</span>
          <span>
            {formatMoney(g.amountPaid)} paid · {formatMoney(g.documented)} documented
          </span>
          <span className="danger-text">{formatMoney(g.undocumented)} unaccounted</span>
          {g.backfilled ? <span className="chip">backfilled</span> : null}
        </div>
      ))}
    </div>
  );
}

function InvoiceRow({
  inv,
}: {
  inv: NonNullable<ReturnType<typeof useQuery<typeof api.platform.invoices.listInvoices>>>[number];
}) {
  const issue = useMutation(api.platform.invoices.issueInvoice);
  const markSent = useMutation(api.platform.invoices.markSent);
  const recordPayment = useMutation(api.platform.invoices.recordPayment);
  const voidInvoice = useMutation(api.platform.invoices.voidInvoice);
  const reversePayment = useMutation(api.platform.invoices.reversePayment);
  const writeOff = useMutation(api.platform.invoices.writeOffInvoice);
  const addAdjustment = useMutation(api.platform.invoices.addAdjustment);
  const updateAdjustment = useMutation(api.platform.invoices.updateAdjustment);
  const removeAdjustment = useMutation(api.platform.invoices.removeAdjustment);
  const updateManualLines = useMutation(api.platform.invoices.updateManualLines);
  const refreshDraft = useMutation(api.platform.invoices.refreshDraft);
  const deleteDraft = useMutation(api.platform.invoices.deleteDraft);
  const documentPayment = useMutation(api.platform.invoices.documentPayment);
  const pushToStripe = useAction(api.platform.stripe.pushInvoiceToStripe);
  const [expanded, setExpanded] = useState(false);

  const balance = Math.round((inv.total - inv.amountPaid) * 100) / 100;
  const isDraft = inv.status === 'draft';
  // Paid past the total: the excess was posted to the org's credit balance.
  const overpaid = Math.round((inv.amountPaid - inv.total) * 100) / 100;
  // Money the invoice claims but cannot evidence — see the ledger-gaps panel.
  const documented =
    Math.round(inv.payments.reduce((sum, p) => sum + p.amount, 0) * 100) / 100;
  const undocumented = Math.round((inv.amountPaid - documented) * 100) / 100;
  const isManual = inv.kind === 'manual';
  const isOpen =
    inv.status === 'issued' || inv.status === 'sent' || inv.status === 'partially_paid';
  const overdue = isOpen && balance > 0 && inv.dueAt != null && Date.now() > inv.dueAt;

  return (
    <div className="ticket-row">
      <div className="audit-row">
        <span
          className={`chip ${
            inv.status === 'paid'
              ? 'chip-ok'
              : inv.status === 'void' || inv.status === 'written_off'
                ? ''
                : overdue
                  ? 'chip-danger'
                  : 'chip-warn'
          }`}
        >
          {overdue ? 'overdue' : inv.status.replace('_', ' ')}
        </span>
        <strong>{inv.invoiceNumber}</strong>
        <span className="muted">{inv.workosOrgId}</span>
        <span>{inv.periodKey}</span>
        <span>{formatMoney(inv.total)}</span>
        {balance > 0 && inv.status !== 'draft' && inv.status !== 'void' ? (
          <span className="muted">balance {formatMoney(balance)}</span>
        ) : null}
        {overpaid > 0 ? (
          <span className="chip chip-ok">+{formatMoney(overpaid)} credited</span>
        ) : null}
        {inv.driftDetectedAt ? <span className="chip chip-danger">drift</span> : null}
        {inv.backfilled ? <span className="chip">backfilled</span> : null}
        <button className="button button-sm" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Hide' : 'Detail'}
        </button>
      </div>

      {expanded ? (
        <div className="invoice-detail">
          {inv.lines.map((l, i) => (
            <div className="audit-row" key={i}>
              <span className="chip">{l.kind}</span>
              <span>{l.label}</span>
              <span>{formatMoney(l.amount)}</span>
            </div>
          ))}
          {inv.adjustments.map((a, i) => (
            <div className="audit-row" key={`adj-${i}`}>
              <span className="chip chip-warn">adjustment</span>
              <span>
                {a.label} <span className="muted">({a.reason} — {a.addedByEmail})</span>
              </span>
              <span>{formatMoney(a.amountDelta)}</span>
              {/* Drafts are working documents: a mistyped adjustment is fixed
                  in place. Once issued these controls disappear. */}
              {isDraft ? (
                <>
                  <ReasonAction
                    label="Edit"
                    onSubmit={async (reason, form) => {
                      const data = new FormData(form);
                      const label = String(data.get('label') ?? '').trim();
                      const raw = String(data.get('amountDelta') ?? '').trim();
                      const amountDelta = raw === '' ? undefined : Number(raw);
                      if (amountDelta !== undefined && !Number.isFinite(amountDelta)) {
                        throw new Error('Amount must be a number');
                      }
                      await updateAdjustment({
                        id: inv._id,
                        index: i,
                        ...(label ? { label } : {}),
                        ...(amountDelta !== undefined ? { amountDelta } : {}),
                        reason,
                      });
                    }}
                  >
                    <input className="input" name="label" defaultValue={a.label} placeholder="Label" />
                    <input
                      className="input"
                      name="amountDelta"
                      defaultValue={String(a.amountDelta)}
                      placeholder="Amount (± USD)"
                    />
                  </ReasonAction>
                  <ReasonAction
                    label="Remove"
                    danger
                    onSubmit={async (reason) => {
                      await removeAdjustment({ id: inv._id, index: i, reason });
                    }}
                  />
                </>
              ) : null}
            </div>
          ))}
          {inv.taxAmount != null ? (
            <div className="audit-row">
              <span className="chip">tax</span>
              <span>
                {inv.taxJurisdiction ?? ''} {inv.taxRatePercent}%
              </span>
              <span>{formatMoney(inv.taxAmount)}</span>
            </div>
          ) : null}
          {inv.payments.map((p, i) => {
            const isReversal = p.reversalOfId !== undefined;
            // A payment that has been reversed stays on the record, greyed —
            // the ledger is append-only, so the mistake is part of the story.
            const wasReversed = inv.payments.some(
              (other) => other.reversalOfId === (p.id ?? `idx:${i}`),
            );
            return (
              <div className="audit-row" key={`pay-${i}`}>
                <span className={`chip ${isReversal ? 'chip-warn' : wasReversed ? '' : 'chip-ok'}`}>
                  {isReversal ? 'reversal' : 'payment'}
                </span>
                <span className={wasReversed ? 'muted' : undefined}>
                  {p.method}
                  {p.reference ? ` ${p.reference}` : ''}{' '}
                  <span className="muted">
                    {formatWhen(p.receivedAt)} by {p.recordedByEmail}
                    {p.reversalReason ? ` — ${p.reversalReason}` : ''}
                  </span>
                </span>
                <span className={wasReversed ? 'muted' : undefined}>{formatMoney(p.amount)}</span>
                {!isReversal && !wasReversed && p.method !== 'credit' ? (
                  <ReasonAction
                    label="Reverse"
                    danger
                    onSubmit={async (reason) => {
                      await reversePayment({ id: inv._id, paymentIndex: i, reason });
                    }}
                  />
                ) : null}
              </div>
            );
          })}

          {undocumented > 0 ? (
            <div className="audit-row">
              <span className="chip chip-warn">no record</span>
              <span>
                {formatMoney(undocumented)} of the {formatMoney(inv.amountPaid)} paid has no
                payment entry behind it.
              </span>
              <ReasonAction
                label="Document payment"
                onSubmit={async (reason, form) => {
                  const data = new FormData(form);
                  const amount = Number(data.get('amount'));
                  if (!Number.isFinite(amount) || amount <= 0) {
                    throw new Error('Enter a positive amount');
                  }
                  await documentPayment({
                    id: inv._id,
                    amount,
                    method: data.get('method') as 'ach' | 'check' | 'wire' | 'credit' | 'other',
                    reference: String(data.get('reference') ?? '') || undefined,
                    ...(dateToMs(data.get('receivedAt')) !== undefined
                      ? { receivedAt: dateToMs(data.get('receivedAt')) }
                      : {}),
                    reason,
                  });
                }}
              >
                <input
                  className="input"
                  name="amount"
                  defaultValue={String(undocumented)}
                  placeholder={`Amount (max ${formatMoney(undocumented)})`}
                />
                <select className="input" name="method" defaultValue="ach">
                  <option value="ach">ACH</option>
                  <option value="check">Check</option>
                  <option value="wire">Wire</option>
                  <option value="credit">Credit</option>
                  <option value="other">Other</option>
                </select>
                <input className="input" name="reference" placeholder="Reference / check #" />
                <input className="input" type="date" name="receivedAt" title="Date received" />
              </ReasonAction>
            </div>
          ) : null}
          {overpaid > 0 ? (
            <div className="audit-row">
              <span className="chip chip-ok">credit</span>
              <span>
                Paid {formatMoney(inv.amountPaid)} against {formatMoney(inv.total)} — the extra{' '}
                {formatMoney(overpaid)} is on the organization&apos;s account credit and applies to
                the next invoice when it is issued.
              </span>
            </div>
          ) : null}
          {inv.writeOffReason ? (
            <p className="ticket-body muted">Written off: {inv.writeOffReason}</p>
          ) : null}
          {inv.voidReason ? <p className="ticket-body muted">Voided: {inv.voidReason}</p> : null}

          <div className="inline-form">
            {isDraft ? (
              <>
                {/* Leave the date blank to issue as of today. Set it when
                    recording work that was billed (or should have been) in the
                    past — terms run from it, so the due date and aging follow. */}
                <ReasonAction
                  label="Issue"
                  requireReason={false}
                  onSubmit={async (_reason, form) => {
                    const data = new FormData(form);
                    const issuedAt = dateToMs(data.get('issuedAt'));
                    const dueAt = dateToMs(data.get('dueAt'));
                    await issue({
                      id: inv._id,
                      ...(issuedAt !== undefined ? { issuedAt } : {}),
                      ...(dueAt !== undefined ? { dueAt } : {}),
                    });
                  }}
                >
                  <input className="input" type="date" name="issuedAt" title="Issue date (blank = today)" />
                  <input className="input" type="date" name="dueAt" title="Due date (blank = from terms)" />
                </ReasonAction>
                {/* Re-derive from the CURRENT rate schedule and usage — cycle
                    close runs on the 2nd, so a rate fixed afterwards would
                    otherwise leave the draft stale. Adjustments survive. */}
                {!isManual ? (
                  <ReasonAction
                    label="Refresh from usage"
                    onSubmit={async (reason) => {
                      await refreshDraft({ id: inv._id, reason });
                    }}
                  />
                ) : (
                  <ReasonAction
                    label="Edit line"
                    onSubmit={async (reason, form) => {
                      const data = new FormData(form);
                      const label = String(data.get('label') ?? '').trim();
                      const amount = Number(data.get('amount'));
                      if (!label) throw new Error('A line label is required');
                      if (!Number.isFinite(amount) || amount === 0) {
                        throw new Error('Enter a non-zero amount');
                      }
                      await updateManualLines({
                        id: inv._id,
                        lines: [{ label, amount }],
                        reason,
                      });
                    }}
                  >
                    <input
                      className="input"
                      name="label"
                      defaultValue={inv.lines[0]?.label ?? ''}
                      placeholder="Line description"
                    />
                    <input
                      className="input"
                      name="amount"
                      defaultValue={String(inv.lines[0]?.amount ?? '')}
                      placeholder="Amount $"
                    />
                  </ReasonAction>
                )}
                <ReasonAction
                  label="Delete draft"
                  danger
                  confirmText={inv.invoiceNumber}
                  onSubmit={async (reason) => {
                    await deleteDraft({ id: inv._id, reason });
                  }}
                />
                <ReasonAction
                  label="Add adjustment"
                  onSubmit={async (reason, form) => {
                    const data = new FormData(form);
                    const label = String(data.get('label') ?? '').trim();
                    const amountDelta = Number(data.get('amountDelta'));
                    if (!label || !Number.isFinite(amountDelta)) {
                      throw new Error('Label and a numeric amount are required');
                    }
                    await addAdjustment({ id: inv._id, label, amountDelta, reason });
                  }}
                >
                  <input className="input" name="label" placeholder="Label" />
                  <input className="input" name="amountDelta" placeholder="Amount (± USD)" />
                </ReasonAction>
              </>
            ) : null}
            {inv.status === 'issued' || inv.status === 'partially_paid' ? (
              <>
                <ReasonAction
                  label="Mark sent"
                  requireReason={false}
                  onSubmit={async () => {
                    await markSent({ id: inv._id });
                  }}
                />
                {!inv.stripeInvoiceId ? (
                  <ReasonAction
                    label="Push to Stripe"
                    requireReason={false}
                    onSubmit={async () => {
                      await pushToStripe({ id: inv._id });
                    }}
                  />
                ) : null}
              </>
            ) : null}
            {inv.stripeHostedInvoiceUrl ? (
              <a
                className="button button-sm"
                href={inv.stripeHostedInvoiceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Stripe invoice ↗
              </a>
            ) : null}
            {isOpen ? (
              <>
                <ReasonAction
                  label="Record payment"
                  requireReason={false}
                  onSubmit={async (_reason, form) => {
                    const data = new FormData(form);
                    const amount = Number(data.get('amount'));
                    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a positive amount');
                    await recordPayment({
                      id: inv._id,
                      amount,
                      method: data.get('method') as 'ach' | 'check' | 'wire' | 'other',
                      reference: String(data.get('reference') ?? '') || undefined,
                      // The date the money actually arrived, which is often
                      // not the date someone got around to recording it.
                      ...(dateToMs(data.get('receivedAt')) !== undefined
                        ? { receivedAt: dateToMs(data.get('receivedAt')) }
                        : {}),
                    });
                  }}
                >
                  <input className="input" name="amount" placeholder={`Amount (bal ${formatMoney(balance)})`} />
                  <select className="input" name="method" defaultValue="ach">
                    <option value="ach">ACH</option>
                    <option value="check">Check</option>
                    <option value="wire">Wire</option>
                    <option value="other">Other</option>
                  </select>
                  <input className="input" name="reference" placeholder="Reference / check #" />
                  <input className="input" type="date" name="receivedAt" title="Date received (blank = today)" />
                </ReasonAction>
                <ReasonAction
                  label="Void"
                  danger
                  onSubmit={async (reason) => {
                    await voidInvoice({ id: inv._id, reason });
                  }}
                />
                {balance > 0 ? (
                  <ReasonAction
                    label="Write off"
                    danger
                    onSubmit={async (reason) => {
                      await writeOff({ id: inv._id, reason });
                    }}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Kpi({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className={danger ? 'kpi kpi-danger' : 'kpi'}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}
