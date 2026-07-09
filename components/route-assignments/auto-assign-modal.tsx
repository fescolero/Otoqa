'use client';

/**
 * AutoAssignModal — create / edit auto-assignment rule.
 *
 * Faithful adaptation of the Otoqa Web design's AutoAssignModal:
 *   • surface-2 inputs with hairline-strong borders
 *   • AASection vocabulary (icon + title + optional note)
 *   • Two-column body: form (left) + sticky Live preview rail (right)
 *   • Sparkle icon for create, repeat icon for renew
 *   • Accent primary CTA in the footer
 *
 * Only wires fields the routeAssignments schema currently supports
 * (name, hcr, tripNumber, driverId/carrierPartnershipId, notes). The
 * design's window/conflict/notification fields are intentionally omitted
 * until the schema grows to support them.
 */

import * as React from 'react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { Avatar, WBtn, WIcon, type IconName } from '@/components/web';
import { Loader2 } from 'lucide-react';

type AssigneeKind = 'driver' | 'carrier';

interface RouteAssignmentDoc {
  _id: Id<'routeAssignments'>;
  hcr: string;
  tripNumber?: string;
  driverId?: Id<'drivers'>;
  carrierPartnershipId?: Id<'carrierPartnerships'>;
  name?: string;
  notes?: string;
  driverName?: string;
  carrierName?: string;
}

interface AutoAssignModalProps {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  userId: string;
  /** When set, modal is in edit mode for this assignment. */
  rule?: RouteAssignmentDoc | null;
}

// ─── primitives ─────────────────────────────────────────────────────────

function AASection({
  icon,
  title,
  note,
  children,
}: {
  icon: IconName;
  title: React.ReactNode;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-[22px]">
      <div className="flex items-center gap-2 mb-2.5">
        <span
          aria-hidden
          className="inline-flex items-center justify-center rounded-md"
          style={{
            width: 22,
            height: 22,
            background: 'var(--bg-sidebar-active)',
            color: 'var(--accent)',
          }}
        >
          <WIcon name={icon} size={12} />
        </span>
        <h4 className="m-0 text-[12.5px] font-semibold text-foreground">{title}</h4>
      </div>
      {note && (
        <div className="text-[11.5px] text-[var(--text-tertiary)] mb-2.5 leading-[16px]">
          {note}
        </div>
      )}
      {children}
    </section>
  );
}

function AAField({
  label,
  hint,
  required,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-[5px]">
      <span className="text-[11.5px] text-[var(--text-secondary)] inline-flex items-center gap-1">
        {label}
        {required && <span style={{ color: '#B43030' }}>*</span>}
      </span>
      {children}
      {hint && (
        <span className="text-[11px] text-[var(--text-tertiary)] leading-[15px]">{hint}</span>
      )}
    </label>
  );
}

function AAInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div
      className="inline-flex items-center h-8 px-2.5 rounded-lg bg-[var(--bg-surface-2)] border border-[var(--border-hairline-strong)] focus-within:border-[var(--accent)] transition-colors"
    >
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 border-0 outline-0 bg-transparent text-[12.5px] text-foreground w-full font-sans"
      />
    </div>
  );
}

function AASelect<T extends string>({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: T | '';
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full h-8 pr-7 pl-2.5 rounded-lg bg-[var(--bg-surface-2)] border border-[var(--border-hairline-strong)] text-[12.5px] text-foreground font-sans appearance-none cursor-pointer"
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span
        aria-hidden
        className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-tertiary)] flex"
      >
        <WIcon name="chevron-down" size={12} />
      </span>
    </div>
  );
}

function AATextarea({
  value,
  onChange,
  placeholder,
  rows = 2,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full px-2.5 py-2 rounded-lg bg-[var(--bg-surface-2)] border border-[var(--border-hairline-strong)] focus:border-[var(--accent)] outline-none text-[12.5px] text-foreground font-sans resize-none transition-colors"
    />
  );
}

function SummaryLine({ value, mono }: { value: React.ReactNode; mono?: boolean }) {
  return (
    <div
      className={
        'text-[11.5px] text-foreground leading-[16px] whitespace-nowrap overflow-hidden text-ellipsis ' +
        (mono ? 'num' : '')
      }
    >
      {value}
    </div>
  );
}

function SummaryItem({
  icon,
  label,
  children,
}: {
  icon: IconName;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <WIcon name={icon} size={11} color="var(--text-tertiary)" />
        <span className="text-[10.5px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

// ─── modal ──────────────────────────────────────────────────────────────

export function AutoAssignModal({
  open,
  onClose,
  organizationId,
  userId,
  rule,
}: AutoAssignModalProps) {
  const isEdit = !!rule;

  // ── form state ─────────────────────────────────────────────────────
  const [name, setName] = React.useState(rule?.name ?? '');
  const [hcr, setHcr] = React.useState(rule?.hcr ?? '');
  const [tripNumber, setTripNumber] = React.useState(rule?.tripNumber ?? '');
  const [assigneeKind, setAssigneeKind] = React.useState<AssigneeKind>(
    rule?.carrierPartnershipId ? 'carrier' : 'driver',
  );
  const [driverId, setDriverId] = React.useState<string>(rule?.driverId ?? '');
  const [carrierId, setCarrierId] = React.useState<string>(rule?.carrierPartnershipId ?? '');
  const [notes, setNotes] = React.useState(rule?.notes ?? '');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset form when modal re-opens.
  React.useEffect(() => {
    if (open) {
      setName(rule?.name ?? '');
      setHcr(rule?.hcr ?? '');
      setTripNumber(rule?.tripNumber ?? '');
      setAssigneeKind(rule?.carrierPartnershipId ? 'carrier' : 'driver');
      setDriverId(rule?.driverId ?? '');
      setCarrierId(rule?.carrierPartnershipId ?? '');
      setNotes(rule?.notes ?? '');
      setError(null);
    }
  }, [open, rule]);

  // ── escape closes ──────────────────────────────────────────────────
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  // ── data ───────────────────────────────────────────────────────────
  const routes = useAuthQuery(api.contractLanes.listUniqueRoutes, {
    workosOrgId: organizationId,
  });
  const availableTripNumbers = React.useMemo(() => {
    if (!hcr || !routes) return [];
    const route = routes.find((r) => r.hcr === hcr);
    return (route?.tripNumbers ?? []).filter((t) => t && t.trim() !== '');
  }, [hcr, routes]);

  // Reset trip number when HCR changes (only on create — preserve edits otherwise).
  React.useEffect(() => {
    if (!isEdit) setTripNumber('');
  }, [hcr, isEdit]);

  const drivers = useAuthQuery(api.drivers.list, { organizationId });
  const activeDrivers = React.useMemo(
    () =>
      drivers?.filter((d) => d.employmentStatus === 'Active' && !d.isDeleted) ?? [],
    [drivers],
  );
  const carriers = useAuthQuery(api.carrierPartnerships.listForBroker, {
    brokerOrgId: organizationId,
  });
  const activeCarriers = React.useMemo(
    () => carriers?.filter((c) => c.status === 'ACTIVE') ?? [],
    [carriers],
  );

  const createMutation = useMutation(api.routeAssignments.create);
  const updateMutation = useMutation(api.routeAssignments.update);

  const selectedDriver = activeDrivers.find((d) => d._id === driverId);
  const selectedCarrier = activeCarriers.find((c) => c._id === carrierId);
  const selectedDriverName = selectedDriver
    ? `${selectedDriver.firstName} ${selectedDriver.lastName}`
    : null;

  // ── derived preview ────────────────────────────────────────────────
  const previewName = name || (hcr ? `${hcr}${tripNumber ? ` · ${tripNumber}` : ''}` : 'Untitled rule');

  // ── submit ─────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!hcr) return setError('HCR is required.');
    if (assigneeKind === 'driver' && !driverId) return setError('Please select a driver.');
    if (assigneeKind === 'carrier' && !carrierId) return setError('Please select a carrier.');

    setIsSubmitting(true);
    try {
      if (isEdit && rule) {
        await updateMutation({
          id: rule._id,
          hcr,
          tripNumber: tripNumber || undefined,
          driverId: assigneeKind === 'driver' ? (driverId as Id<'drivers'>) : undefined,
          carrierPartnershipId:
            assigneeKind === 'carrier' ? (carrierId as Id<'carrierPartnerships'>) : undefined,
          name: name || undefined,
          notes: notes || undefined,
        });
      } else {
        await createMutation({
          workosOrgId: organizationId,
          hcr,
          tripNumber: tripNumber || undefined,
          driverId: assigneeKind === 'driver' ? (driverId as Id<'drivers'>) : undefined,
          carrierPartnershipId:
            assigneeKind === 'carrier' ? (carrierId as Id<'carrierPartnerships'>) : undefined,
          name: name || undefined,
          notes: notes || undefined,
          createdBy: userId,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save rule');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[1100] flex items-center justify-center p-6"
      style={{ background: 'rgba(15,17,22,0.55)', backdropFilter: 'blur(2px)' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col w-full max-w-[760px] max-h-[90vh] min-h-0 rounded-xl border border-[var(--border-hairline-strong)] overflow-hidden"
        style={{
          background: 'var(--bg-surface)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
        }}
      >
        <form onSubmit={handleSubmit} className="flex flex-col min-h-0 flex-1">
          {/* Header */}
          <div className="shrink-0 flex items-center gap-3 px-5 py-4 border-b border-[var(--border-hairline)]">
            <span
              aria-hidden
              className="inline-flex items-center justify-center rounded-lg"
              style={{
                width: 36,
                height: 36,
                background: 'var(--bg-sidebar-active)',
                color: 'var(--accent)',
              }}
            >
              <WIcon name="sparkle" size={16} />
            </span>
            <div className="flex-1 min-w-0">
              <h3 className="m-0 text-[15px] font-semibold text-foreground">
                {isEdit ? 'Edit auto-assignment' : 'New auto-assignment'}
              </h3>
              <div className="text-[12px] text-[var(--text-secondary)] mt-px">
                {isEdit
                  ? `${rule?.hcr ?? ''}${rule?.tripNumber ? ` · ${rule.tripNumber}` : ''}`
                  : 'Match incoming orders to a driver or carrier automatically.'}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="focus-ring w-7 h-7 rounded-md border-0 bg-transparent text-[var(--text-secondary)] cursor-pointer flex items-center justify-center hover:bg-[var(--bg-row-hover)]"
              aria-label="Close"
            >
              <WIcon name="close" size={14} />
            </button>
          </div>

          {/* Body: form + sticky preview */}
          <div className="flex-1 min-h-0 flex">
            <div className="scroll-thin flex-1 overflow-y-auto px-5 py-[18px]">
              {/* Identity */}
              <AASection icon="edit" title="Identity">
                <div className="grid grid-cols-1 gap-3">
                  <AAField
                    label="Rule name"
                    hint="Helps dispatchers identify this rule at a glance."
                  >
                    <AAInput
                      value={name}
                      onChange={setName}
                      placeholder="e.g. USPS 917DK → West Sacramento pool"
                    />
                  </AAField>
                </div>
              </AASection>

              {/* Trigger */}
              <AASection
                icon="filter"
                title="Match orders where"
                note="HCR is required. Trip number further narrows the match."
              >
                <div className="grid grid-cols-2 gap-3">
                  <AAField label="HCR contract" required>
                    <AASelect
                      value={hcr}
                      onChange={setHcr}
                      placeholder="Select HCR…"
                      options={
                        routes
                          ?.filter((r) => r.hcr && r.hcr.trim() !== '')
                          .map((r) => ({ value: r.hcr, label: r.hcr })) ?? []
                      }
                    />
                  </AAField>
                  <AAField label="Trip">
                    <AASelect
                      value={tripNumber}
                      onChange={setTripNumber}
                      placeholder={
                        !hcr
                          ? 'Select HCR first'
                          : availableTripNumbers.length === 0
                            ? 'Any trip'
                            : 'Any trip'
                      }
                      options={availableTripNumbers.map((t) => ({ value: t, label: t }))}
                    />
                  </AAField>
                </div>
              </AASection>

              {/* Assign to */}
              <AASection icon="users" title="Assign to">
                <div className="flex flex-col gap-2.5">
                  {/* Mode toggle */}
                  <div
                    className="inline-flex h-[30px] rounded-lg border border-[var(--border-hairline-strong)] overflow-hidden self-start"
                    style={{ background: 'var(--bg-surface)' }}
                  >
                    {[
                      { id: 'driver', label: 'Single driver' },
                      { id: 'carrier', label: 'Carrier' },
                    ].map((t, i) => {
                      const active = assigneeKind === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setAssigneeKind(t.id as AssigneeKind)}
                          className="focus-ring px-3 cursor-pointer font-sans text-[12px] h-full border-0"
                          style={{
                            background: active ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
                            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                            fontWeight: active ? 500 : 400,
                            borderLeft:
                              i > 0 ? '1px solid var(--border-hairline-strong)' : 'none',
                          }}
                        >
                          {t.label}
                        </button>
                      );
                    })}
                  </div>

                  {assigneeKind === 'driver' ? (
                    <AAField label="Driver" required>
                      <AASelect
                        value={driverId}
                        onChange={setDriverId}
                        placeholder="Select a driver…"
                        options={activeDrivers.map((d) => ({
                          value: d._id,
                          label: `${d.firstName} ${d.lastName}`,
                        }))}
                      />
                      {selectedDriverName && (
                        <div
                          className="mt-2 flex items-center gap-2.5 p-2 rounded-lg"
                          style={{
                            background: 'var(--bg-surface-2)',
                            border: '1px solid var(--border-hairline)',
                          }}
                        >
                          <Avatar name={selectedDriverName} size={22} />
                          <div className="flex-1 min-w-0">
                            <div className="text-[12.5px] font-medium truncate">
                              {selectedDriverName}
                            </div>
                            <div className="text-[11px] text-[var(--text-tertiary)] mt-px">
                              {selectedDriver?.licenseClass ?? 'Active driver'}
                            </div>
                          </div>
                        </div>
                      )}
                    </AAField>
                  ) : (
                    <AAField label="Carrier" required>
                      <AASelect
                        value={carrierId}
                        onChange={setCarrierId}
                        placeholder="Select a carrier…"
                        options={activeCarriers.map((c) => ({
                          value: c._id,
                          label: `${c.carrierName} · ${c.mcNumber}`,
                        }))}
                      />
                      {selectedCarrier && (
                        <div
                          className="mt-2 p-2 rounded-lg grid grid-cols-2 gap-2.5"
                          style={{
                            background: 'var(--bg-surface-2)',
                            border: '1px solid var(--border-hairline)',
                          }}
                        >
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
                              MC #
                            </div>
                            <div className="num text-[12px] font-medium mt-px">
                              {selectedCarrier.mcNumber}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
                              Status
                            </div>
                            <div className="text-[12px] font-medium mt-px">
                              {selectedCarrier.status}
                            </div>
                          </div>
                        </div>
                      )}
                    </AAField>
                  )}
                </div>
              </AASection>

              {/* Notes */}
              <AASection icon="chat" title="Notes">
                <AAField label="Internal notes">
                  <AATextarea
                    value={notes}
                    onChange={setNotes}
                    placeholder="Optional context for other dispatchers"
                    rows={3}
                  />
                </AAField>
              </AASection>

              {error && (
                <div
                  className="rounded-lg px-3 py-2 text-[12px] mb-3"
                  style={{
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.30)',
                    color: '#B43030',
                  }}
                >
                  {error}
                </div>
              )}
            </div>

            {/* Sticky preview rail */}
            <aside
              className="w-[248px] shrink-0 flex flex-col gap-4 px-[18px] py-[18px] overflow-auto"
              style={{
                background: 'var(--bg-surface-2)',
                borderLeft: '1px solid var(--border-hairline)',
              }}
            >
              <div>
                <div className="text-[10.5px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-1.5">
                  Live preview
                </div>
                <div className="text-[13px] font-medium text-foreground mb-0.5 truncate">
                  {previewName}
                </div>
                <div className="text-[11.5px] text-[var(--text-tertiary)] truncate">
                  {hcr
                    ? `HCR ${hcr}${tripNumber ? ` · Trip ${tripNumber}` : ''}`
                    : 'No trigger set'}
                </div>
              </div>

              <div className="h-px" style={{ background: 'var(--border-hairline)' }} />

              <SummaryItem icon="filter" label="Matches">
                <div className="flex flex-col gap-[3px]">
                  {hcr ? (
                    <SummaryLine value={`HCR ${hcr}`} mono />
                  ) : (
                    <SummaryLine value="No HCR set" />
                  )}
                  {tripNumber && <SummaryLine value={`Trip ${tripNumber}`} mono />}
                </div>
              </SummaryItem>

              <SummaryItem icon="users" label="Assignee">
                <SummaryLine
                  value={
                    assigneeKind === 'driver'
                      ? selectedDriverName ?? 'No driver selected'
                      : selectedCarrier?.carrierName ?? 'No carrier selected'
                  }
                />
              </SummaryItem>

              <div
                className="rounded-lg p-3"
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline-strong)',
                }}
              >
                <div className="text-[10.5px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-1">
                  Activation
                </div>
                <div className="text-[12px] text-foreground leading-[16px]">
                  {isEdit
                    ? 'Changes apply to future imports.'
                    : 'Rule activates immediately on save.'}
                </div>
              </div>
            </aside>
          </div>

          {/* Footer */}
          <div className="shrink-0 flex justify-between items-center gap-3 px-5 py-3 border-t border-[var(--border-hairline)]">
            <div className="text-[11.5px] text-[var(--text-tertiary)]">
              {isEdit ? 'Changes apply to incoming imports.' : 'Rule activates immediately on save.'}
            </div>
            <div className="flex gap-2">
              <WBtn size="sm" onClick={onClose}>
                Cancel
              </WBtn>
              <WBtn
                size="sm"
                variant="primary"
                leading={isSubmitting ? undefined : 'check'}
                type="submit"
                disabled={isSubmitting}
              >
                {isSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {isEdit ? 'Save changes' : 'Create rule'}
              </WBtn>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
