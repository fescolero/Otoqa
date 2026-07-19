'use client';

/**
 * PayPlansModal — settlement cadence manager, overlaying the Pay profiles
 * page (design: settings-screen.jsx > PayPlansModal).
 *
 * A plan rail on the left (active plans, archived group, "New pay plan"), an
 * editor on the right (name/description, frequency with per-frequency anchor
 * controls, pay-lag stepper, live "Next 3 pay periods" preview, and an
 * Advanced disclosure for the engine fields: cutoff, timezone, payable
 * trigger, currency, amendment policy, carryover toggles), and a guarded
 * footer (archive/restore/default + Cancel/Save).
 *
 * Edits are local to a draft until "Save plan" commits via create/update
 * (which also closes the modal, per the design). Escape / overlay click /
 * Cancel close without saving.
 */

import * as React from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useOrganizationId } from '@/contexts/organization-context';
import { WBtn, WIcon } from '@/components/web';
import { toast } from 'sonner';

// ── engine value maps ───────────────────────────────────────────────────────

type Frequency = 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY';
type PayableTrigger = 'DELIVERY_DATE' | 'COMPLETION_DATE' | 'APPROVAL_DATE';
type AmendmentPolicy = 'REJECT_LATE_CHANGES' | 'CASCADE_TO_NEXT' | 'REOPEN_ALLOWED';
type Currency = 'USD' | 'CAD' | 'MXN';
type DayName = 'SUNDAY' | 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY';

const DOW_NAMES: DayName[] = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const FREQS: Array<{ id: Frequency; label: string }> = [
  { id: 'WEEKLY', label: 'Weekly' },
  { id: 'BIWEEKLY', label: 'Bi-weekly' },
  { id: 'SEMIMONTHLY', label: 'Semi-monthly' },
  { id: 'MONTHLY', label: 'Monthly' },
];
const TRIGGERS: Array<{ id: PayableTrigger; label: string }> = [
  { id: 'DELIVERY_DATE', label: 'Delivery date' },
  { id: 'COMPLETION_DATE', label: 'Completion date' },
  { id: 'APPROVAL_DATE', label: 'Approval date' },
];
const AMEND: Array<{ id: AmendmentPolicy; label: string }> = [
  { id: 'REJECT_LATE_CHANGES', label: 'Reject late changes' },
  { id: 'CASCADE_TO_NEXT', label: 'Cascade to next period' },
  { id: 'REOPEN_ALLOWED', label: 'Reopen period' },
];
const CURRENCIES: Currency[] = ['USD', 'CAD', 'MXN'];
const TIMEZONES: Array<{ id: string; label: string }> = [
  { id: '', label: 'Org default' },
  { id: 'America/New_York', label: 'America/New_York' },
  { id: 'America/Chicago', label: 'America/Chicago' },
  { id: 'America/Denver', label: 'America/Denver' },
  { id: 'America/Los_Angeles', label: 'America/Los_Angeles' },
  { id: 'America/Phoenix', label: 'America/Phoenix' },
];

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// Period boundaries are computed at UTC midnights on the server (Convex runs
// in UTC), so they're formatted in UTC too — otherwise a viewer west of
// Greenwich sees every boundary a day early (pick July 16, read "Jul 15").
const fmtShort = (t: number) =>
  new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtFull = (t: number) =>
  new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const sameMonth = (a: number, b: number) => {
  const da = new Date(a), db = new Date(b);
  return da.getUTCMonth() === db.getUTCMonth() && da.getUTCFullYear() === db.getUTCFullYear();
};

// ── draft state ─────────────────────────────────────────────────────────────

interface Draft {
  name: string;
  description: string;
  frequency: Frequency;
  /** Weekly: the day the period CLOSES on (design framing). */
  endDow: number;
  /** Bi-weekly: the date the first period starts ("YYYY-MM-DD"). */
  biweeklyAnchor: string;
  /** Monthly: day of the month the period starts on (1–28). */
  startDom: number;
  paymentLagDays: number;
  cutoffTime: string;
  timezone: string;
  payableTrigger: PayableTrigger;
  currency: Currency;
  amendmentPolicy: AmendmentPolicy;
  autoCarryover: boolean;
  includeStandaloneAdjustments: boolean;
}

type PlanRow = NonNullable<ReturnType<typeof usePlans>>[number];
function usePlans(workosOrgId: string | null) {
  return useQuery(
    api.payPlans.list,
    workosOrgId ? { workosOrgId, includeInactive: true } : 'skip',
  );
}

const newDraft = (): Draft => ({
  name: 'New plan',
  description: '',
  frequency: 'WEEKLY',
  endDow: 6,
  biweeklyAnchor: todayISO(),
  startDom: 1,
  paymentLagDays: 5,
  cutoffTime: '17:00',
  timezone: '',
  payableTrigger: 'DELIVERY_DATE',
  currency: 'USD',
  amendmentPolicy: 'CASCADE_TO_NEXT',
  autoCarryover: true,
  includeStandaloneAdjustments: true,
});

function draftFromPlan(p: PlanRow): Draft {
  const startDow = p.periodStartDayOfWeek ? DOW_NAMES.indexOf(p.periodStartDayOfWeek) : 0;
  return {
    name: p.name,
    description: p.description ?? '',
    frequency: p.frequency,
    // Engine stores the START day; the design edits the day the period
    // CLOSES on. A 7-day period starting Sunday closes Saturday.
    endDow: (startDow + 6) % 7,
    biweeklyAnchor: p.biweeklyAnchor ?? todayISO(),
    startDom: p.periodStartDayOfMonth ?? 1,
    paymentLagDays: p.paymentLagDays,
    cutoffTime: p.cutoffTime,
    timezone: p.timezone ?? '',
    payableTrigger: p.payableTrigger,
    currency: (p.currency as Currency | undefined) ?? 'USD',
    amendmentPolicy: (p.amendmentPolicy as AmendmentPolicy | undefined) ?? 'CASCADE_TO_NEXT',
    autoCarryover: p.autoCarryover,
    includeStandaloneAdjustments: p.includeStandaloneAdjustments,
  };
}

/** Engine-shaped schedule fields from a draft (shared by save + preview). */
function scheduleArgs(d: Draft) {
  return {
    frequency: d.frequency,
    periodStartDayOfWeek:
      d.frequency === 'WEEKLY' ? DOW_NAMES[(d.endDow + 1) % 7] : undefined,
    periodStartDayOfMonth: d.frequency === 'MONTHLY' ? d.startDom : undefined,
    biweeklyAnchor: d.frequency === 'BIWEEKLY' ? d.biweeklyAnchor : undefined,
    paymentLagDays: d.paymentLagDays,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Modal
// ═══════════════════════════════════════════════════════════════════════════

export function PayPlansModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const workosOrgId = useOrganizationId();
  const plans = usePlans(workosOrgId);

  const createPlan = useMutation(api.payPlans.create);
  const updatePlan = useMutation(api.payPlans.update);
  const archivePlan = useMutation(api.payPlans.archive);
  const restorePlan = useMutation(api.payPlans.restore);

  const [selId, setSelId] = React.useState<Id<'payPlans'> | 'new' | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [advOpen, setAdvOpen] = React.useState(false);
  const [confirmArch, setConfirmArch] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const active = React.useMemo(() => (plans ?? []).filter((p) => p.isActive), [plans]);
  const archived = React.useMemo(() => (plans ?? []).filter((p) => !p.isActive), [plans]);
  const sel = selId && selId !== 'new' ? (plans ?? []).find((p) => p._id === selId) ?? null : null;

  // Select the first plan once loaded; reload the draft when selection or the
  // server copy changes (a save round-trips through the reactive query).
  React.useEffect(() => {
    if (selId === null && plans && plans.length > 0) {
      const first = plans.find((p) => p.isActive) ?? plans[0];
      setSelId(first._id);
    }
  }, [plans, selId]);
  React.useEffect(() => {
    setConfirmArch(false);
    setAdvOpen(false);
    if (selId === 'new') setDraft(newDraft());
    else if (sel) setDraft(draftFromPlan(sel));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Chromium picks a wheel target by walking up from the cursor and SKIPS
  // scroll containers with nothing to scroll — overscroll-behavior never
  // engages on those, so a wheel over the rail's empty space, the header, or
  // the footer fell through and scrolled the page BEHIND the modal. Verified
  // in a standalone repro. Fix: intercept wheel on the overlay and let it
  // through only when an inner pane between the cursor and the overlay can
  // actually consume it (that pane's own overscroll-contain handles its
  // scroll end); kill everything else. Non-passive on purpose.
  const overlayRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      let node = e.target as HTMLElement | null;
      while (node && node !== el) {
        if (node.scrollHeight > node.clientHeight + 1) {
          const st = getComputedStyle(node);
          if (st.overflowY === 'auto' || st.overflowY === 'scroll') return;
        }
        node = node.parentElement;
      }
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const patch = (changes: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...changes } : d));

  // Live preview — backend-computed so the page shows the engine's real math.
  const previewReady =
    !!draft && (draft.frequency !== 'BIWEEKLY' || /^\d{4}-\d{2}-\d{2}$/.test(draft.biweeklyAnchor));
  const preview = useQuery(
    api.payPlans.previewPeriods,
    draft && previewReady ? scheduleArgs(draft) : 'skip',
  );

  const save = async () => {
    if (!draft || !workosOrgId || !user) return;
    if (!draft.name.trim()) { toast.error('Give the plan a name first.'); return; }
    setSaving(true);
    try {
      const common = {
        name: draft.name.trim(),
        description: draft.description,
        ...scheduleArgs(draft),
        timezone: draft.timezone || undefined,
        cutoffTime: draft.cutoffTime,
        payableTrigger: draft.payableTrigger,
        autoCarryover: draft.autoCarryover,
        includeStandaloneAdjustments: draft.includeStandaloneAdjustments,
        currency: draft.currency,
        amendmentPolicy: draft.amendmentPolicy,
      };
      if (selId === 'new') {
        await createPlan({
          workosOrgId,
          ...common,
          description: draft.description || undefined,
          userId: user.id,
        });
        toast.success('Pay plan created');
      } else if (selId) {
        await updatePlan({ planId: selId, ...common });
        toast.success('Pay plan saved');
      }
      // Design semantics: the modal commits and closes on save.
      onClose();
    } catch (err) {
      toast.error("Couldn't save the plan", { description: errMsg(err) });
    } finally {
      setSaving(false);
    }
  };

  const doArchive = async () => {
    if (!sel) return;
    try {
      await archivePlan({ planId: sel._id });
      toast.success(`Archived "${sel.name}"`);
      const next = active.find((p) => p._id !== sel._id);
      if (next) setSelId(next._id);
    } catch (err) {
      toast.error("Couldn't archive the plan", { description: errMsg(err) });
    } finally {
      setConfirmArch(false);
    }
  };
  const doRestore = async () => {
    if (!sel) return;
    try {
      await restorePlan({ planId: sel._id });
      toast.success(`Restored "${sel.name}"`);
    } catch (err) {
      toast.error("Couldn't restore the plan", { description: errMsg(err) });
    }
  };
  const makeDefault = async () => {
    if (!sel) return;
    try {
      await updatePlan({ planId: sel._id, isDefault: true });
      toast.success(`"${sel.name}" is now the default plan`);
    } catch (err) {
      toast.error("Couldn't set the default", { description: errMsg(err) });
    }
  };

  const canArchive = !!sel && sel.isActive && !sel.isDefault && sel.driverCount === 0;

  return (
    <div
      ref={overlayRef}
      onMouseDown={onClose}
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 80, background: 'rgba(15,22,36,0.32)', padding: 24, overflowY: 'auto', overscrollBehavior: 'contain' }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 720,
          maxWidth: '100%',
          // Fixed height (not content-sized): the dialog must not resize as
          // the plan list and draft stream in — loading skeletons below fill
          // the same box, so nothing snaps when data lands. Sized to the
          // viewport (90vh) so tall screens get a taller modal, capped so it
          // doesn't sprawl on very large displays.
          height: 'min(880px, 90vh)',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 10,
          boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* header */}
        <div
          className="flex items-start justify-between gap-3"
          style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-hairline)' }}
        >
          <div className="min-w-0">
            <div
              className="uppercase"
              style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.5, color: 'var(--text-tertiary)', marginBottom: 3 }}
            >
              Payroll & money
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.2, color: 'var(--text-primary)' }}>Pay plans</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
              How often settlements run. Assign a plan to any driver.
            </div>
          </div>
          <button
            onClick={onClose}
            className="focus-ring inline-flex items-center justify-center rounded-[5px] shrink-0"
            style={{ width: 26, height: 26, border: 0, background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer' }}
          >
            <WIcon name="close" size={13} />
          </button>
        </div>

        {/* body: plan rail + editor. The single row is pinned to the
            available height so both panes scroll inside the 86vh dialog. */}
        <div
          className="flex-1"
          style={{ display: 'grid', gridTemplateColumns: '218px minmax(0,1fr)', gridTemplateRows: 'minmax(0, 1fr)', minHeight: 0 }}
        >
            {/* ── plan rail ─────────────────────────────────────────────── */}
            <div
              className="scroll-thin"
              style={{
                borderRight: '1px solid var(--border-hairline)',
                background: 'var(--bg-surface-2)',
                overflow: 'auto',
                overscrollBehavior: 'contain',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div style={{ flex: 1 }}>
                {plans === undefined &&
                  Array.from({ length: 3 }).map((_, i) => <RailRowSkeleton key={i} />)}
                {active.map((p) => (
                  <RailRow key={p._id} plan={p} active={selId === p._id} onSelect={() => setSelId(p._id)} />
                ))}
                {selId === 'new' && draft && (
                  <RailRowNewDraft name={draft.name} />
                )}
                {archived.length > 0 && (
                  <div
                    className="uppercase"
                    style={{ padding: '10px 14px 5px', fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: 'var(--text-tertiary)' }}
                  >
                    Archived
                  </div>
                )}
                {archived.map((p) => (
                  <RailRow key={p._id} plan={p} active={selId === p._id} archived onSelect={() => setSelId(p._id)} />
                ))}
              </div>
              <button
                onClick={() => setSelId('new')}
                className="focus-ring inline-flex items-center gap-2 w-full text-left shrink-0"
                style={{
                  padding: '11px 14px', border: 0, borderTop: '1px solid var(--border-hairline)',
                  background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: 'var(--accent)',
                }}
              >
                <WIcon name="plus" size={13} /> New pay plan
              </button>
            </div>

            {/* ── editor ────────────────────────────────────────────────── */}
            <div
              className="scroll-thin"
              style={{ overflow: 'auto', overscrollBehavior: 'contain', padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              {!draft ? (
                plans !== undefined && plans.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', padding: 8 }}>
                    No pay plans yet — use &quot;New pay plan&quot; to create the first one.
                  </div>
                ) : (
                  // Loading (or selection settling) — a full-size stand-in for
                  // the editor so the pane doesn't grow when the draft lands.
                  <EditorSkeleton />
                )
              ) : (
                <>
                  <PPField label="Plan name">
                    <input
                      value={draft.name}
                      onChange={(e) => patch({ name: e.target.value })}
                      className="focus-ring"
                      style={{ ...INPUT, width: '100%' }}
                    />
                  </PPField>

                  <PPField label="Description" hint="Optional — shown on driver settlements and the plan list.">
                    <input
                      value={draft.description}
                      onChange={(e) => patch({ description: e.target.value })}
                      placeholder="What this plan is for"
                      className="focus-ring"
                      style={{ ...INPUT, width: '100%' }}
                    />
                  </PPField>

                  <PPField label="Frequency">
                    <Segmented
                      options={FREQS.map((f) => ({ value: f.id, label: f.label }))}
                      value={draft.frequency}
                      onChange={(v) => patch({ frequency: v as Frequency })}
                    />
                  </PPField>

                  {draft.frequency === 'WEEKLY' && (
                    <PPField label="Period closes on" hint="Each pay period is the 7 days ending on this weekday.">
                      <Segmented
                        options={DOW_SHORT.map((d, i) => ({ value: String(i), label: d }))}
                        value={String(draft.endDow)}
                        onChange={(v) => patch({ endDow: +v })}
                        dense
                      />
                    </PPField>
                  )}

                  {draft.frequency === 'BIWEEKLY' && (
                    <PPField
                      label="First period starts"
                      hint="This is the important one. Every 14-day cycle counts forward from this date — set it to control which weeks land in which month."
                    >
                      <input
                        type="date"
                        value={draft.biweeklyAnchor}
                        onChange={(e) => patch({ biweeklyAnchor: e.target.value })}
                        className="num focus-ring"
                        style={{ ...INPUT, width: 180 }}
                      />
                    </PPField>
                  )}

                  {draft.frequency === 'SEMIMONTHLY' && (
                    <InfoBanner>
                      Two periods per month — <strong style={{ fontWeight: 600 }}>1st–15th</strong> and{' '}
                      <strong style={{ fontWeight: 600 }}>16th–end of month</strong>. Always aligns to the calendar, so
                      it never crosses a month boundary.
                    </InfoBanner>
                  )}

                  {draft.frequency === 'MONTHLY' && (
                    <PPField
                      label="Period starts on day"
                      hint={
                        draft.startDom === 1
                          ? 'Day 1 → the full calendar month (1st to the last day). Never crosses a month.'
                          : `Each period runs the ${ordinal(draft.startDom)} → ${ordinal(((draft.startDom + 26) % 28) + 1)} of the next month, so it crosses the boundary.`
                      }
                    >
                      <div className="inline-flex items-center gap-2">
                        <Stepper value={draft.startDom} onChange={(v) => patch({ startDom: v })} min={1} max={28} />
                        <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>of the month</span>
                      </div>
                    </PPField>
                  )}

                  <PPField
                    label="Pay drivers"
                    hint={
                      draft.frequency === 'WEEKLY'
                        ? `Settlements pay out on ${DOW_SHORT[(draft.endDow + draft.paymentLagDays) % 7]}.`
                        : 'Days after the period closes before the settlement pays out.'
                    }
                  >
                    <div className="inline-flex items-center gap-2">
                      <Stepper value={draft.paymentLagDays} onChange={(v) => patch({ paymentLagDays: v })} min={0} max={14} />
                      <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                        day{draft.paymentLagDays === 1 ? '' : 's'} after period closes
                      </span>
                    </div>
                  </PPField>

                  {/* live preview — engine-computed periods */}
                  <div className="shrink-0" style={{ borderRadius: 9, border: '1px solid var(--border-hairline)', overflow: 'hidden' }}>
                    <div
                      className="flex items-center gap-2"
                      style={{ padding: '8px 12px', background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border-hairline)' }}
                    >
                      <WIcon name="calendar" size={13} color="var(--text-tertiary)" />
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>Next 3 pay periods</span>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                        · from today, {fmtShort(Date.now())}
                      </span>
                    </div>
                    {!previewReady || preview === undefined ? (
                      <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-tertiary)' }}>
                        {previewReady ? 'Computing…' : 'Set the first period start date to preview.'}
                      </div>
                    ) : preview.length === 0 ? (
                      // The engine always returns 3 periods — an empty result
                      // means the deployed backend is behind this UI (e.g.
                      // `npx convex dev` not running / failed to push).
                      <div style={{ padding: '10px 12px', fontSize: 12, color: '#A66800' }}>
                        Couldn&apos;t compute the preview — the backend looks out of date. Make sure the Convex
                        deploy is current, then reopen.
                      </div>
                    ) : (
                      preview.map((pr, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2.5"
                          style={{ padding: '9px 12px', borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)' }}
                        >
                          <span className="num" style={{ fontSize: 12.5, color: 'var(--text-primary)', minWidth: 128 }}>
                            {fmtShort(pr.periodStart)} – {fmtShort(pr.periodEnd)}
                          </span>
                          {!sameMonth(pr.periodStart, pr.periodEnd) && (
                            <span
                              className="whitespace-nowrap"
                              style={{ fontSize: 10, fontWeight: 600, color: '#A66800', background: 'rgba(166,104,0,0.10)', padding: '1px 6px', borderRadius: 4 }}
                            >
                              crosses month
                            </span>
                          )}
                          <span className="flex-1" />
                          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>pays</span>
                          <span className="num" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                            {fmtFull(pr.payDate)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Advanced — engine fields, tucked away to keep the layout compact */}
                  <div className="shrink-0" style={{ borderRadius: 9, border: '1px solid var(--border-hairline)', overflow: 'hidden' }}>
                    <button
                      onClick={() => setAdvOpen((o) => !o)}
                      className="focus-ring flex items-center gap-2 w-full text-left"
                      style={{ padding: '10px 12px', border: 0, background: 'var(--bg-surface-2)', cursor: 'pointer' }}
                    >
                      <span
                        className="inline-flex"
                        style={{ transform: advOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 130ms', color: 'var(--text-tertiary)' }}
                      >
                        <WIcon name="chevron-down" size={13} />
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Advanced</span>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Cutoff, timezone, payable trigger, policies</span>
                    </button>
                    {advOpen && (
                      <div style={{ padding: 14, borderTop: '1px solid var(--border-hairline)', display: 'flex', flexDirection: 'column', gap: 15 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                          <PPField label="Cutoff time" hint="When the period actually closes on its last day.">
                            <input
                              type="time"
                              value={draft.cutoffTime}
                              onChange={(e) => patch({ cutoffTime: e.target.value })}
                              className="num focus-ring"
                              style={{ ...INPUT, width: 130 }}
                            />
                          </PPField>
                          <PPField label="Timezone" hint="Overrides the org default for this plan.">
                            <PPSelect
                              value={draft.timezone}
                              onChange={(v) => patch({ timezone: v })}
                              options={TIMEZONES.map((t) => ({ value: t.id, label: t.label }))}
                            />
                          </PPField>
                        </div>

                        <PPField label="Payable trigger" hint="Which date buckets a payable into a period.">
                          <PPSelect
                            value={draft.payableTrigger}
                            onChange={(v) => patch({ payableTrigger: v as PayableTrigger })}
                            options={TRIGGERS.map((t) => ({ value: t.id, label: t.label }))}
                            width={200}
                          />
                        </PPField>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                          <PPField label="Currency">
                            <PPSelect
                              value={draft.currency}
                              onChange={(v) => patch({ currency: v as Currency })}
                              options={CURRENCIES.map((c) => ({ value: c, label: c }))}
                            />
                          </PPField>
                          <PPField label="Amendment policy" hint="How late changes to a closed period are handled.">
                            <PPSelect
                              value={draft.amendmentPolicy}
                              onChange={(v) => patch({ amendmentPolicy: v as AmendmentPolicy })}
                              options={AMEND.map((a) => ({ value: a.id, label: a.label }))}
                            />
                          </PPField>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 13, paddingTop: 2 }}>
                          <PPToggle
                            on={draft.autoCarryover}
                            onChange={(v) => patch({ autoCarryover: v })}
                            label="Auto-carry held items forward"
                            hint="Unpaid or held payables roll into the next period automatically."
                          />
                          <PPToggle
                            on={draft.includeStandaloneAdjustments}
                            onChange={(v) => patch({ includeStandaloneAdjustments: v })}
                            label="Include standalone adjustments"
                            hint="Bonuses, deductions, and reimbursements not tied to a load."
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ── footer ───────────────────────────────────────────────────── */}
          <div
            className="flex items-center justify-between gap-3"
            style={{ padding: '10px 18px', borderTop: '1px solid var(--border-hairline)', background: 'var(--bg-surface-2)' }}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {sel && !sel.isActive ? (
                <button
                  onClick={doRestore}
                  className="focus-ring inline-flex items-center gap-1.5 rounded-[7px]"
                  style={{ height: 28, padding: '0 10px', border: '1px solid var(--border-hairline)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}
                >
                  <WIcon name="restore" size={13} /> Restore plan
                </button>
              ) : sel && canArchive ? (
                <>
                  <button
                    onClick={confirmArch ? doArchive : () => setConfirmArch(true)}
                    className="focus-ring inline-flex items-center gap-1.5 rounded-[7px]"
                    style={{
                      height: 28, padding: '0 10px',
                      border: confirmArch ? '1px solid rgba(180,120,0,0.45)' : '1px solid transparent',
                      background: confirmArch ? 'rgba(180,120,0,0.10)' : 'transparent',
                      color: confirmArch ? '#A66800' : 'var(--text-secondary)',
                      fontSize: 12, fontWeight: 500, cursor: 'pointer',
                    }}
                  >
                    <WIcon name="archive" size={13} /> {confirmArch ? 'Archive this plan?' : 'Archive plan'}
                  </button>
                  {confirmArch && (
                    <button
                      onClick={() => setConfirmArch(false)}
                      style={{ border: 0, background: 'transparent', color: 'var(--text-tertiary)', fontSize: 11.5, cursor: 'pointer' }}
                    >
                      Cancel
                    </button>
                  )}
                </>
              ) : sel ? (
                <span
                  className="inline-flex items-center gap-1.5"
                  title={sel.isDefault ? 'Default plans can’t be archived.' : 'Reassign drivers before archiving.'}
                  style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}
                >
                  <WIcon name="archive" size={13} />
                  {sel.isDefault ? 'Default — can’t archive' : `In use by ${sel.driverCount} — reassign to archive`}
                </span>
              ) : null}
              {sel && sel.isActive && !sel.isDefault && (
                <button
                  onClick={makeDefault}
                  title="New drivers inherit the default plan"
                  className="focus-ring"
                  style={{ border: 0, background: 'transparent', color: 'var(--text-tertiary)', fontSize: 11.5, cursor: 'pointer', textDecoration: 'underline' }}
                >
                  Set as default
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <WBtn size="sm" onClick={onClose}>Cancel</WBtn>
              <WBtn size="sm" accent leading="check" onClick={save} disabled={!draft || saving}>
                {saving ? 'Saving…' : 'Save plan'}
              </WBtn>
            </div>
          </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Pieces
// ═══════════════════════════════════════════════════════════════════════════

const INPUT: React.CSSProperties = {
  height: 28,
  padding: '0 10px',
  borderRadius: 7,
  border: '1px solid var(--border-hairline)',
  background: 'var(--bg-surface)',
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: 'var(--text-primary)',
  outline: 'none',
};

function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const m = raw.match(/Uncaught Error:\s*(.+?)(?:\n|$)/);
  if (m) return m[1].trim();
  const first = raw.split('\n')[0]?.trim();
  return first && first.length < 160 ? first : 'Something went wrong. Please try again.';
}

const FREQ_LABEL: Record<Frequency, string> = {
  WEEKLY: 'Weekly', BIWEEKLY: 'Bi-weekly', SEMIMONTHLY: 'Semi-monthly', MONTHLY: 'Monthly',
};

function RailRow({ plan, active, archived, onSelect }: {
  plan: PlanRow;
  active: boolean;
  archived?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="focus-ring w-full text-left"
      style={{
        padding: '11px 14px', border: 0, borderBottom: '1px solid var(--border-hairline)',
        cursor: 'pointer', background: active ? 'var(--bg-surface)' : 'transparent',
        boxShadow: active ? `inset 2px 0 0 ${archived ? 'var(--text-tertiary)' : 'var(--accent)'}` : 'none',
        opacity: archived && !active ? 0.62 : 1,
      }}
    >
      <div className="flex items-center gap-1.5" style={{ marginBottom: 2 }}>
        {archived && <WIcon name="archive" size={11} color="var(--text-tertiary)" />}
        <span
          className="truncate"
          style={{ fontSize: 12.5, fontWeight: 600, color: archived ? 'var(--text-secondary)' : 'var(--text-primary)' }}
        >
          {plan.name}
        </span>
        {plan.isDefault && (
          <span
            className="uppercase shrink-0"
            style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--accent)', background: 'rgba(46,92,255,0.10)', padding: '1px 5px', borderRadius: 4 }}
          >
            Default
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: '15px' }}>
        {FREQ_LABEL[plan.frequency]} · {archived ? 'archived' : `${plan.driverCount} driver${plan.driverCount === 1 ? '' : 's'}`}
      </div>
    </button>
  );
}

/** Rail row-shaped shimmer — same footprint as RailRow so the list doesn't
 *  jump when real plans replace it. */
function RailRowSkeleton() {
  return (
    <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
      <div className="animate-pulse rounded" style={{ width: '62%', height: 12, background: 'var(--border-hairline)', marginBottom: 6 }} />
      <div className="animate-pulse rounded" style={{ width: '44%', height: 9, background: 'var(--border-hairline)', opacity: 0.7 }} />
    </div>
  );
}

/** Editor-shaped shimmer — mirrors the loaded layout (name, description,
 *  frequency, anchor, pay-lag, preview box) so the dialog height and pane
 *  contents don't snap when the draft loads. */
function EditorSkeleton() {
  const label = (w: number) => (
    <div className="animate-pulse rounded" style={{ width: w, height: 10, background: 'var(--border-hairline)' }} />
  );
  const field = (labelW: number, inputW: number | string, inputH = 28) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flexShrink: 0 }}>
      {label(labelW)}
      <div className="animate-pulse rounded-[7px]" style={{ width: inputW, height: inputH, background: 'var(--bg-surface-2)', border: '1px solid var(--border-hairline)' }} />
    </div>
  );
  return (
    <>
      {field(64, '100%')}
      {field(78, '100%')}
      {field(66, 320, 30)}
      {field(96, 296, 28)}
      {field(70, 220, 28)}
      <div className="animate-pulse rounded-[9px] shrink-0" style={{ height: 148, background: 'var(--bg-surface-2)', border: '1px solid var(--border-hairline)' }} />
      <div className="animate-pulse rounded-[9px] shrink-0" style={{ height: 38, background: 'var(--bg-surface-2)', border: '1px solid var(--border-hairline)' }} />
    </>
  );
}

/** Rail placeholder for the unsaved "new plan" draft. */
function RailRowNewDraft({ name }: { name: string }) {
  return (
    <div
      style={{
        padding: '11px 14px', borderBottom: '1px solid var(--border-hairline)',
        background: 'var(--bg-surface)', boxShadow: 'inset 2px 0 0 var(--accent)',
      }}
    >
      <div className="truncate" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
        {name || 'New plan'}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Unsaved</div>
    </div>
  );
}

function PPField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    // flexShrink 0: the editor pane is a flex column — without this, fields
    // COMPRESS to fit the pane instead of overflowing it, which collapses
    // hints/boxes and leaves nothing to scroll.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: '15px' }}>{hint}</div>}
    </div>
  );
}

function InfoBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center gap-2 shrink-0"
      style={{ padding: '9px 11px', borderRadius: 8, background: 'var(--bg-surface-2)', border: '1px solid var(--border-hairline)', fontSize: 12, color: 'var(--text-secondary)' }}
    >
      <WIcon name="info" size={13} color="var(--text-tertiary)" />
      <span>{children}</span>
    </div>
  );
}

function Segmented({ options, value, onChange, dense }: {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
  dense?: boolean;
}) {
  return (
    <div
      className="inline-flex self-start overflow-hidden"
      style={{ borderRadius: dense ? 7 : 8, border: '1px solid var(--border-hairline)', height: dense ? 28 : 30 }}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="focus-ring"
            style={{
              padding: dense ? '0 0' : '0 13px',
              width: dense ? 40 : undefined,
              border: 0,
              borderLeft: i === 0 ? 'none' : '1px solid var(--border-hairline)',
              background: on ? 'var(--accent)' : 'var(--bg-surface)',
              color: on ? '#fff' : 'var(--text-secondary)',
              fontSize: dense ? 11.5 : 12,
              fontWeight: on ? 600 : 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Stepper({ value, onChange, min = 0, max = 14 }: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const btn = (dir: number, disabled: boolean) => (
    <button
      className="focus-ring inline-flex items-center justify-center"
      disabled={disabled}
      onClick={() => onChange(Math.min(max, Math.max(min, value + dir)))}
      style={{ width: 28, height: 28, border: 0, background: 'transparent', cursor: disabled ? 'default' : 'pointer', color: 'var(--text-secondary)', opacity: disabled ? 0.4 : 1 }}
    >
      {dir < 0 ? '−' : '+'}
    </button>
  );
  return (
    <div
      className="inline-flex items-center overflow-hidden"
      style={{ height: 28, borderRadius: 7, border: '1px solid var(--border-hairline)', background: 'var(--bg-surface)' }}
    >
      {btn(-1, value <= min)}
      <span
        className="num inline-flex items-center justify-center h-full"
        style={{ minWidth: 30, fontSize: 12.5, fontWeight: 600, borderLeft: '1px solid var(--border-hairline)', borderRight: '1px solid var(--border-hairline)' }}
      >
        {value}
      </span>
      {btn(1, value >= max)}
    </div>
  );
}

function PPSelect({ value, onChange, options, width }: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  width?: number | string;
}) {
  return (
    <div className="relative inline-flex" style={{ width: width ?? '100%' }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="focus-ring appearance-none cursor-pointer"
        style={{ ...INPUT, width: '100%', padding: '0 26px 0 10px' }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <span className="absolute right-2 inset-y-0 flex items-center pointer-events-none" style={{ color: 'var(--text-tertiary)' }}>
        <WIcon name="chevron-down" size={12} />
      </span>
    </div>
  );
}

function PPToggle({ on, onChange, label, hint }: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="focus-ring flex items-start gap-2.5 w-full text-left"
      style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0 }}
    >
      <span
        className="inline-flex shrink-0"
        style={{
          marginTop: 1, width: 32, height: 18, borderRadius: 9, padding: 2, transition: 'background 130ms',
          background: on ? 'var(--accent)' : 'var(--border-hairline)',
          justifyContent: on ? 'flex-end' : 'flex-start',
        }}
      >
        <span style={{ width: 14, height: 14, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }} />
      </span>
      <span className="min-w-0">
        <span className="block" style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</span>
        {hint && <span className="block" style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: '15px', marginTop: 1 }}>{hint}</span>}
      </span>
    </button>
  );
}
