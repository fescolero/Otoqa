/**
 * ManageAssignmentsModal — assign/unassign/set-default pay profiles for one
 * payee (driver or carrier).
 *
 * New design (mirrors details-driver.jsx → ManagePayProfilesSheet):
 *   - "Default profile" section: single ProfileSelect dropdown
 *   - "Conditional overrides" section: list of rows, each with:
 *       · Strategy picker (DISTANCE_THRESHOLD / JURISDICTION / MANUAL_ONLY)
 *       · Inline parameter inputs that swap based on strategy
 *       · Profile picker
 *       · Remove (×)
 *   - "Add condition" button to append a fresh override
 *   - Footer: ⌘↵ save · esc cancel, Cancel | Save buttons
 *
 * Edits are STAGED in local draft state; Save applies the diff against the
 * current assignments via assign/unassign/setDefault/updateStrategy. This
 * differs from the load-detail "immediate-commit" modal because driver
 * assignment is a coherent multi-step intent, not piecemeal line edits.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useOrganizationId } from '@/contexts/organization-context';
import { WBtn, WIcon, Kbd } from '@/components/web';
import { cn } from '@/lib/utils';
import { ModelTag } from '@/components/web/pay-profiles/model-tag';
import { composeProfileSummary, type PayBasis } from '@/lib/payProfileDisplay';

export interface ManageAssignmentsModalProps {
  payeeType: 'DRIVER' | 'CARRIER';
  payeeId: string;
  onClose: () => void;
}

// ============================================================================
// Types
// ============================================================================

type SelectionStrategy =
  | 'ALWAYS_ACTIVE'
  | 'DISTANCE_THRESHOLD'
  | 'JURISDICTION'
  | 'MANUAL_ONLY';

const STRATEGY_OPTIONS: { value: Exclude<SelectionStrategy, 'ALWAYS_ACTIVE'>; label: string; help: string }[] = [
  { value: 'DISTANCE_THRESHOLD', label: 'Distance threshold', help: 'Above N miles' },
  { value: 'JURISDICTION',       label: 'Jurisdiction',       help: 'State / contract match' },
  { value: 'MANUAL_ONLY',        label: 'Manual select',      help: 'Dispatcher picks per load' },
];

// US states for the JURISDICTION strategy's state picker. Inline rather than
// shared so we don't take a dependency on customer-filter-bar's copy — but
// the list intentionally matches it so future consolidation is a no-op.
const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

type ProfileOption = {
  _id: string;
  name: string;
  payBasis: string;
  contractTag?: string;
  rules: Array<{
    name: string;
    trigger: { source: string; transform?: string };
    rateAmountMicroCents?: bigint;
  }>;
};

type CurrentAssignment = {
  _id: string;
  profileId: string;
  profileName: string;
  profilePayBasis: string;
  isDefault?: boolean;
  selectionStrategy: SelectionStrategy;
  matchState?: string;
  matchContractTag?: string;
  thresholdValue?: number;
};

// Draft row type. `_id` is the existing assignmentId, or starts with "new:"
// for unsaved additions. `isDefault: true` rows always have strategy
// ALWAYS_ACTIVE — there can only be one such row.
type DraftRow = {
  rowId: string;                       // existing assignmentId OR `new:<rand>`
  profileId: string | null;            // can be null while picker is empty
  isDefault: boolean;
  selectionStrategy: SelectionStrategy;
  matchState?: string;
  matchContractTag?: string;
  thresholdValue?: number;
};

// ============================================================================
// Component
// ============================================================================

export function ManageAssignmentsModal({
  payeeType,
  payeeId,
  onClose,
}: ManageAssignmentsModalProps) {
  const workosOrgId = useOrganizationId();

  const currentAssignments = useQuery(api.payeeProfileAssignments.listForPayee, {
    payeeType,
    payeeId,
  }) as CurrentAssignment[] | undefined;

  const allProfiles = useQuery(
    api.payProfiles.listForOrg,
    workosOrgId ? { workosOrgId, payeeType } : 'skip',
  ) as ProfileOption[] | undefined;

  const assign = useMutation(api.payeeProfileAssignments.assign);
  const setDefault = useMutation(api.payeeProfileAssignments.setDefault);
  const unassign = useMutation(api.payeeProfileAssignments.unassign);
  const updateStrategy = useMutation(api.payeeProfileAssignments.updateStrategy);

  const [draft, setDraft] = React.useState<DraftRow[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const initialized = React.useRef(false);

  // Initialize the draft from the current assignments once they arrive
  React.useEffect(() => {
    if (!currentAssignments || initialized.current) return;
    initialized.current = true;
    setDraft(
      currentAssignments.map(a => ({
        rowId: a._id,
        profileId: a.profileId,
        isDefault: !!a.isDefault,
        selectionStrategy: a.selectionStrategy,
        matchState: a.matchState,
        matchContractTag: a.matchContractTag,
        thresholdValue: a.thresholdValue,
      })),
    );
  }, [currentAssignments]);

  const activeProfiles = React.useMemo(
    () => (allProfiles ?? []).filter(p => (p as ProfileOption & { isActive?: boolean }).isActive !== false),
    [allProfiles],
  );

  // Distinct contract tags across the org's profiles. JURISDICTION-strategy
  // overrides pick from these so dispatchers can't typo a tag that doesn't
  // exist on any profile.
  const availableContractTags = React.useMemo(() => {
    const set = new Set<string>();
    for (const p of allProfiles ?? []) {
      const tag = (p as ProfileOption).contractTag;
      if (tag) set.add(tag);
    }
    return Array.from(set).sort();
  }, [allProfiles]);

  const defaultRow = draft.find(r => r.isDefault) ?? null;
  const overrides = draft.filter(r => !r.isDefault);

  // Map of profileId → the rowId that has claimed it in the current draft.
  // Each ProfileSelect uses this to disable profiles that are already taken
  // by some OTHER row (the picker can still show its own current selection).
  // Prevents the "Payee is already assigned to this profile" backend error.
  const claimedBy = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of draft) {
      if (r.profileId) m.set(r.profileId, r.rowId);
    }
    return m;
  }, [draft]);

  const disabledProfileIdsFor = (selfRowId: string | null): Set<string> => {
    const out = new Set<string>();
    for (const [pid, rowId] of claimedBy) {
      if (rowId !== selfRowId) out.add(pid);
    }
    return out;
  };

  // ── Draft mutations ────────────────────────────────────────────────────
  const setDefaultProfile = (profileId: string) => {
    setDraft(d => {
      const overridesOnly = d.filter(r => !r.isDefault);
      const existing = d.find(r => r.isDefault);
      const next: DraftRow = existing
        ? { ...existing, profileId }
        : {
            rowId: `new:${Math.random().toString(36).slice(2, 8)}`,
            profileId,
            isDefault: true,
            selectionStrategy: 'ALWAYS_ACTIVE',
          };
      return [next, ...overridesOnly];
    });
  };

  const updateOverride = (rowId: string, patch: Partial<DraftRow>) => {
    setDraft(d => d.map(r => (r.rowId === rowId ? { ...r, ...patch } : r)));
  };

  const removeOverride = (rowId: string) => {
    setDraft(d => d.filter(r => r.rowId !== rowId));
  };

  const addOverride = () => {
    // Pick the first profile that ISN'T already claimed by another row —
    // otherwise the backend will throw "already assigned to this profile"
    // on save. If every profile is taken, leave profileId null and the
    // dispatcher will get a clear "no profiles available" select.
    const usedIds = new Set(draft.map(r => r.profileId).filter(Boolean) as string[]);
    const firstAvailable = activeProfiles.find(p => !usedIds.has(p._id))?._id ?? null;
    setDraft(d => [
      ...d,
      {
        rowId: `new:${Math.random().toString(36).slice(2, 8)}`,
        profileId: firstAvailable,
        isDefault: false,
        selectionStrategy: 'DISTANCE_THRESHOLD',
        thresholdValue: 500,
      },
    ]);
  };

  // ── Save: diff draft against current and fire mutations ────────────────
  const handleSave = async () => {
    if (!currentAssignments) return;
    setBusy(true);
    setError(null);
    try {
      // 1. Removals — current rows not in draft
      const draftIds = new Set(draft.map(r => r.rowId));
      for (const c of currentAssignments) {
        if (!draftIds.has(c._id)) {
          await unassign({ assignmentId: c._id as Id<'payeeProfileAssignments'> });
        }
      }

      // 2. For each draft row: insert / update / promote
      for (const d of draft) {
        if (!d.profileId) continue; // skip placeholders

        const cur = currentAssignments.find(c => c._id === d.rowId);

        if (!cur) {
          // New row → assign
          await assign({
            payeeType,
            payeeId,
            profileId: d.profileId as Id<'payProfiles'>,
            isDefault: d.isDefault,
            selectionStrategy: d.selectionStrategy,
            matchState: d.matchState,
            matchContractTag: d.matchContractTag,
            thresholdValue: d.thresholdValue,
          });
          continue;
        }

        // Profile changed → unassign + reassign (we don't have a swap mutation)
        if (cur.profileId !== d.profileId) {
          await unassign({ assignmentId: cur._id as Id<'payeeProfileAssignments'> });
          await assign({
            payeeType,
            payeeId,
            profileId: d.profileId as Id<'payProfiles'>,
            isDefault: d.isDefault,
            selectionStrategy: d.selectionStrategy,
            matchState: d.matchState,
            matchContractTag: d.matchContractTag,
            thresholdValue: d.thresholdValue,
          });
          continue;
        }

        // Same profile — sync strategy params
        const stratChanged =
          cur.selectionStrategy !== d.selectionStrategy ||
          cur.matchState !== d.matchState ||
          cur.matchContractTag !== d.matchContractTag ||
          cur.thresholdValue !== d.thresholdValue;
        if (stratChanged) {
          await updateStrategy({
            assignmentId: cur._id as Id<'payeeProfileAssignments'>,
            patch: {
              selectionStrategy: d.selectionStrategy,
              matchState: d.matchState,
              matchContractTag: d.matchContractTag,
              thresholdValue: d.thresholdValue,
            },
          });
        }
        // Default toggle
        if (!cur.isDefault && d.isDefault) {
          await setDefault({
            assignmentId: cur._id as Id<'payeeProfileAssignments'>,
          });
        }
      }
      onClose();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  // Convex error messages can be wordy (full server stack + "Server Error"
  // prefix). Map the common ones to short user-readable strings; fall back
  // to the raw message otherwise so we never swallow a real failure.
  function friendlyError(e: unknown): string {
    if (!(e instanceof Error)) return 'Failed to save changes';
    const msg = e.message;
    if (msg.includes('already assigned to this profile')) {
      return "This profile is already on the driver's rotation. Pick a different one or remove the duplicate.";
    }
    if (msg.includes('Profile is for')) {
      // Profile/payeeType mismatch — should be impossible via the picker,
      // but surface it cleanly just in case.
      return 'That profile is for a different payee type and cannot be assigned here.';
    }
    if (msg.includes('Pay profile not found')) {
      return 'That pay profile was deleted before you saved. Pick another and try again.';
    }
    if (msg.includes('Not authorized')) {
      return 'You don’t have permission to change pay assignments.';
    }
    return msg.replace(/^.*Uncaught Error:\s*/, '').trim() || 'Failed to save changes';
  }

  // ── Esc to cancel, ⌘↵ to save ──────────────────────────────────────────
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSave();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, currentAssignments]);

  // ──────────────────────────────────────────────────────────────────────
  return (
    <div
      onMouseDown={onClose}
      className="fixed inset-0 z-[90] flex items-center justify-center p-6"
      style={{ background: 'rgba(15,22,36,0.32)' }}
    >
      <div
        onMouseDown={e => e.stopPropagation()}
        className="flex flex-col overflow-hidden"
        style={{
          width: 620,
          maxWidth: '100%',
          maxHeight: '90vh',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline-strong)',
          borderRadius: 10,
          boxShadow: 'var(--shadow-popover)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between gap-3"
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-hairline)',
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Manage pay profiles</div>
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--text-tertiary)',
                marginTop: 2,
              }}
            >
              Pick a default profile and add conditional overrides. Profile values
              live in{' '}
              <Link
                href="/org-settings/pay-profiles"
                target="_blank"
                style={{ color: 'var(--accent)', textDecoration: 'underline' }}
              >
                Settings → Pay profiles
              </Link>
              .
            </div>
          </div>
          <button
            onClick={onClose}
            className="focus-ring inline-flex items-center justify-center"
            style={{
              width: 24,
              height: 24,
              border: 0,
              borderRadius: 5,
              background: 'transparent',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
            }}
            aria-label="Close"
          >
            <WIcon name="close" size={12} />
          </button>
        </div>

        {/* Body */}
        <div
          className="scroll-thin flex flex-col gap-4"
          style={{ padding: 16, overflow: 'auto' }}
        >
          {currentAssignments === undefined || allProfiles === undefined ? (
            <p
              className="text-[12.5px]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Loading…
            </p>
          ) : activeProfiles.length === 0 ? (
            <p
              className="text-[12.5px]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              No pay profiles defined for {payeeType.toLowerCase()}s yet. Create
              one in Settings → Pay profiles first.
            </p>
          ) : (
            <>
              {/* Default */}
              <div>
                <SheetLabel>Default profile</SheetLabel>
                <p
                  style={{
                    fontSize: 11.5,
                    color: 'var(--text-tertiary)',
                    margin: '2px 0 8px',
                  }}
                >
                  Applies whenever no condition matches.
                </p>
                <ProfileSelect
                  value={defaultRow?.profileId ?? null}
                  profiles={activeProfiles}
                  disabledProfileIds={disabledProfileIdsFor(defaultRow?.rowId ?? null)}
                  onChange={setDefaultProfile}
                />
              </div>

              {/* Overrides */}
              <div>
                <SheetLabel>Conditional overrides</SheetLabel>
                <p
                  style={{
                    fontSize: 11.5,
                    color: 'var(--text-tertiary)',
                    margin: '2px 0 8px',
                  }}
                >
                  Used instead of the default when the condition matches. First
                  match wins.
                </p>
                <div className="flex flex-col gap-2">
                  {overrides.map(row => (
                    <OverrideRow
                      key={row.rowId}
                      row={row}
                      profiles={activeProfiles}
                      availableContractTags={availableContractTags}
                      disabledProfileIds={disabledProfileIdsFor(row.rowId)}
                      onChange={patch => updateOverride(row.rowId, patch)}
                      onRemove={() => removeOverride(row.rowId)}
                    />
                  ))}
                  <button
                    onClick={addOverride}
                    className="focus-ring self-start inline-flex items-center gap-1.5"
                    style={{
                      padding: '6px 10px',
                      border: '1px dashed var(--border-hairline-strong)',
                      borderRadius: 6,
                      background: 'transparent',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <WIcon name="plus" size={11} /> Add condition
                  </button>
                </div>
              </div>
            </>
          )}

          {error && (
            <div
              className="px-3 py-2 rounded text-[12px]"
              style={{
                background: 'rgba(180,48,48,0.08)',
                color: '#B43030',
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between gap-2"
          style={{
            padding: '10px 16px',
            borderTop: '1px solid var(--border-hairline)',
          }}
        >
          <span
            style={{ fontSize: 11, color: 'var(--text-tertiary)' }}
          >
            <Kbd>⌘↵</Kbd> save · <Kbd>Esc</Kbd> cancel
          </span>
          <span className="flex gap-1.5">
            <WBtn size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </WBtn>
            <WBtn size="sm" accent onClick={handleSave} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </WBtn>
          </span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

function SheetLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.04,
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
      }}
    >
      {children}
    </div>
  );
}

/**
 * OverrideRow — single conditional override editor row.
 *
 * Layout:
 *   [Strategy picker + inline params] · [Profile picker] · [× remove]
 *
 * The strategy picker reveals different param inputs:
 *   - DISTANCE_THRESHOLD → mileage input
 *   - JURISDICTION → state (2-char) + contract tag inputs
 *   - MANUAL_ONLY → no params
 */
function OverrideRow({
  row,
  profiles,
  availableContractTags,
  disabledProfileIds,
  onChange,
  onRemove,
}: {
  row: DraftRow;
  profiles: ProfileOption[];
  availableContractTags: string[];
  disabledProfileIds: Set<string>;
  onChange: (patch: Partial<DraftRow>) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 8,
        background: 'var(--bg-surface-2)',
        padding: 10,
      }}
    >
      {/* items-start anchors every column to the top so the dropdowns and
          × button stay put when the strategy column grows downward to fit
          its helper text or param inputs. The OverrideRow itself grows
          vertically as the strategy editor changes height. */}
      <div className="grid items-start gap-2" style={{ gridTemplateColumns: '1fr 1fr 24px' }}>
        {/* Condition / strategy */}
        <StrategyEditor
          row={row}
          availableContractTags={availableContractTags}
          onChange={onChange}
        />

        {/* Profile picker */}
        <ProfileSelect
          value={row.profileId}
          profiles={profiles}
          disabledProfileIds={disabledProfileIds}
          onChange={pid => onChange({ profileId: pid })}
          compact
        />

        {/* Remove */}
        <button
          onClick={onRemove}
          className="focus-ring inline-flex items-center justify-center"
          style={{
            width: 24,
            // Match the height of the strategy + profile dropdowns so the ×
            // doesn't shrink to a tiny floating square when the row grows.
            height: 28,
            border: '1px solid var(--border-hairline)',
            borderRadius: 5,
            background: 'var(--bg-surface)',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
          }}
          aria-label="Remove condition"
        >
          <WIcon name="close" size={10} />
        </button>
      </div>
    </div>
  );
}

function StrategyEditor({
  row,
  availableContractTags,
  onChange,
}: {
  row: DraftRow;
  availableContractTags: string[];
  onChange: (patch: Partial<DraftRow>) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <select
        value={row.selectionStrategy}
        onChange={e =>
          onChange({ selectionStrategy: e.target.value as SelectionStrategy })
        }
        style={{
          height: 28,
          padding: '0 8px',
          border: '1px solid var(--border-hairline)',
          borderRadius: 5,
          background: 'var(--bg-surface)',
          color: 'var(--text-primary)',
          fontFamily: 'inherit',
          fontSize: 12.5,
          outline: 0,
          cursor: 'pointer',
        }}
      >
        {STRATEGY_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {row.selectionStrategy === 'DISTANCE_THRESHOLD' && (
        <div className="flex items-center gap-1.5">
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            Above
          </span>
          <input
            type="number"
            min={0}
            value={row.thresholdValue ?? ''}
            onChange={e =>
              onChange({
                thresholdValue: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            style={inlineInputStyle}
          />
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            miles
          </span>
        </div>
      )}

      {row.selectionStrategy === 'JURISDICTION' && (
        <div className="flex items-center gap-1.5">
          {/* State — native <select> with US_STATES (+ "Any" sentinel). */}
          <select
            value={row.matchState ?? ''}
            onChange={e =>
              onChange({ matchState: e.target.value || undefined })
            }
            style={{ ...inlineInputStyle, width: 72, cursor: 'pointer' }}
            aria-label="State"
          >
            <option value="">Any state</option>
            {US_STATES.map(s => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {/* Contract tag — native <select> with distinct tags from the
              org's profiles. Falls back to "Any contract" when nothing is
              defined; tags only appear once one is set on a profile. */}
          <select
            value={row.matchContractTag ?? ''}
            onChange={e =>
              onChange({ matchContractTag: e.target.value || undefined })
            }
            disabled={availableContractTags.length === 0}
            style={{
              ...inlineInputStyle,
              flex: 1,
              cursor: availableContractTags.length === 0 ? 'not-allowed' : 'pointer',
              opacity: availableContractTags.length === 0 ? 0.6 : 1,
            }}
            aria-label="Contract tag"
          >
            <option value="">
              {availableContractTags.length === 0 ? 'No contract tags yet' : 'Any contract'}
            </option>
            {availableContractTags.map(t => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      )}

      {row.selectionStrategy === 'MANUAL_ONLY' && (
        <p
          style={{
            fontSize: 11,
            color: 'var(--text-tertiary)',
            margin: 0,
            lineHeight: 1.4,
            // Let the helper text wrap and grow this lane vertically when
            // the row is narrow — items-start on the parent grid keeps the
            // dropdown above anchored where it is.
          }}
        >
          Selected per load by dispatcher
        </p>
      )}
    </div>
  );
}

const inlineInputStyle: React.CSSProperties = {
  height: 26,
  padding: '0 8px',
  border: '1px solid var(--border-hairline)',
  borderRadius: 5,
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
  fontSize: 12,
  outline: 0,
  width: 80,
};

/**
 * ProfileSelect — click-to-open popover listing profiles.
 *
 * The trigger shows the selected profile's name + payBasis + one-line
 * rate summary. The popover renders a flat list of profiles with summary
 * lines + a check icon on the current selection.
 */
function ProfileSelect({
  value,
  profiles,
  disabledProfileIds,
  onChange,
  compact,
}: {
  value: string | null;
  profiles: ProfileOption[];
  /** Profiles disabled in this picker because another row in the draft is
   *  already using them. The picker's own current `value` is never disabled
   *  (it's the row's own selection, so it stays clickable). */
  disabledProfileIds?: Set<string>;
  onChange: (profileId: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  // Popover is portaled to document.body to escape the modal's scrollable
  // body — we don't want users scrolling inside a scroll. Position is
  // computed from the trigger's bounding rect on open + on any ancestor
  // scroll/resize. If there isn't enough room below, the popover flips up.
  const [coords, setCoords] = React.useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    placement: 'below' | 'above';
  } | null>(null);

  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);

  // Recompute placement: prefer below the trigger, flip above when the
  // viewport doesn't have enough room. Cap maxHeight to the available space.
  const recompute = React.useCallback(() => {
    const trig = triggerRef.current;
    if (!trig) return;
    const rect = trig.getBoundingClientRect();
    const vh = window.innerHeight;
    const gap = 4;
    const ideal = 320; // preferred max height
    const spaceBelow = vh - rect.bottom - gap - 8;
    const spaceAbove = rect.top - gap - 8;
    const useAbove = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      120,
      Math.min(ideal, useAbove ? spaceAbove : spaceBelow),
    );
    setCoords({
      top: useAbove ? rect.top - gap - maxHeight : rect.bottom + gap,
      left: rect.left,
      width: rect.width,
      maxHeight,
      placement: useAbove ? 'above' : 'below',
    });
  }, []);

  React.useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    recompute();

    const onScroll = () => setOpen(false); // close on any scroll — simpler
                                            // than tracking position live
    const onResize = () => recompute();
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };

    // Capture so we catch scrolls on any ancestor (modal body, page, etc.)
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('mousedown', onDoc);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [open, recompute]);

  const selected = profiles.find(p => p._id === value) ?? null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className="focus-ring w-full text-left"
        style={{
          padding: compact ? '6px 10px' : '10px 12px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 6,
          cursor: 'pointer',
          fontFamily: 'inherit',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          color: 'var(--text-primary)',
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: compact ? 'row' : 'column',
            alignItems: compact ? 'center' : 'flex-start',
            gap: compact ? 8 : 2,
            // Compact rows live inside a tight grid cell — force the contents
            // onto a single line and let the summary tail truncate.
            flexWrap: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <span
            className="truncate"
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: selected ? 'var(--text-primary)' : 'var(--text-tertiary)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              minWidth: 0,
              maxWidth: compact ? '60%' : 'none',
            }}
          >
            {selected ? selected.name : 'Pick a profile…'}
          </span>
          {selected && (
            <span
              style={{
                fontSize: 11,
                color: 'var(--text-tertiary)',
                minWidth: 0,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                overflow: 'hidden',
              }}
            >
              <ModelTag payBasis={selected.payBasis as PayBasis} />
              <span className="truncate" style={{ minWidth: 0 }}>
                {composeProfileSummary(selected.rules)}
              </span>
            </span>
          )}
        </span>
        <WIcon name="chevron-down" size={11} />
      </button>
      {open && coords && typeof window !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            className="scroll-thin"
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              width: coords.width,
              maxHeight: coords.maxHeight,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline-strong)',
              borderRadius: 8,
              boxShadow: 'var(--shadow-popover)',
              padding: 4,
              // Modal is z-90; sit above it.
              zIndex: 200,
              overflow: 'auto',
            }}
          >
            {profiles.map(p => {
              const sel = p._id === value;
              // Disable profiles claimed by another row in the draft. The
              // row's OWN current selection is never in the disabled set
              // (the parent computes it that way), so the picker can always
              // show + re-confirm its own choice.
              const disabled = !sel && (disabledProfileIds?.has(p._id) ?? false);
              return (
                <button
                  key={p._id}
                  type="button"
                  onClick={() => {
                    if (disabled) return;
                    onChange(p._id);
                    setOpen(false);
                  }}
                  disabled={disabled}
                  aria-disabled={disabled}
                  title={disabled ? 'Already used by another override' : undefined}
                  className={cn('focus-ring w-full text-left')}
                  style={{
                    padding: '8px 10px',
                    background: sel ? 'var(--bg-row-hover)' : 'transparent',
                    border: 0,
                    borderRadius: 5,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                    color: 'var(--text-primary)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    opacity: disabled ? 0.45 : 1,
                  }}
                  onMouseEnter={e => {
                    if (!sel && !disabled) e.currentTarget.style.background = 'var(--bg-row-hover)';
                  }}
                  onMouseLeave={e => {
                    if (!sel && !disabled) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      className="flex items-baseline gap-1.5"
                      style={{ marginBottom: 2 }}
                    >
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{p.name}</span>
                      <ModelTag payBasis={p.payBasis as PayBasis} />
                      {disabled && (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: 0.04,
                            textTransform: 'uppercase',
                            color: 'var(--text-tertiary)',
                            background: 'var(--bg-surface-2)',
                            border: '1px solid var(--border-hairline)',
                            padding: '1px 6px',
                            borderRadius: 3,
                          }}
                        >
                          In use
                        </span>
                      )}
                    </span>
                    <span
                      className="truncate"
                      style={{
                        display: 'block',
                        fontSize: 11,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {composeProfileSummary(p.rules)}
                    </span>
                  </span>
                  {sel && (
                    <span style={{ color: 'var(--accent)', marginTop: 4 }}>
                      <WIcon name="check" size={12} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
