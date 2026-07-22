'use client';

/**
 * Driver Detail — Pay & expenses tab.
 *
 * Compensation card structure (per design Otoqa Web.html § DvPay):
 *   • Default profile sub-block — read-only snapshot rows (Pay model + name
 *     + basis chip, Rate, Empty %, Detention, Bonus). Values are derived
 *     from the assigned profile's BASE/MILE_EMPTY/TIME_WAITING/ACCESSORIAL
 *     rules (server enriches in driverProfileAssignments.getForDriver).
 *   • Conditional overrides sub-block — non-default assignments listed as
 *     "Additional · {profileName} · {summary}". The design expects a true
 *     condition field on the assignment (e.g. "Route is local") which our
 *     schema does not have yet — see TODO below.
 *   • Hairline divider + Account block — Direct dep. / YTD gross. Neither
 *     is on the driver schema today, so they render as "—" placeholders.
 *
 * "Manage pay profiles" sheet (full-page only) lets the user pick a default
 * profile and add/remove additional profile assignments. Profile values
 * themselves are managed in the Pay plans modal on the Pay profiles page.
 *
 * TODO: Add an optional `condition` enum field to driverProfileAssignments
 * (route-local · route-otr · route-regional · team-trip · hazmat-trip ·
 * weekend) so overrides can carry a condition rather than just being
 * "additional". Once the schema lands, surface it on each override row and
 * let the sheet pick a condition per added profile.
 */

import * as React from 'react';
import { useMutation, useQuery } from 'convex/react';

import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';

import {
  Chip,
  DSCard,
  DSMiniTable,
  type DSMiniColumn,
  DSProps,
  type DSPropItem,
  WBtn,
  WIcon,
} from '@/components/web';

// ─── Display helpers ─────────────────────────────────────────────────────

type PayBasis = 'MILEAGE' | 'HOURLY' | 'PERCENTAGE' | 'FLAT';

function basisLabel(b?: PayBasis): string {
  switch (b) {
    case 'MILEAGE':    return 'Per-mile';
    case 'HOURLY':     return 'Hourly';
    case 'PERCENTAGE': return 'Percentage';
    case 'FLAT':       return 'Flat';
    default:           return '—';
  }
}

function fmtRate(amount: number | undefined, basis?: PayBasis): string {
  if (amount == null) return '—';
  if (basis === 'PERCENTAGE') return `${amount.toFixed(1)}% of load`;
  if (basis === 'HOURLY')     return `$${amount.toFixed(2)} / hr`;
  if (basis === 'FLAT')       return `$${amount.toFixed(2)} / trip`;
  return `$${amount.toFixed(2)} / mi`;
}

function fmtEmpty(rate: number | undefined): string {
  if (rate == null) return '—';
  // Stored as either an absolute rate ($/mi) or a fraction. Heuristic: > 1
  // → dollar rate; ≤ 1 → percentage of base.
  if (rate <= 1) return `${Math.round(rate * 100)}%`;
  return `$${rate.toFixed(2)} / mi`;
}

function fmtDetention(rate: number | undefined, after: number | undefined, cap: number | undefined): string {
  if (rate == null) return '—';
  const base = `$${rate.toFixed(0)}/hr`;
  const tail = [
    after != null && after > 0 ? `after ${after}h` : null,
    cap != null && cap > 0 ? `cap $${cap.toFixed(0)}` : null,
  ].filter(Boolean).join(' · ');
  return tail ? `${base} · ${tail}` : base;
}

// ─── Default-profile snapshot ────────────────────────────────────────────

type AssignmentRow = NonNullable<ReturnType<typeof useQuery<typeof api.driverProfileAssignments.getForDriver>>>[number];

function ProfileSnapshot({ assignment }: { assignment: AssignmentRow | null }) {
  if (!assignment || !assignment.profileName) {
    return (
      <DSProps
        items={[{ label: 'Pay model', value: <span className="text-[var(--text-tertiary)] italic">None assigned</span> }]}
      />
    );
  }
  const basis = assignment.profilePayBasis as PayBasis | undefined;
  const rows: DSPropItem[] = [
    {
      label: 'Pay model',
      value: (
        <span className="inline-flex items-center gap-2">
          <span className="font-medium text-foreground">{assignment.profileName}</span>
          <span className="px-1.5 py-px rounded-full text-[11px] text-[var(--text-tertiary)] bg-[var(--bg-surface-2)] border border-[var(--border-hairline)]">
            {basisLabel(basis)}
          </span>
        </span>
      ),
    },
    { label: 'Rate',      value: <span className="num">{fmtRate(assignment.baseRate, basis)}</span> },
    { label: 'Empty %',   value: <span className="num">{fmtEmpty(assignment.emptyMileRate)}</span> },
    { label: 'Detention', value: <span className="num">{fmtDetention(assignment.detentionRate, assignment.detentionMinHours, assignment.detentionMaxCap)}</span> },
    { label: 'Bonus',     value: assignment.bonusSummary || '—' },
  ];
  return <DSProps items={rows} />;
}

// ─── Tab component ───────────────────────────────────────────────────────

interface DriverPayExpensesTabProps {
  driverId: Id<'drivers'>;
  organizationId: string;
  userId: string;
  /** When true, surfaces the "Manage pay profiles" affordance. The
   *  slide-over passes false to keep the read-only flat view. */
  editable?: boolean;
}

export function DriverPayExpensesTab({
  driverId,
  organizationId,
  userId,
  editable = true,
}: DriverPayExpensesTabProps) {
  const assignments = useQuery(api.driverProfileAssignments.getForDriver, { driverId });
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const list = assignments ?? [];
  const defaultAssign = list.find((a) => a.isDefault) ?? null;
  const overrides = list.filter((a) => !a.isDefault);

  const accountRows: DSPropItem[] = [
    { label: 'Direct dep.', value: '—' },
    { label: 'YTD gross',   value: '—' },
  ];

  return (
    <div className="flex flex-col gap-3">
      <DSCard
        title="Compensation"
        action={editable ? (
          <WBtn size="sm" leading="edit" onClick={() => setSheetOpen(true)}>
            Manage pay profiles
          </WBtn>
        ) : undefined}
        bodyClassName="flex flex-col gap-3.5"
      >
        <SubHeader>Default profile</SubHeader>
        {assignments === undefined ? (
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)]">Loading…</p>
        ) : (
          <ProfileSnapshot assignment={defaultAssign} />
        )}

        {overrides.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <SubHeader>{`Additional profiles (${overrides.length})`}</SubHeader>
            <div className="flex flex-col gap-1.5">
              {overrides.map((a) => (
                <div
                  key={a._id}
                  className="flex items-center gap-2.5 px-2.5 py-2 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface-2)]"
                >
                  <span className="px-1.5 py-px rounded-full text-[10.5px] font-medium text-[var(--text-secondary)] bg-[var(--bg-surface)] border border-[var(--border-hairline)] whitespace-nowrap">
                    Additional
                  </span>
                  <span className="text-[12.5px] font-medium text-foreground">{a.profileName ?? '—'}</span>
                  <span className="ml-auto text-[11px] text-[var(--text-tertiary)] whitespace-nowrap overflow-hidden text-ellipsis">
                    {basisLabel(a.profilePayBasis as PayBasis | undefined)}
                    {a.baseRate != null ? ` · ${fmtRate(a.baseRate, a.profilePayBasis as PayBasis | undefined)}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="h-px bg-[var(--border-hairline)]" />
        <DSProps items={accountRows} />
      </DSCard>

      <DSCard title="Recent expenses" bodyClassName="p-0">
        <RecentExpensesEmpty />
      </DSCard>

      {sheetOpen && (
        <ManagePayProfilesSheet
          driverId={driverId}
          organizationId={organizationId}
          userId={userId}
          assignments={list}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  );
}

function SubHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10.5px] font-semibold tracking-[0.04em] uppercase text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}

function RecentExpensesEmpty() {
  // Schema for driver expenses doesn't exist yet. Render a tasteful empty
  // state with a column header so the card has visible chrome.
  const cols: DSMiniColumn<{ id: string }>[] = [
    { key: 'date',   label: 'Date',        width: '90px' },
    { key: 'cat',    label: 'Category',    width: '120px' },
    { key: 'desc',   label: 'Description', width: '1.4fr' },
    { key: 'amt',    label: 'Amount',      width: '90px', align: 'right' },
  ];
  return (
    <div>
      <DSMiniTable columns={cols} rows={[]} className="rounded-t-none border-0 border-t" />
      <div className="px-4 py-6 text-center text-[12px] text-[var(--text-tertiary)]">
        No expenses logged. Fuel cards, lumper fees, and per-diem will appear here.
      </div>
    </div>
  );
}

// ─── Manage pay profiles sheet ───────────────────────────────────────────

interface ManagePayProfilesSheetProps {
  driverId: Id<'drivers'>;
  organizationId: string;
  userId: string;
  assignments: AssignmentRow[];
  onClose: () => void;
}

function ManagePayProfilesSheet({
  driverId,
  organizationId,
  userId,
  assignments,
  onClose,
}: ManagePayProfilesSheetProps) {
  const profiles = useQuery(api.rateProfiles.list, { workosOrgId: organizationId, profileType: 'DRIVER' });
  const assignProfile = useMutation(api.driverProfileAssignments.assign);
  const removeAssignment = useMutation(api.driverProfileAssignments.remove);
  const setDefaultAssignment = useMutation(api.driverProfileAssignments.setDefault);

  const defaultAssign = assignments.find((a) => a.isDefault) ?? null;
  const overrides = assignments.filter((a) => !a.isDefault);

  const setAsDefault = async (profileId: string) => {
    const existing = assignments.find((a) => a.profileId === profileId);
    if (existing) {
      if (!existing.isDefault) {
        await setDefaultAssignment({ assignmentId: existing._id, userId });
      }
      return;
    }
    // Not yet assigned — assign, then mark default.
    const newId = await assignProfile({ driverId, profileId: profileId as Id<'rateProfiles'>, userId });
    if (newId) await setDefaultAssignment({ assignmentId: newId, userId });
  };

  const addOverride = async (profileId: string) => {
    if (assignments.some((a) => a.profileId === profileId)) return;
    await assignProfile({ driverId, profileId: profileId as Id<'rateProfiles'>, userId });
  };

  const removeOverride = async (assignmentId: Id<'driverProfileAssignments'>) => {
    await removeAssignment({ assignmentId, userId });
  };

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const profileOptions = (profiles ?? []).map((p) => ({
    value: p._id as string,
    label: p.name,
    summary: p.description ?? basisLabel(p.payBasis as PayBasis),
    basis: p.payBasis as PayBasis,
  }));

  // Profiles not yet assigned at all — eligible for the override picker.
  const unassignedProfiles = profileOptions.filter(
    (o) => !assignments.some((a) => (a.profileId as unknown as string) === o.value),
  );

  return (
    <div
      onMouseDown={onClose}
      className="fixed inset-0 z-[80] flex items-center justify-center p-6"
      style={{ background: 'rgba(15, 22, 36, 0.32)' }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[580px] max-w-full max-h-[90vh] flex flex-col overflow-hidden rounded-[10px] border border-[var(--border-hairline-strong)] bg-card"
        style={{ boxShadow: 'var(--shadow-popover)' }}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-[var(--border-hairline)] flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold text-foreground">Manage pay profiles</div>
            <div className="text-[11.5px] text-[var(--text-tertiary)] mt-0.5">
              Pick a default profile and add additional profile assignments. Profile values are managed in{' '}
              <span className="text-[var(--accent)]">Settings → Pay profiles</span>.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring h-6 w-6 inline-flex items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)]"
          >
            <WIcon name="close" size={12} />
          </button>
        </div>

        {/* Body */}
        <div className="scroll-thin p-4 overflow-auto flex flex-col gap-[18px]">
          <section className="flex flex-col gap-2">
            <SheetLabel>Default profile</SheetLabel>
            <div className="text-[11.5px] text-[var(--text-tertiary)]">
              Applies whenever no override is in effect.
            </div>
            <ProfileSelect
              value={defaultAssign?.profileId as string | undefined}
              options={profileOptions}
              onChange={setAsDefault}
              loading={profiles === undefined}
            />
          </section>

          <section className="flex flex-col gap-2">
            <SheetLabel>Additional profiles</SheetLabel>
            <div className="text-[11.5px] text-[var(--text-tertiary)]">
              Extra profiles assigned to this driver. Conditional matching (e.g. by route or
              equipment) is coming soon.
            </div>
            <div className="flex flex-col gap-2">
              {overrides.map((a) => (
                <div
                  key={a._id}
                  className="grid grid-cols-[1fr_24px] gap-2 items-center"
                >
                  <ProfileSelect
                    value={a.profileId as string}
                    options={profileOptions}
                    onChange={() => {}}
                    compact
                    readOnly
                  />
                  <button
                    type="button"
                    onClick={() => removeOverride(a._id as Id<'driverProfileAssignments'>)}
                    className="focus-ring h-6 w-6 inline-flex items-center justify-center rounded border border-[var(--border-hairline)] bg-card text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)]"
                    title="Remove profile"
                  >
                    <WIcon name="close" size={10} />
                  </button>
                </div>
              ))}
              {unassignedProfiles.length > 0 ? (
                <AddProfileButton options={unassignedProfiles} onPick={addOverride} />
              ) : (
                <div className="text-[11.5px] text-[var(--text-tertiary)]">All profiles already assigned.</div>
              )}
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-[var(--border-hairline)] flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--text-tertiary)]">
            Changes save automatically · <kbd className="px-1 py-px rounded border border-[var(--border-hairline)] text-[10px]">esc</kbd> to close
          </span>
          <WBtn size="sm" variant="primary" onClick={onClose}>
            Done
          </WBtn>
        </div>
      </div>
    </div>
  );
}

function SheetLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}

interface ProfileOption {
  value: string;
  label: string;
  summary: string;
  basis: PayBasis;
}

interface ProfileSelectProps {
  value: string | undefined;
  options: ProfileOption[];
  onChange: (next: string) => void;
  compact?: boolean;
  loading?: boolean;
  readOnly?: boolean;
}

function ProfileSelect({ value, options, onChange, compact, loading, readOnly }: ProfileSelectProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const sel = options.find((o) => o.value === value);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => !readOnly && !loading && setOpen((o) => !o)}
        disabled={readOnly || loading}
        className="focus-ring w-full text-left flex items-center gap-2.5 rounded-md border border-[var(--border-hairline)] bg-card text-foreground disabled:cursor-not-allowed"
        style={{ padding: compact ? '6px 10px' : '10px 12px' }}
      >
        <span
          className={
            'flex flex-1 min-w-0 ' +
            (compact ? 'flex-row items-center gap-2' : 'flex-col items-start gap-0.5')
          }
        >
          <span className={'text-[12.5px] font-semibold ' + (sel ? 'text-foreground' : 'text-[var(--text-tertiary)]')}>
            {loading ? 'Loading…' : sel ? sel.label : 'Pick a profile…'}
          </span>
          {sel && (
            <span className="text-[11px] text-[var(--text-tertiary)] truncate min-w-0">
              {basisLabel(sel.basis)}
              {sel.summary && sel.summary !== basisLabel(sel.basis) ? ` · ${sel.summary}` : ''}
            </span>
          )}
        </span>
        {!readOnly && <WIcon name="chevron-down" size={11} color="var(--text-tertiary)" />}
      </button>
      {open && (
        <div
          className="scroll-thin absolute left-0 right-0 z-[5] mt-1 max-h-[280px] overflow-auto rounded-lg border border-[var(--border-hairline-strong)] bg-card p-1"
          style={{ boxShadow: 'var(--shadow-popover)' }}
        >
          {options.map((o) => {
            const on = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={
                  'focus-ring w-full text-left flex items-start gap-2 px-2.5 py-2 rounded ' +
                  (on ? 'bg-[var(--bg-row-hover)]' : 'hover:bg-[var(--bg-row-hover)]')
                }
              >
                <span className="flex-1 min-w-0">
                  <span className="flex items-baseline gap-1.5 mb-0.5">
                    <span className="text-[12.5px] font-semibold text-foreground">{o.label}</span>
                    <span className="text-[10.5px] text-[var(--text-tertiary)]">{basisLabel(o.basis)}</span>
                  </span>
                  {o.summary && o.summary !== basisLabel(o.basis) && (
                  <span className="block text-[11px] text-[var(--text-secondary)]">{o.summary}</span>
                )}
                </span>
                {on && <WIcon name="check" size={12} color="var(--accent)" className="mt-1" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AddProfileButton({
  options,
  onPick,
}: {
  options: ProfileOption[];
  onPick: (profileId: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="focus-ring self-start inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-dashed border-[var(--border-hairline-strong)] bg-transparent text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)]"
      >
        <WIcon name="plus" size={11} /> Add profile
      </button>
      {open && (
        <div
          className="scroll-thin absolute left-0 z-[5] mt-1 min-w-[260px] max-h-[280px] overflow-auto rounded-lg border border-[var(--border-hairline-strong)] bg-card p-1"
          style={{ boxShadow: 'var(--shadow-popover)' }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onPick(o.value);
                setOpen(false);
              }}
              className="focus-ring w-full text-left flex items-start gap-2 px-2.5 py-2 rounded hover:bg-[var(--bg-row-hover)]"
            >
              <span className="flex-1 min-w-0">
                <span className="flex items-baseline gap-1.5 mb-0.5">
                  <span className="text-[12.5px] font-semibold text-foreground">{o.label}</span>
                  <span className="text-[10.5px] text-[var(--text-tertiary)]">{basisLabel(o.basis)}</span>
                </span>
                {o.summary && o.summary !== basisLabel(o.basis) && (
                  <span className="block text-[11px] text-[var(--text-secondary)]">{o.summary}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Suppress unused-warning for Chip — kept on the import in case the override
// row evolves to use status chips.
void Chip;
