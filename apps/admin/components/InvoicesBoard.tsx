'use client';

import { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { formatMoney, formatWhen } from '@/lib/format';
import { ReasonAction } from '@/components/ReasonAction';

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
  const pushToStripe = useAction(api.platform.stripe.pushInvoiceToStripe);
  const [expanded, setExpanded] = useState(false);

  const balance = Math.round((inv.total - inv.amountPaid) * 100) / 100;
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

          {inv.writeOffReason ? (
            <p className="ticket-body muted">Written off: {inv.writeOffReason}</p>
          ) : null}
          {inv.voidReason ? <p className="ticket-body muted">Voided: {inv.voidReason}</p> : null}

          <div className="inline-form">
            {inv.status === 'draft' ? (
              <>
                <ReasonAction
                  label="Issue"
                  requireReason={false}
                  onSubmit={async () => {
                    await issue({ id: inv._id });
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
