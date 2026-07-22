/**
 * LoadPayPlanCard — inline pay-plan card for the load-detail Overview tab.
 *
 * Mirrors the design's `details-pay-plan.jsx`:
 *   - Compact card sitting at the bottom of the overview
 *   - Plan banner at top (active payProfile + rate summary), click to open modal
 *   - "Customer billing" group (invoice line items) with subtotal
 *   - "Driver pay" group (payItems where payeeType=DRIVER|CARRIER) with subtotal
 *   - Margin footer: revenue − pay (green if positive, red if negative)
 *   - Header actions: "Change plan" + "Add line" → both open PayAdjustmentsModal
 *
 * The full line-item editor (rate overrides, accessorial presets, audit-log
 * reason/note) lives in `PayAdjustmentsModal` as a separate file. This card
 * is read-only; every interactive affordance opens the modal.
 *
 * Driver/truck/trailer assignment was NOT part of this design — that belongs
 * in the "Assigned" card on the same overview tab.
 */

'use client';

import * as React from 'react';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { DSCard, WBtn, WIcon } from '@/components/web';
import { PayAdjustmentsModal } from './pay-adjustments-modal';

// ============================================================================
// Props
// ============================================================================

export interface LoadPayPlanCardProps {
  loadId: Id<'loadInformation'>;
  organizationId: string;
  userId: string;
}

// ============================================================================
// Component
// ============================================================================

export function LoadPayPlanCard({ loadId, organizationId, userId }: LoadPayPlanCardProps) {
  const [open, setOpen] = React.useState(false);

  const payPlanData = useAuthQuery(api.payItems.listForLoad, { loadId });
  const invoiceData = useAuthQuery(api.invoices.getInvoiceByLoad, { loadId });
  const invoiceLineItems = useAuthQuery(
    api.invoices.getLineItems,
    invoiceData?._id ? { invoiceId: invoiceData._id } : 'skip',
  );
  // Need to know who's actually assigned to the load so we can show the
  // pay plan banner even BEFORE pay items have been computed (right after
  // assignment, before the new engine has run). Without this the banner
  // read "No plan assigned" for every newly-assigned load.
  const loadDetails = useAuthQuery(api.loads.getByIdWithRange, { loadId });

  // Plan banner — derive the payee from one of three sources (in order):
  //   1. The first payee in payItems (most accurate once calc has run)
  //   2. The load's primaryDriverId cache (covers freshly-assigned loads)
  //   3. The load's primaryCarrierPartnershipId cache (carrier loads)
  // Whichever resolves first, look up that payee's pay profile assignments.
  const firstPayee = payPlanData?.payees[0];
  const fallbackPayee = firstPayee
    ? null
    : loadDetails?.primaryDriverId
      ? { payeeType: 'DRIVER' as const, payeeId: loadDetails.primaryDriverId }
      : loadDetails?.primaryCarrierPartnershipId
        ? { payeeType: 'CARRIER' as const, payeeId: loadDetails.primaryCarrierPartnershipId }
        : null;
  const planPayee = firstPayee
    ? { payeeType: firstPayee.payeeType, payeeId: firstPayee.payeeId }
    : fallbackPayee;
  const assignments = useQuery(
    api.payeeProfileAssignments.listForPayee,
    planPayee ? planPayee : 'skip',
  );
  const activePlan = (assignments ?? []).find(a => a.isDefault) ?? (assignments ?? [])[0] ?? null;

  // Load-level pay profile override. Engine precedence puts it above every
  // assignment (leg override → LOAD OVERRIDE → jurisdiction → distance →
  // default), so when set, every driver leg on this load pays off it.
  // includeInactive so an override pointing at a since-archived profile still
  // resolves for display (the engine falls through to default and warns).
  const driverProfiles = useAuthQuery(api.payProfiles.listForOrg, {
    workosOrgId: organizationId,
    includeInactive: true,
    payeeType: 'DRIVER',
  });
  const overrideId = loadDetails?.payProfileOverrideId ?? null;
  const overrideProfile = overrideId
    ? (driverProfiles ?? []).find(p => p._id === overrideId) ?? null
    : null;
  const setLoadOverride = useMutation(api.payProfiles.setLoadOverride);
  const [savingOverride, setSavingOverride] = React.useState(false);
  const handleOverrideChange = async (value: string) => {
    setSavingOverride(true);
    try {
      await setLoadOverride({
        loadId,
        profileId: value === 'auto' ? undefined : (value as Id<'payProfiles'>),
      });
      toast.success(
        value === 'auto'
          ? 'Override cleared — pay follows the driver’s assigned profile'
          : 'Pay profile override set — recalculating pay',
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update pay profile override');
    } finally {
      setSavingOverride(false);
    }
  };

  // Roll customer-billing rows into the simple shape this card displays.
  const billingLines: PayLine[] = React.useMemo(() => {
    if (!invoiceLineItems) return [];
    return invoiceLineItems.map(l => ({
      id: String(l._id),
      label: l.description,
      // The invoice doesn't yet track a calc-explanation string; if rate
      // ≠ amount we surface "quantity × rate" as the sub-line. Both qty and
      // rate are formatted with up to 2 decimals (trailing zeros stripped).
      calc: l.quantity > 1 ? `${formatQty(l.quantity)} × $${stripTrailingZeros(l.rate.toFixed(2))}` : undefined,
      amountCents: Math.round(l.amount * 100),
      locked: false,
    }));
  }, [invoiceLineItems]);
  const billingTotalCents = billingLines.reduce((s, l) => s + l.amountCents, 0);

  // Driver/Carrier pay lines — flatten every payee's items into one section.
  // For multi-payee loads the design hasn't been spec'd in detail; we render
  // them all under "Driver pay" but prefix the label with the payee name
  // when there's more than one payee.
  const payLines: PayLine[] = React.useMemo(() => {
    if (!payPlanData) return [];
    const showPayeePrefix = payPlanData.payees.length > 1;
    const out: PayLine[] = [];
    for (const p of payPlanData.payees) {
      for (const leg of p.legs) {
        for (const item of leg.items) {
          out.push({
            id: String(item._id),
            label: showPayeePrefix
              ? `${p.payeeName} — ${item.description || item.componentName}`
              : item.description || item.componentName,
            calc: item.quantity !== 1
              ? `${formatQty(item.quantity)} × ${formatRate(item.rateMicroCentsNumber)}`
              : undefined,
            amountCents: item.amountCentsNumber,
            // EARNING-kind items computed from rules render as "AUTO" (locked
            // by the calc engine). Manual adjustments are editable.
            locked: item.kind === 'EARNING' || item.kind === 'NEGOTIATED',
          });
        }
      }
    }
    return out;
  }, [payPlanData]);
  const payTotalCents = payPlanData?.totalCents ?? 0;

  const marginCents = billingTotalCents - payTotalCents;
  const marginPct = billingTotalCents > 0
    ? Math.round((marginCents / billingTotalCents) * 100)
    : 0;

  const loading = payPlanData === undefined || invoiceData === undefined;

  // Detect carrier-only vs driver loads — affects the second-section label
  const payeeKind = payPlanData?.payees[0]?.payeeType ?? 'DRIVER';
  const paySectionLabel = payeeKind === 'CARRIER' ? 'Carrier pay' : 'Driver pay';

  // Recalculate — needed for two reasons:
  //   1. Loads assigned BEFORE the auto-cascade fix in driverPayCalculation /
  //      carrierPayCalculation have no payItems; recalc backfills them.
  //   2. Stop times can change after the initial calc (driver checks in
  //      late, etc.); a manual recalc lets the dispatcher refresh.
  // Calls the legacy mutation per leg — that mutation now cascades to the
  // new engine via the scheduler.
  const legs = useAuthQuery(api.dispatchLegs.getByLoad, { loadId });
  const recalcDriver = useMutation(api.loadPayables.recalculate);
  const recalcCarrier = useMutation(api.loadCarrierPayables.recalculate);
  const [recalculating, setRecalculating] = React.useState(false);
  const handleRecalculate = async () => {
    if (!legs || legs.length === 0) {
      toast.error('This load has no dispatch legs to calculate.');
      return;
    }
    setRecalculating(true);
    try {
      let fired = 0;
      for (const leg of legs) {
        if (leg.carrierPartnershipId) {
          await recalcCarrier({ legId: leg._id, userId });
          fired++;
        } else if (leg.driverId) {
          await recalcDriver({ legId: leg._id, userId });
          fired++;
        }
      }
      if (fired === 0) {
        toast.error('No driver or carrier assigned — nothing to calculate.');
      } else {
        toast.success(
          fired === 1 ? 'Pay recalculated' : `Pay recalculated for ${fired} legs`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Recalculation failed');
    } finally {
      setRecalculating(false);
    }
  };

  return (
    <>
      <DSCard
        title="Pay plan"
        action={
          <div className="flex items-center gap-1.5">
            <WBtn
              size="sm"
              leading="refresh"
              onClick={handleRecalculate}
              disabled={recalculating}
            >
              {recalculating ? 'Recalculating…' : 'Recalculate'}
            </WBtn>
            <WBtn size="sm" leading="settings" onClick={() => setOpen(true)}>
              Change plan
            </WBtn>
            <WBtn size="sm" leading="plus" onClick={() => setOpen(true)}>
              Add line
            </WBtn>
          </div>
        }
      >
        {loading ? (
          <p className="text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
            Loading pay plan…
          </p>
        ) : (
          <>
            <PlanBanner
              planName={
                overrideProfile
                  ? overrideProfile.name
                  : (activePlan?.profileName ?? '— No plan assigned')
              }
              planSummary={
                overrideProfile
                  ? summarizeRules(overrideProfile.rules)
                  : summarizeRules(activePlan?.rules)
              }
              override={!!overrideProfile}
              onOpen={() => setOpen(true)}
            />

            {payeeKind !== 'CARRIER' && (
              <OverridePicker
                value={overrideId ?? 'auto'}
                saving={savingOverride}
                defaultLabel={
                  activePlan?.profileName
                    ? `Driver default (${activePlan.profileName})`
                    : 'Driver default (auto)'
                }
                profiles={(driverProfiles ?? [])
                  .filter(p => p.isActive || p._id === overrideId)
                  .map(p => ({
                    value: p._id,
                    label: p.isActive ? p.name : `${p.name} (archived)`,
                  }))}
                onChange={handleOverrideChange}
              />
            )}

            <PayLineGroup
              label="Customer billing"
              lines={billingLines}
              totalCents={billingTotalCents}
              onEdit={() => setOpen(true)}
              emptyText="No invoice line items yet."
            />

            <div style={{ height: 10 }} />

            <PayLineGroup
              label={paySectionLabel}
              lines={payLines}
              totalCents={payTotalCents}
              onEdit={() => setOpen(true)}
              emptyText="No pay items yet. Open to recalculate."
            />

            <MarginFooter
              marginCents={marginCents}
              marginPct={marginPct}
              hasBilling={billingTotalCents > 0}
            />
          </>
        )}
      </DSCard>

      {open && (
        <PayAdjustmentsModal
          loadId={loadId}
          organizationId={organizationId}
          userId={userId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

type PayLine = {
  id: string;
  label: string;
  calc?: string;
  amountCents: number;
  locked: boolean;
};

function PlanBanner({
  planName,
  planSummary,
  override,
  onOpen,
}: {
  planName: string;
  planSummary: string;
  override?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className="focus-ring w-full text-left"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 8,
        marginBottom: 10,
        border: '1px solid var(--border-hairline-strong)',
        background: 'var(--bg-surface-2)',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: 7,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(46,92,255,0.08)',
          color: '#1A47E6',
          flexShrink: 0,
        }}
      >
        <WIcon name="doc-dollar" size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
          <span className="truncate">{planName}</span>
          {override && (
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: 0.03,
                textTransform: 'uppercase',
                color: '#A66800',
                background: 'rgba(245,158,11,0.12)',
                padding: '1px 6px',
                borderRadius: 8,
                flexShrink: 0,
              }}
            >
              Override
            </span>
          )}
        </div>
        <div
          className="truncate"
          style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}
        >
          {planSummary}
        </div>
      </div>
      <WIcon name="chevron-right" size={12} />
    </button>
  );
}

/** Load-level pay profile override picker. "Auto" follows the driver's
 *  assigned profile; picking a profile pins every driver leg on this load
 *  to it (engine precedence: leg override → load override → assignments). */
function OverridePicker({
  value,
  saving,
  defaultLabel,
  profiles,
  onChange,
}: {
  value: string;
  saving: boolean;
  defaultLabel: string;
  profiles: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
      <span
        className="shrink-0"
        style={{
          fontSize: 10.5,
          fontWeight: 500,
          color: 'var(--text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        Pay profile
      </span>
      <div className="relative flex-1 min-w-0">
        <select
          value={value}
          disabled={saving}
          onChange={e => onChange(e.target.value)}
          className="appearance-none w-full cursor-pointer disabled:cursor-wait"
          style={{
            height: 28,
            padding: '0 26px 0 9px',
            borderRadius: 6,
            border: '1px solid var(--border-hairline-strong)',
            background: 'var(--bg-surface)',
            fontFamily: 'inherit',
            fontSize: 12,
            color: 'var(--text-primary)',
            opacity: saving ? 0.6 : 1,
          }}
        >
          <option value="auto">{defaultLabel}</option>
          {profiles.map(p => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <span
          className="absolute pointer-events-none"
          style={{ right: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }}
        >
          <WIcon name="chevron-down" size={11} />
        </span>
      </div>
    </div>
  );
}

function PayLineGroup({
  label,
  lines,
  totalCents,
  onEdit,
  emptyText,
}: {
  label: string;
  lines: PayLine[];
  totalCents: number;
  onEdit: () => void;
  emptyText: string;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 500,
          color: 'var(--text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 4,
        }}
      >
        <span>{label}</span>
        {lines.length > 0 && (
          <span>
            {lines.length} line{lines.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {lines.length === 0 ? (
        <div
          className="text-[12px] italic"
          style={{ color: 'var(--text-tertiary)', padding: '6px 4px' }}
        >
          {emptyText}
        </div>
      ) : (
        <div className="flex flex-col">
          {lines.map((l, i) => (
            <PayLineRow key={l.id} line={l} first={i === 0} onEdit={onEdit} />
          ))}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          padding: '6px 0 0',
          borderTop: '1px solid var(--border-hairline)',
          marginTop: 4,
        }}
      >
        <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>Subtotal</span>
        <span
          className="num"
          style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}
        >
          {formatCents(totalCents)}
        </span>
      </div>
    </div>
  );
}

function PayLineRow({
  line,
  first,
  onEdit,
}: {
  line: PayLine;
  first: boolean;
  onEdit: () => void;
}) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onEdit}
      role="button"
      tabIndex={0}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto auto',
        gap: 10,
        alignItems: 'baseline',
        padding: '6px 4px',
        borderTop: first ? 0 : '1px solid var(--border-hairline)',
        cursor: line.locked ? 'default' : 'pointer',
        background: hover && !line.locked ? 'var(--bg-surface-2)' : 'transparent',
        borderRadius: 4,
        transition: 'background 80ms',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          className="truncate"
          style={{
            fontSize: 12.5,
            color: 'var(--text-primary)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {line.label}
          {line.locked && (
            <span
              title="Computed from pay plan rules"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                fontSize: 9.5,
                color: 'var(--text-tertiary)',
                padding: '1px 5px',
                borderRadius: 3,
                background: 'var(--bg-surface-2)',
                border: '1px solid var(--border-hairline)',
                textTransform: 'uppercase',
                letterSpacing: 0.4,
                fontWeight: 600,
              }}
            >
              Auto
            </span>
          )}
        </div>
        {line.calc && (
          <div
            className="num truncate"
            style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}
          >
            {line.calc}
          </div>
        )}
      </div>
      <span
        className="num tabular-nums"
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: line.amountCents < 0 ? '#B43030' : 'var(--text-primary)',
        }}
      >
        {formatCents(line.amountCents)}
      </span>
      <span
        style={{
          width: 18,
          display: 'flex',
          justifyContent: 'flex-end',
          opacity: hover && !line.locked ? 1 : 0,
          transition: 'opacity 80ms',
        }}
      >
        <WIcon name="chevron-right" size={11} />
      </span>
    </div>
  );
}

function MarginFooter({
  marginCents,
  marginPct,
  hasBilling,
}: {
  marginCents: number;
  marginPct: number;
  hasBilling: boolean;
}) {
  const positive = marginCents >= 0;
  return (
    <div
      style={{
        marginTop: 10,
        padding: '8px 10px',
        borderRadius: 8,
        background: positive ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)',
        border: '1px solid ' + (positive ? 'rgba(16,185,129,0.20)' : 'rgba(239,68,68,0.22)'),
        display: 'flex',
        alignItems: 'baseline',
        gap: 12,
      }}
    >
      <div style={{ flex: 1, fontSize: 11.5, color: 'var(--text-secondary)' }}>
        Margin{' '}
        <span style={{ color: 'var(--text-tertiary)' }}>· revenue − driver pay</span>
      </div>
      {hasBilling && (
        <span className="num" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          {marginPct}%
        </span>
      )}
      <span
        className="num"
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: positive ? '#0F8C5F' : '#B43030',
        }}
      >
        {formatCents(marginCents)}
      </span>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function formatCents(cents: number): string {
  if (cents === 0) return '$0.00';
  const abs = Math.abs(cents) / 100;
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (cents < 0 ? '−$' : '$') + formatted;
}

function formatRate(rateMicroCents: number): string {
  // Display rates with up to 5 significant decimals; strip trailing zeros.
  if (!rateMicroCents) return '$0';
  const dollars = rateMicroCents / 100_000;
  const negative = dollars < 0;
  const abs = Math.abs(dollars);
  const str = abs.toFixed(5).replace(/\.?0+$/, '');
  return `${negative ? '-' : ''}$${str}`;
}

function formatQty(qty: number): string {
  if (Number.isInteger(qty)) return qty.toString();
  return stripTrailingZeros(qty.toFixed(2));
}

/** Trim trailing zeros (and a dangling decimal point) from a fixed-decimal
 *  string. "$5.50" → "$5.5", "$5.00" → "$5", "1.14" → "1.14". */
function stripTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

/** Build the rate-summary sub-line for the plan banner. Shows the first 4
 *  rules' name + rate, comma-separated. Mirrors the design's
 *  "Loaded $0.62/mi · Empty $0.54/mi · …" pattern. */
function summarizeRules(
  rules: Array<{
    name: string;
    rateAmountMicroCents?: bigint;
    trigger: { source: string; transform?: string };
  }> | undefined,
): string {
  if (!rules || rules.length === 0) return 'No rules defined';
  const parts: string[] = [];
  for (const r of rules.slice(0, 4)) {
    const rateRaw = r.rateAmountMicroCents;
    if (rateRaw == null) {
      parts.push(r.name);
      continue;
    }
    const rateNum = Number(rateRaw);
    const isPercent = r.trigger.transform === 'PERCENT';
    if (isPercent) {
      // Stored as micro-pct-points: 100% = 100_000_000
      const pct = rateNum / 1_000_000;
      parts.push(`${r.name} ${pct.toFixed(0)}%`);
    } else {
      const unit = unitForSource(r.trigger.source, r.trigger.transform);
      parts.push(`${r.name} ${formatRate(rateNum)}${unit}`);
    }
  }
  return parts.join(' · ');
}

function unitForSource(source: string, transform?: string): string {
  if (transform === 'HOURS_FROM_MINUTES') return '/hr';
  if (source.includes('Miles') || source === 'leg.totalMiles') return '/mi';
  if (source === 'stops.count') return '/stop';
  return '';
}
