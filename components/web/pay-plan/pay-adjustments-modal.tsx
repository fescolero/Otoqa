/**
 * PayAdjustmentsModal — full editor opened from LoadPayPlanCard.
 *
 * Per `details-pay-plan.jsx` design:
 *   - Pay plan radio picker (lists active payProfiles for the payee type)
 *   - Customer billing line-item editor
 *   - Driver/Carrier pay line-item editor
 *   - Reason + note for the audit log
 *   - "Notify driver via app of pay changes" checkbox
 *   - Footer: Revenue + Driver pay + Margin stats + Cancel + Save changes
 *
 * v1 scope (this iteration):
 *   - Plan switching: changes the default payProfileAssignment for the driver,
 *     then triggers a recalc on all legs (cascades to new engine).
 *   - Recalc button (replaces "Save changes" when only the plan changed).
 *
 * Deferred (needs backend manual-adjustment mutations):
 *   - Per-row inline rate/qty editing
 *   - Preset accessorial adds (fuel charge, detention, layover, lumper, etc.)
 *   - Audit-log reason + note save
 *   - Driver notification
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from 'convex/react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { WBtn, WIcon, Kbd } from '@/components/web';

export interface PayAdjustmentsModalProps {
  loadId: Id<'loadInformation'>;
  organizationId: string;
  userId: string;
  onClose: () => void;
}

export function PayAdjustmentsModal({
  loadId,
  organizationId,
  userId,
  onClose,
}: PayAdjustmentsModalProps) {
  // ── Data fetching ──────────────────────────────────────────────────────
  const payPlanData = useAuthQuery(api.payItems.listForLoad, { loadId });
  const invoiceData = useAuthQuery(api.invoices.getInvoiceByLoad, { loadId });
  const invoiceLineItems = useAuthQuery(
    api.invoices.getLineItems,
    invoiceData?._id ? { invoiceId: invoiceData._id } : 'skip',
  );
  const legs = useAuthQuery(api.dispatchLegs.getByLoad, { loadId });
  // Need this so the modal can find the assigned driver/carrier even when
  // there are no payItems yet (e.g. right after assignment, before the new
  // engine has run). Without it, `listForPayee` stayed skipped and the
  // assignments query never resolved → "Loading…" forever.
  const loadDetails = useAuthQuery(api.loads.getByIdWithRange, { loadId });

  // Identify the primary payee — same 3-source fallback the trip panel
  // banner uses on the load-detail page:
  //   1. First payee in payItems (most accurate once calc has run)
  //   2. The load's primaryDriverId cache
  //   3. The load's primaryCarrierPartnershipId cache
  // Whichever resolves first is the payee whose plan rotation the picker
  // edits and whose plan switch the Recalculate cascade re-runs against.
  const primaryPayee = payPlanData?.payees[0] ?? null;
  const fallbackPayee = primaryPayee
    ? null
    : loadDetails?.primaryDriverId
      ? { payeeType: 'DRIVER' as const, payeeId: loadDetails.primaryDriverId as string }
      : loadDetails?.primaryCarrierPartnershipId
        ? { payeeType: 'CARRIER' as const, payeeId: loadDetails.primaryCarrierPartnershipId as string }
        : null;
  const payeeType: 'DRIVER' | 'CARRIER' =
    primaryPayee?.payeeType ?? fallbackPayee?.payeeType ?? 'DRIVER';
  const payeeId: string | null =
    primaryPayee?.payeeId ?? fallbackPayee?.payeeId ?? null;

  // The plan picker lists every active org-level profile so a dispatcher
  // can change a load to any plan without leaving this modal. The current
  // default is marked separately so it's easy to spot at the top.
  // - DEFAULT section: the driver's currently-applied default plan
  // - ALL PLANS section: every other active org-level profile
  // Saving applies the choice: if it's already in the driver's assignment
  // rotation we just set it as default; otherwise we create the assignment
  // AND mark it default, in one mutation.
  const assignments = useQuery(
    api.payeeProfileAssignments.listForPayee,
    payeeId ? { payeeType, payeeId } : 'skip',
  );
  const currentDefault = (assignments ?? []).find(a => a.isDefault) ?? null;

  const orgProfiles = useQuery(
    api.payProfiles.listForOrg,
    organizationId ? { workosOrgId: organizationId, payeeType } : 'skip',
  );
  const activeOrgProfiles = (orgProfiles ?? []).filter(p => p.isActive);

  // ── Mutations ──────────────────────────────────────────────────────────
  const assignProfile = useMutation(api.payeeProfileAssignments.assign);
  const setDefault = useMutation(api.payeeProfileAssignments.setDefault);
  const recalcDriver = useMutation(api.loadPayables.recalculate);
  const recalcCarrier = useMutation(api.loadCarrierPayables.recalculate);
  const addManualPayItem = useMutation(api.payItems.addManualAdjustment);
  const updateManualPayItem = useMutation(api.payItems.updateManualAdjustment);
  const voidManualPayItem = useMutation(api.payItems.voidManualAdjustment);
  const addInvoiceLine = useMutation(api.invoices.addLineItem);
  const updateInvoiceLine = useMutation(api.invoices.updateLineItem);
  const removeInvoiceLine = useMutation(api.invoices.removeLineItem);

  // ── Local state ────────────────────────────────────────────────────────
  const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState('Customer accessorial');
  const [note, setNote] = React.useState('');
  const [notify, setNotify] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Initialize selection from the current default once loaded.
  React.useEffect(() => {
    if (currentDefault && selectedProfileId == null) {
      setSelectedProfileId(currentDefault.profileId);
    }
  }, [currentDefault, selectedProfileId]);

  // Esc closes
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  // ── Totals ─────────────────────────────────────────────────────────────
  const billingTotalCents = (invoiceLineItems ?? []).reduce(
    (s, l) => s + Math.round(l.amount * 100),
    0,
  );
  const payTotalCents = payPlanData?.totalCents ?? 0;
  const marginCents = billingTotalCents - payTotalCents;
  const marginPct = billingTotalCents > 0
    ? Math.round((marginCents / billingTotalCents) * 100)
    : 0;

  const planChanged =
    selectedProfileId != null && selectedProfileId !== currentDefault?.profileId;

  // ── Handlers ───────────────────────────────────────────────────────────
  // Every edit in this modal commits immediately — line items via their own
  // mutations (see LineItemsEditor wiring above), and plan changes via this
  // handler the moment the dispatcher picks a different plan. There's no
  // deferred "Save" step: the footer just has a Close action.
  const applyPlanChange = async (newProfileId: string) => {
    if (!payeeId || newProfileId === currentDefault?.profileId) return;
    setBusy(true);
    setError(null);
    try {
      const existing = (assignments ?? []).find(a => a.profileId === newProfileId);
      if (existing) {
        await setDefault({ assignmentId: existing._id as Id<'payeeProfileAssignments'> });
      } else {
        await assignProfile({
          payeeType,
          payeeId,
          profileId: newProfileId as Id<'payProfiles'>,
          isDefault: true,
        });
      }
      // Recalc all legs so the new plan's rules produce new payItems
      if (legs) {
        for (const leg of legs) {
          if (leg.carrierPartnershipId) {
            await recalcCarrier({ legId: leg._id, userId });
          } else if (leg.driverId) {
            await recalcDriver({ legId: leg._id, userId });
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply plan change');
    } finally {
      setBusy(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: 'rgba(15,17,22,0.55)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onMouseDown={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-strong)',
          borderRadius: 12,
          width: '100%',
          maxWidth: 760,
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-hairline)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(46,92,255,0.08)',
              color: '#1A47E6',
            }}
          >
            <WIcon name="doc-dollar" size={16} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3
              style={{
                margin: 0,
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              Pay adjustments
            </h3>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 1 }}>
              Edit pay plan, billing line items, and {payeeType.toLowerCase()} pay
            </div>
          </div>
          <button
            onClick={onClose}
            className="focus-ring"
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: 0,
              background: 'transparent',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            aria-label="Close"
          >
            <WIcon name="close" size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="scroll-thin" style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {/* Pay plan picker — collapsed dropdown that opens a searchable
              list. DEFAULT section (current default for this payee) at top,
              ALL PLANS (every other active org-level profile) underneath.
              Designed for orgs with many plans — virtualization isn't needed
              at typical scale (tens to ~hundreds) but search keeps it usable. */}
          <SectionLabel>Pay plan</SectionLabel>
          <PlanDropdown
            profiles={activeOrgProfiles}
            currentDefaultProfileId={currentDefault?.profileId ?? null}
            selectedProfileId={selectedProfileId}
            onSelect={id => {
              // Track the selection in local state immediately so the
              // dropdown reflects the user's choice, then fire the backend
              // mutation. The mutation also kicks off a per-leg recalc.
              setSelectedProfileId(id);
              void applyPlanChange(id);
            }}
            loading={orgProfiles === undefined || assignments === undefined}
          />

          {/* Live status: while the new plan is being applied (setDefault +
              per-leg recalc), surface that the auto lines are being recomputed.
              Replaces the prior pre-action warning since the change now
              commits immediately when the dispatcher picks a plan. */}
          {busy && planChanged && (
            <div
              style={{
                marginTop: 8,
                padding: '8px 10px',
                borderRadius: 6,
                background: 'rgba(245,158,11,0.06)',
                border: '1px solid rgba(245,158,11,0.22)',
                fontSize: 11.5,
                color: '#A66800',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <WIcon name="alert" size={12} />
              Recomputing auto-calculated pay lines on every leg…
            </div>
          )}

          <div style={{ height: 18 }} />

          {/* Customer billing — read-only rows + preset adder + inline edits. */}
          <LineItemsEditor
            label="Customer billing"
            sub="What the customer is billed for this load."
            lines={(invoiceLineItems ?? []).map(l => ({
              id: String(l._id),
              label: l.description,
              // Calc sub-line — qty + rate both capped at 2 decimals with
              // trailing zeros stripped ("1.14 × $5.5" not the full float).
              calc: l.quantity > 1 ? `${formatCalcQty(l.quantity)} × $${formatCalcDollars(l.rate)}` : '',
              amountCents: Math.round(l.amount * 100),
              // Dynamic IDs (e.g. "dynamic-freight") are computed on the fly
              // for DRAFT invoices — they have no real row to edit. Real stored
              // line items have Convex IDs and are editable while the invoice
              // is still in DRAFT/MISSING_DATA.
              locked: String(l._id).startsWith('dynamic-'),
            }))}
            presets={BILLING_PRESETS}
            // Adding a billing line only makes sense if an invoice exists
            // and isn't finalized. Otherwise the backend mutation will throw,
            // so we pre-disable the adder to give the dispatcher honest UX.
            canAdd={
              !!invoiceData &&
              (invoiceData.status === 'DRAFT' || invoiceData.status === 'MISSING_DATA')
            }
            disabledReason={
              !invoiceData
                ? 'No invoice yet for this load'
                : invoiceData.status === 'DRAFT' || invoiceData.status === 'MISSING_DATA'
                  ? undefined
                  : `Invoice is ${invoiceData.status.toLowerCase()} — use a credit memo`
            }
            onAdd={async preset => {
              if (!invoiceData?._id) return;
              await addInvoiceLine({
                invoiceId: invoiceData._id,
                type: preset.invoiceType ?? 'ACCESSORIAL',
                description: preset.label,
                quantity: 1,
                rate: preset.amount,
              });
            }}
            onUpdate={async (id, patch) => {
              const updates: { lineItemId: Id<'invoiceLineItems'>; description?: string; rate?: number } = {
                lineItemId: id as Id<'invoiceLineItems'>,
              };
              if (patch.description !== undefined) updates.description = patch.description;
              if (patch.amountCents !== undefined) updates.rate = patch.amountCents / 100;
              await updateInvoiceLine(updates);
            }}
            onRemove={async id => {
              await removeInvoiceLine({ lineItemId: id as Id<'invoiceLineItems'> });
            }}
            emptyText="No invoice line items yet."
          />

          <div style={{ height: 18 }} />

          {/* Driver pay — read-only rows + preset adder + inline edits. */}
          <LineItemsEditor
            label={payeeType === 'CARRIER' ? 'Carrier pay' : 'Driver pay'}
            sub={`What the ${payeeType.toLowerCase()} earns for this load. Deductions show as negative.`}
            lines={flattenPayItems(payPlanData?.payees ?? [])}
            presets={DRIVER_PRESETS}
            canAdd={!!payeeId}
            disabledReason={
              !payeeId
                ? `No ${payeeType.toLowerCase()} assigned to this load yet`
                : undefined
            }
            onAdd={async preset => {
              if (!payeeId) return;
              await addManualPayItem({
                loadId,
                payeeType,
                payeeId,
                componentCode: preset.componentCode,
                description: preset.label,
                amountCents: BigInt(Math.round(preset.amount * 100)),
                reason: reason || 'Manual adjustment',
              });
            }}
            onUpdate={async (id, patch) => {
              const updates: { payItemId: Id<'payItems'>; description?: string; amountCents?: bigint } = {
                payItemId: id as Id<'payItems'>,
              };
              if (patch.description !== undefined) updates.description = patch.description;
              if (patch.amountCents !== undefined) updates.amountCents = BigInt(patch.amountCents);
              await updateManualPayItem(updates);
            }}
            onRemove={async id => {
              await voidManualPayItem({ payItemId: id as Id<'payItems'> });
            }}
            emptyText="No pay items yet — switch a plan or recalculate to populate."
          />

          {/* Reason + audit log */}
          <div
            style={{
              marginTop: 18,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 12,
            }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                Reason
              </span>
              <select
                value={reason}
                onChange={e => setReason(e.target.value)}
                style={{
                  padding: '7px 10px',
                  borderRadius: 8,
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-hairline-strong)',
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  fontFamily: 'inherit',
                }}
              >
                {REASON_OPTIONS.map(r => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                Note (visible on activity log)
              </span>
              <input
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="Optional context for the audit log…"
                style={{
                  padding: '7px 10px',
                  borderRadius: 8,
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-hairline-strong)',
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  fontFamily: 'inherit',
                }}
              />
            </label>
          </div>

          {payeeType === 'DRIVER' && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                fontSize: 12.5,
                color: 'var(--text-primary)',
                marginTop: 12,
              }}
            >
              <input
                type="checkbox"
                checked={notify}
                onChange={e => setNotify(e.target.checked)}
              />
              Notify driver via app of pay changes
            </label>
          )}

          {error && (
            <div
              style={{
                marginTop: 12,
                padding: '8px 10px',
                borderRadius: 6,
                fontSize: 12,
                background: 'rgba(180,48,48,0.08)',
                color: '#B43030',
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer with totals */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--border-hairline)',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <FooterStat label="Revenue" value={formatCents(billingTotalCents)} />
          <FooterStat
            label={payeeType === 'CARRIER' ? 'Carrier pay' : 'Driver pay'}
            value={formatCents(payTotalCents)}
          />
          <FooterStat
            label="Margin"
            value={formatCents(marginCents)}
            sub={billingTotalCents > 0 ? `${marginPct}%` : undefined}
            tone={marginCents >= 0 ? 'ok' : 'crit'}
          />
          <div style={{ flex: 1 }} />
          {/* Everything in this modal commits immediately (line items via
              their own mutations, plan change via applyPlanChange on pick).
              There's no Save to defer — Done just closes. */}
          <WBtn size="sm" accent onClick={onClose} disabled={busy}>
            {busy ? 'Working…' : 'Done'}
          </WBtn>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        color: 'var(--text-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

type ProfileLike = {
  _id: string;
  name: string;
  rules?: Array<{
    name: string;
    rateAmountMicroCents?: bigint;
    trigger: { source: string; transform?: string };
  }>;
};

/**
 * PlanDropdown — collapsed trigger that opens a searchable list of pay
 * profiles. Two sections when not filtering — DEFAULT (current default
 * profile) + ALL PLANS (every other active org profile). Searching
 * collapses both sections into one flat filtered list; the footer's count
 * label adapts ("N matches" vs "N total").
 *
 * Critically, this uses **plain `position: absolute` positioning inside the
 * modal** — NOT Radix's Portal — so the popover lives inside the modal's
 * stacking context and we don't need to fight z-index against the dim
 * backdrop. This matches the design in `details-pay-plan.jsx`.
 */
function PlanDropdown({
  profiles,
  currentDefaultProfileId,
  selectedProfileId,
  onSelect,
  loading,
}: {
  profiles: ProfileLike[];
  currentDefaultProfileId: string | null;
  selectedProfileId: string | null;
  onSelect: (profileId: string) => void;
  loading: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Open/close lifecycle: focus search, listen for outside click + Escape.
  React.useEffect(() => {
    if (!open) return;
    setQ('');
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 10);
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const currentDefault = profiles.find(p => p._id === currentDefaultProfileId) ?? null;
  const others = profiles.filter(p => p._id !== currentDefaultProfileId);
  const selected = profiles.find(p => p._id === selectedProfileId) ?? currentDefault ?? null;

  // When a search term is present we render a flat filtered list. When the
  // search is empty we render the DEFAULT + ALL PLANS sections.
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? profiles.filter(
        p =>
          p.name.toLowerCase().includes(needle) ||
          summarizeProfile(p).toLowerCase().includes(needle),
      )
    : null;

  const totalCount = profiles.length;

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      {/* Trigger — collapsed view of the current selection. */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="Select pay plan"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={loading || profiles.length === 0}
        className="focus-ring w-full text-left disabled:cursor-not-allowed disabled:opacity-60"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 12px',
          borderRadius: 8,
          border: '1px solid ' + (open ? 'var(--accent)' : 'var(--border-hairline-strong)'),
          background: 'var(--bg-surface)',
          fontFamily: 'inherit',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: 'rgba(46,92,255,0.10)',
            color: 'var(--accent)',
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <WIcon name="doc-dollar" size={14} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span
              className="truncate"
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              {loading
                ? 'Loading…'
                : selected
                  ? selected.name
                  : profiles.length === 0
                    ? 'No plans defined'
                    : 'Select a plan'}
            </span>
            {selected && selected._id === currentDefaultProfileId && <DefaultBadge />}
          </div>
          {selected && (
            <div
              className="truncate"
              style={{
                fontSize: 11.5,
                color: 'var(--text-tertiary)',
                marginTop: 1,
              }}
            >
              {summarizeProfile(selected)}
            </div>
          )}
        </div>
        {!loading && totalCount > 0 && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              padding: '2px 7px',
              borderRadius: 9,
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-hairline)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {totalCount} plans
          </span>
        )}
        <WIcon name="chevron-down" size={13} />
      </button>

      {/* Popover — absolute-positioned inside the modal. No portal. */}
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 50,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline-strong)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-popover)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 340,
          }}
        >
          {/* Search */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 10px',
              borderBottom: '1px solid var(--border-hairline)',
              background: 'var(--bg-surface-2)',
            }}
          >
            <WIcon name="search" size={13} />
            <input
              ref={inputRef}
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder={`Search ${totalCount} pay plan${totalCount === 1 ? '' : 's'}…`}
              style={{
                flex: 1,
                border: 0,
                outline: 0,
                background: 'transparent',
                fontFamily: 'inherit',
                fontSize: 12.5,
                color: 'var(--text-primary)',
              }}
            />
            <Kbd>Esc</Kbd>
          </div>

          {/* List */}
          <div
            className="scroll-thin"
            style={{ flex: 1, overflowY: 'auto', padding: 4 }}
          >
            {filtered ? (
              filtered.length === 0 ? (
                <div
                  style={{
                    padding: 24,
                    textAlign: 'center',
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                  }}
                >
                  No matches for &ldquo;{q}&rdquo;
                </div>
              ) : (
                filtered.map(p => (
                  <DropdownRow
                    key={p._id}
                    profile={p}
                    isSelected={selectedProfileId === p._id}
                    isCurrentDefault={p._id === currentDefaultProfileId}
                    onPick={() => {
                      onSelect(p._id);
                      setOpen(false);
                    }}
                  />
                ))
              )
            ) : (
              <>
                {currentDefault && (
                  <>
                    <DropdownSectionLabel>Default</DropdownSectionLabel>
                    <DropdownRow
                      profile={currentDefault}
                      isSelected={selectedProfileId === currentDefault._id}
                      isCurrentDefault
                      onPick={() => {
                        onSelect(currentDefault._id);
                        setOpen(false);
                      }}
                    />
                  </>
                )}
                {others.length > 0 && (
                  <>
                    <DropdownSectionLabel>All plans ({others.length})</DropdownSectionLabel>
                    {others.map(p => (
                      <DropdownRow
                        key={p._id}
                        profile={p}
                        isSelected={selectedProfileId === p._id}
                        isCurrentDefault={false}
                        onPick={() => {
                          onSelect(p._id);
                          setOpen(false);
                        }}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          {/* Footer — count + Manage plans link. Count adapts when filtered. */}
          <div
            style={{
              padding: '8px 10px',
              borderTop: '1px solid var(--border-hairline)',
              background: 'var(--bg-surface-2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 11.5,
              color: 'var(--text-tertiary)',
            }}
          >
            <span>
              {filtered
                ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`
                : `${totalCount} total`}
            </span>
            <Link
              href="/org-settings/pay-profiles"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                color: 'var(--accent)',
                fontWeight: 500,
              }}
            >
              Manage plans
              <WIcon name="arrow-up-right" size={11} />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function DropdownSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '8px 10px 2px',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.06,
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
      }}
    >
      {children}
    </div>
  );
}

function DropdownRow({
  profile,
  isSelected,
  isCurrentDefault,
  onPick,
}: {
  profile: ProfileLike;
  isSelected: boolean;
  isCurrentDefault: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="focus-ring w-full text-left"
      style={{
        cursor: 'pointer',
        padding: '7px 10px',
        borderRadius: 5,
        border: 0,
        background: isSelected ? 'rgba(46,92,255,0.08)' : 'transparent',
        fontFamily: 'inherit',
        display: 'grid',
        gridTemplateColumns: '18px 1fr auto',
        gap: 10,
        alignItems: 'center',
      }}
      onMouseEnter={e => {
        if (!isSelected) {
          (e.currentTarget as HTMLElement).style.background = 'var(--bg-row-hover)';
        }
      }}
      onMouseLeave={e => {
        if (!isSelected) {
          (e.currentTarget as HTMLElement).style.background = 'transparent';
        }
      }}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          height: 14,
          borderRadius: 99,
          border:
            '1.5px solid ' +
            (isSelected ? 'var(--accent)' : 'var(--border-hairline-strong)'),
          background: isSelected ? 'var(--accent)' : 'transparent',
          boxShadow: isSelected ? 'inset 0 0 0 2.5px var(--bg-surface)' : 'none',
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <span
            className="truncate"
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              color: 'var(--text-primary)',
            }}
          >
            {profile.name}
          </span>
          {isCurrentDefault && <DefaultBadge />}
        </div>
        <div
          className="truncate"
          style={{
            fontSize: 11,
            color: 'var(--text-tertiary)',
            marginTop: 1,
          }}
        >
          {summarizeProfile(profile)}
        </div>
      </div>
      {isSelected && (
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
          <WIcon name="check" size={12} />
        </span>
      )}
    </button>
  );
}

function DefaultBadge() {
  return (
    <span
      style={{
        fontSize: 9.5,
        fontWeight: 600,
        color: 'var(--text-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        padding: '1px 5px',
        borderRadius: 3,
        background: 'var(--bg-surface-2)',
        border: '1px solid var(--border-hairline)',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      Default
    </span>
  );
}

function FooterStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'ok' | 'crit';
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 10,
          color: 'var(--text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 1 }}>
        <span
          className="num"
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: tone === 'ok' ? '#0F8C5F' : tone === 'crit' ? '#B43030' : 'var(--text-primary)',
          }}
        >
          {value}
        </span>
        {sub && (
          <span
            className="num"
            style={{ fontSize: 11, color: 'var(--text-tertiary)' }}
          >
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// LineItemsEditor — wraps the read-only line list with an inline preset adder
// ============================================================================

type BillingInvoiceType = 'FREIGHT' | 'FUEL' | 'ACCESSORIAL' | 'TAX';

export type BillingPreset = {
  id: string;
  icon: 'fuel' | 'clock' | 'moon' | 'package' | 'compass' | 'gauge' | 'shield' | 'plus';
  label: string;
  amount: number;          // default dollars; user can recalc / edit later
  invoiceType?: BillingInvoiceType;
};

export type DriverPreset = {
  id: string;
  icon: 'pin' | 'clock' | 'moon' | 'shield' | 'fuel' | 'trash' | 'plus';
  label: string;
  amount: number;          // default dollars
  componentCode: string;   // looked up against chargeComponents catalog
  deduction?: boolean;     // tints the chip red
};

const BILLING_PRESETS: BillingPreset[] = [
  { id: 'fuel',      icon: 'fuel',    label: 'Fuel charge',     amount: 0,    invoiceType: 'FUEL' },
  { id: 'detention', icon: 'clock',   label: 'Detention',       amount: 0,    invoiceType: 'ACCESSORIAL' },
  { id: 'layover',   icon: 'moon',    label: 'Layover',         amount: 150,  invoiceType: 'ACCESSORIAL' },
  { id: 'lumper',    icon: 'package', label: 'Lumper / unload', amount: 0,    invoiceType: 'ACCESSORIAL' },
  { id: 'tolls',     icon: 'compass', label: 'Tolls',           amount: 0,    invoiceType: 'ACCESSORIAL' },
  { id: 'reefer',    icon: 'gauge',   label: 'Reefer surcharge', amount: 25,  invoiceType: 'ACCESSORIAL' },
  { id: 'tarping',   icon: 'shield',  label: 'Tarping',         amount: 75,   invoiceType: 'ACCESSORIAL' },
  { id: 'custom',    icon: 'plus',    label: 'Custom line',     amount: 0,    invoiceType: 'ACCESSORIAL' },
];

const DRIVER_PRESETS: DriverPreset[] = [
  { id: 'stop-pay',  icon: 'pin',    label: 'Stop pay',        amount: 30,   componentCode: 'STOP_PAY' },
  { id: 'detention', icon: 'clock',  label: 'Detention',       amount: 0,    componentCode: 'DETENTION_PAY' },
  { id: 'layover',   icon: 'moon',   label: 'Layover',         amount: 100,  componentCode: 'LAYOVER_PAY' },
  { id: 'safety',    icon: 'shield', label: 'Safety bonus',    amount: 75,   componentCode: 'SAFETY_BONUS' },
  { id: 'perf',      icon: 'shield', label: 'Performance bonus', amount: 100, componentCode: 'PERFORMANCE_BONUS' },
  { id: 'damage',    icon: 'trash',  label: 'Damage charge',   amount: -50,  componentCode: 'DAMAGE_CHARGE', deduction: true },
  { id: 'admin-fee', icon: 'trash',  label: 'Admin fee',       amount: -25,  componentCode: 'ADMIN_FEE', deduction: true },
  { id: 'custom',    icon: 'plus',   label: 'Custom line',     amount: 0,    componentCode: 'PERFORMANCE_BONUS' },
];

function LineItemsEditor<P extends { id: string; icon: string; label: string; amount: number; deduction?: boolean }>({
  label,
  sub,
  lines,
  presets,
  canAdd,
  disabledReason,
  onAdd,
  onUpdate,
  onRemove,
  emptyText,
}: {
  label: string;
  sub: string;
  lines: Array<{ id: string; label: string; calc: string; amountCents: number; locked: boolean }>;
  presets: P[];
  canAdd: boolean;
  disabledReason?: string;
  onAdd: (preset: P) => Promise<void> | void;
  /** Update an unlocked row. Description and/or amountCents — undefined means
   *  "don't touch this field". Throws on backend errors; we catch + surface. */
  onUpdate?: (id: string, patch: { description?: string; amountCents?: number }) => Promise<void> | void;
  /** Void an unlocked row. */
  onRemove?: (id: string) => Promise<void> | void;
  emptyText: string;
}) {
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const total = lines.reduce((s, l) => s + l.amountCents, 0);

  const handlePick = async (preset: P) => {
    setBusy(true);
    setError(null);
    try {
      await onAdd(preset);
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add line');
    } finally {
      setBusy(false);
    }
  };

  const handleUpdate = async (id: string, patch: { description?: string; amountCents?: number }) => {
    if (!onUpdate) return;
    setError(null);
    try {
      await onUpdate(id, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update line');
    }
  };

  const handleRemove = async (id: string) => {
    if (!onRemove) return;
    // No confirm dialog — the trash button is per-row and the action is
    // reversible (recalc re-creates auto items; manual items can be re-added
    // from the preset chips below).
    setError(null);
    try {
      await onRemove(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove line');
    }
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
          {label}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', flex: 1 }}>{sub}</div>
        <span className="num" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {lines.length} line{lines.length === 1 ? '' : 's'} ·{' '}
          {(total / 100).toLocaleString('en-US', {
            style: 'currency',
            currency: 'USD',
          })}
        </span>
      </div>

      <div
        style={{
          border: '1px solid var(--border-hairline-strong)',
          borderRadius: 8,
          background: 'var(--bg-surface)',
          overflow: 'hidden',
        }}
      >
        {/* Rows — locked rows stay read-only with an AUTO badge; unlocked
            rows render as inline-editable description + amount + trash. */}
        {lines.length === 0 ? (
          <div
            style={{
              padding: 14,
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--text-tertiary)',
            }}
          >
            {emptyText}
          </div>
        ) : (
          lines.map((l, i) => (
            <LineRow
              key={l.id}
              line={l}
              first={i === 0}
              canEdit={!l.locked && !!onUpdate}
              canRemove={!l.locked && !!onRemove}
              onUpdate={patch => handleUpdate(l.id, patch)}
              onRemove={() => handleRemove(l.id)}
            />
          ))
        )}

        {/* Add line trigger */}
        <button
          onClick={() => canAdd && setAdding(a => !a)}
          disabled={!canAdd || busy}
          className="focus-ring"
          title={disabledReason}
          style={{
            width: '100%',
            padding: '8px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: adding ? 'var(--bg-surface-2)' : 'transparent',
            border: 0,
            borderTop: lines.length > 0 ? '1px solid var(--border-hairline)' : 0,
            color: canAdd ? 'var(--accent)' : 'var(--text-tertiary)',
            fontSize: 12,
            fontFamily: 'inherit',
            cursor: canAdd ? 'pointer' : 'not-allowed',
            textAlign: 'left',
            opacity: canAdd ? 1 : 0.7,
          }}
        >
          <WIcon name={adding ? 'close' : 'plus'} size={12} />
          {adding
            ? 'Cancel'
            : canAdd
              ? 'Add line item'
              : disabledReason ?? 'Add line item'}
        </button>

        {/* Preset chip grid */}
        {adding && canAdd && (
          <div
            style={{
              padding: 10,
              background: 'var(--bg-surface-2)',
              borderTop: '1px solid var(--border-hairline)',
              display: 'grid',
              gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
              gap: 6,
            }}
          >
            {presets.map(p => (
              <button
                key={p.id}
                onClick={() => handlePick(p)}
                disabled={busy}
                className="focus-ring"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline-strong)',
                  color: 'var(--text-primary)',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  cursor: busy ? 'wait' : 'pointer',
                  textAlign: 'left',
                  opacity: busy ? 0.5 : 1,
                }}
              >
                <span
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 5,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: p.deduction
                      ? 'rgba(239,68,68,0.08)'
                      : 'rgba(46,92,255,0.08)',
                    color: p.deduction ? '#B43030' : '#1A47E6',
                    flexShrink: 0,
                  }}
                >
                  <WIcon
                    name={p.icon as 'fuel' | 'clock' | 'moon' | 'package' | 'compass' | 'gauge' | 'shield' | 'plus' | 'pin' | 'trash'}
                    size={11}
                  />
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {p.label}
                </span>
              </button>
            ))}
          </div>
        )}

        {error && (
          <div
            style={{
              padding: '8px 10px',
              background: 'rgba(180,48,48,0.08)',
              color: '#B43030',
              fontSize: 11.5,
              borderTop: '1px solid var(--border-hairline)',
            }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * LineRow — single row inside LineItemsEditor.
 *
 * Locked rows: read-only static text with an AUTO badge (engine-computed
 * earnings, dynamic invoice lines from DRAFT-time calc).
 *
 * Editable rows: description text input + amount number input + trash icon.
 * Each input commits on blur (and on Enter, via blur). Local state mirrors
 * the upstream prop so the convex query can overwrite it after a successful
 * mutation without making the row feel laggy.
 */
function LineRow({
  line,
  first,
  canEdit,
  canRemove,
  onUpdate,
  onRemove,
}: {
  line: { id: string; label: string; calc: string; amountCents: number; locked: boolean };
  first: boolean;
  canEdit: boolean;
  canRemove: boolean;
  onUpdate: (patch: { description?: string; amountCents?: number }) => Promise<void> | void;
  onRemove: () => Promise<void> | void;
}) {
  // Local state for editable inputs. Resets whenever the upstream row changes
  // (e.g. after recalc or another user's edit on the same row).
  const [descDraft, setDescDraft] = React.useState(line.label);
  const [amountDraft, setAmountDraft] = React.useState((line.amountCents / 100).toFixed(2));

  React.useEffect(() => {
    setDescDraft(line.label);
  }, [line.label]);
  React.useEffect(() => {
    setAmountDraft((line.amountCents / 100).toFixed(2));
  }, [line.amountCents]);

  const commitDescription = () => {
    const trimmed = descDraft.trim();
    if (trimmed && trimmed !== line.label) {
      void onUpdate({ description: trimmed });
    } else {
      // revert to canonical value if the user cleared the field
      setDescDraft(line.label);
    }
  };

  const commitAmount = () => {
    const parsed = parseFloat(amountDraft);
    if (Number.isFinite(parsed)) {
      const cents = Math.round(parsed * 100);
      if (cents !== line.amountCents) {
        void onUpdate({ amountCents: cents });
      } else {
        // canonical form (e.g. "30" → "30.00")
        setAmountDraft((line.amountCents / 100).toFixed(2));
      }
    } else {
      // bad input: revert
      setAmountDraft((line.amountCents / 100).toFixed(2));
    }
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1.6fr 1.4fr 110px 28px',
        gap: 8,
        alignItems: 'center',
        padding: '8px 10px',
        borderTop: first ? 0 : '1px solid var(--border-hairline)',
        background: line.locked ? 'var(--bg-surface-2)' : 'transparent',
      }}
    >
      {/* Description — input when editable, static span when locked */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {canEdit ? (
          <input
            value={descDraft}
            onChange={e => setDescDraft(e.target.value)}
            onBlur={commitDescription}
            onKeyDown={e => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setDescDraft(line.label);
                (e.target as HTMLInputElement).blur();
              }
            }}
            aria-label="Line description"
            style={{
              flex: 1,
              minWidth: 0,
              padding: '5px 8px',
              borderRadius: 6,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline-strong)',
              color: 'var(--text-primary)',
              fontSize: 12.5,
              fontFamily: 'inherit',
              fontWeight: 500,
            }}
          />
        ) : (
          <span
            className="truncate"
            style={{
              fontSize: 12.5,
              color: 'var(--text-primary)',
              fontWeight: 500,
            }}
          >
            {line.label}
          </span>
        )}
        {line.locked && (
          <span
            style={{
              fontSize: 9.5,
              color: 'var(--text-tertiary)',
              padding: '1px 5px',
              borderRadius: 3,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            Auto
          </span>
        )}
      </div>

      {/* Calc — display-only (derived from rate × qty upstream) */}
      <span
        className="num truncate"
        style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}
      >
        {line.calc}
      </span>

      {/* Amount — input when editable, static span when locked */}
      {canEdit ? (
        <div style={{ position: 'relative' }}>
          <span
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 11.5,
              color: 'var(--text-tertiary)',
              pointerEvents: 'none',
            }}
          >
            $
          </span>
          <input
            type="number"
            step="0.01"
            value={amountDraft}
            onChange={e => setAmountDraft(e.target.value)}
            onBlur={commitAmount}
            onKeyDown={e => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setAmountDraft((line.amountCents / 100).toFixed(2));
                (e.target as HTMLInputElement).blur();
              }
            }}
            aria-label="Line amount"
            className="num"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '5px 8px 5px 18px',
              borderRadius: 6,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline-strong)',
              color: line.amountCents < 0 ? '#B43030' : 'var(--text-primary)',
              fontSize: 12.5,
              fontFamily: 'inherit',
              fontWeight: 500,
              textAlign: 'right',
            }}
          />
        </div>
      ) : (
        <span
          className="num tabular-nums"
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            textAlign: 'right',
            color: line.amountCents < 0 ? '#B43030' : 'var(--text-primary)',
          }}
        >
          {(line.amountCents / 100).toLocaleString('en-US', {
            style: 'currency',
            currency: 'USD',
          })}
        </span>
      )}

      {/* Remove — only on editable rows */}
      {canRemove ? (
        <button
          onClick={() => void onRemove()}
          className="focus-ring"
          title="Remove line"
          aria-label="Remove line"
          style={{
            width: 24,
            height: 24,
            borderRadius: 5,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 0,
            color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          <WIcon name="trash" size={12} />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

const REASON_OPTIONS = [
  'Customer accessorial',
  'Driver bonus',
  'Fuel price update',
  'Detention',
  'Layover',
  'Lumper / unload',
  'Tolls',
  'Correction',
  'Other',
];

function formatCents(cents: number): string {
  if (cents === 0) return '$0.00';
  const abs = Math.abs(cents) / 100;
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (cents < 0 ? '−$' : '$') + formatted;
}

/** Quantity formatter for the "qty × rate" calc sub-line. Integers stay as
 *  whole numbers; fractions cap at 2 decimals with trailing zeros stripped
 *  (so "1.143923..." becomes "1.14" and "2.00" becomes "2"). */
function formatCalcQty(qty: number): string {
  if (Number.isInteger(qty)) return qty.toString();
  return qty.toFixed(2).replace(/\.?0+$/, '');
}

/** Dollar formatter for the calc sub-line. Same 2-decimal cap with
 *  trailing-zero strip so "$5.50" → "$5.5", "$5.00" → "$5". Sub-cent pay
 *  rates are intentionally rounded here for display — the underlying
 *  amountCents preserves the full precision. */
function formatCalcDollars(dollars: number): string {
  return dollars.toFixed(2).replace(/\.?0+$/, '');
}

function summarizeProfile(p: {
  rules?: Array<{
    name: string;
    rateAmountMicroCents?: bigint;
    trigger: { source: string; transform?: string };
  }>;
}): string {
  const rules = p.rules ?? [];
  if (rules.length === 0) return 'No rules defined';
  const parts: string[] = [];
  for (const r of rules.slice(0, 4)) {
    const raw = r.rateAmountMicroCents;
    if (raw == null) {
      parts.push(r.name);
      continue;
    }
    const num = Number(raw);
    if (r.trigger.transform === 'PERCENT') {
      const pct = num / 1_000_000;
      parts.push(`${r.name} ${pct.toFixed(0)}%`);
    } else {
      const dollars = num / 100_000;
      const unit =
        r.trigger.transform === 'HOURS_FROM_MINUTES'
          ? '/hr'
          : r.trigger.source.includes('Miles') || r.trigger.source === 'leg.totalMiles'
            ? '/mi'
            : r.trigger.source === 'stops.count'
              ? '/stop'
              : '';
      parts.push(`${r.name} $${dollars.toFixed(2).replace(/\.?0+$/, '')}${unit}`);
    }
  }
  return parts.join(' · ');
}

function flattenPayItems(
  payees: Array<{
    payeeName: string;
    payeeType: 'DRIVER' | 'CARRIER';
    legs: Array<{
      items: Array<{
        _id: string;
        description: string;
        componentName: string;
        kind: string;
        quantity: number;
        rateMicroCentsNumber: number;
        amountCentsNumber: number;
      }>;
    }>;
  }>,
): Array<{ id: string; label: string; calc: string; amountCents: number; locked: boolean }> {
  const showPrefix = payees.length > 1;
  const out: Array<{ id: string; label: string; calc: string; amountCents: number; locked: boolean }> = [];
  for (const p of payees) {
    for (const leg of p.legs) {
      for (const item of leg.items) {
        out.push({
          id: String(item._id),
          label: showPrefix
            ? `${p.payeeName} — ${item.description || item.componentName}`
            : item.description || item.componentName,
          calc:
            item.quantity !== 1
              ? `${formatCalcQty(item.quantity)} × $${formatCalcDollars(item.rateMicroCentsNumber / 100_000)}`
              : '',
          amountCents: item.amountCentsNumber,
          locked: item.kind === 'EARNING' || item.kind === 'NEGOTIATED',
        });
      }
    }
  }
  return out;
}
