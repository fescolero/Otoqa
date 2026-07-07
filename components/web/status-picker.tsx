/**
 * StatusPicker — click-to-change status pattern.
 *
 *   <StatusPicker entity="driver" currentId="active" onChange={…} />
 *
 * The current status renders as a clickable Chip in the same visual slot
 * as a static Chip. Clicking it opens a popover of valid next states
 * (grouped Active / Paused / Terminal). Picking one opens a confirmation
 * modal with reason chips, an optional note, and an effective date.
 * Terminal transitions show a red warning callout; the modal commits via
 * `onChange(next, { reason, note, effectiveDate })`.
 *
 * Wires shortcuts:  esc cancels, ⌘↵ confirms.
 */

'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';
import { Chip, STATUS_PRESETS } from './chip';
import { WBtn } from './btn';
import { WIcon } from './icons';
import { Kbd } from './kbd';
import {
  CATEGORY_TONES,
  REASONS_BY_TARGET,
  STATE_MACHINES,
  type StatusCategory,
  type StatusEntity,
  type StatusState,
} from './status-machines';

export interface StatusChangePayload {
  to: StatusState;
  from: StatusState;
  reason: string;
  note?: string;
  effectiveDate: string; // ISO yyyy-mm-dd
}

interface StatusPickerProps {
  entity: StatusEntity;
  /** Current state machine ID (e.g. 'active'). Resolve from raw data via
   *  `resolveStatusId(entity, driver.employmentStatus)`. */
  currentId: string;
  onChange: (payload: StatusChangePayload) => void | Promise<void>;
  /** Hides the chevron and the click handler — used while the underlying
   *  mutation is in flight. */
  disabled?: boolean;
  /** Optional override for the chip label only (the picker menu still
   *  shows the canonical state machine labels). Use this to surface a
   *  derived label like `"Assigned · in transit"` while keeping the
   *  underlying state writable to one of the 5 DB enum values. */
  label?: React.ReactNode;
}

export function StatusPicker({ entity, currentId, onChange, disabled, label }: StatusPickerProps) {
  const [popoverOpen, setPopoverOpen] = React.useState(false);
  const [modalState, setModalState] = React.useState<{ from: StatusState; to: StatusState } | null>(null);
  const machine = STATE_MACHINES[entity];
  const cur = machine.states[currentId] ?? machine.states[machine.initial];

  const onPick = (next: StatusState) => {
    setPopoverOpen(false);
    setModalState({ from: cur, to: next });
  };

  const onConfirm = async (payload: StatusChangePayload) => {
    setModalState(null);
    await onChange(payload);
  };

  return (
    <>
      <PopoverPrimitive.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'focus-ring inline-flex items-center gap-1.5 rounded-full font-semibold whitespace-nowrap border border-transparent transition-colors',
              'cursor-pointer disabled:cursor-not-allowed',
            )}
            style={{
              background: STATUS_PRESETS[cur.kind].bg,
              color: STATUS_PRESETS[cur.kind].fg,
              padding: '2px 8px',
              fontSize: 11.5,
              lineHeight: '18px',
              letterSpacing: 0.01,
            }}
            title="Change status"
            onMouseEnter={(e) => {
              if (!disabled) e.currentTarget.style.borderColor = STATUS_PRESETS[cur.kind].fg + '40';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'transparent';
            }}
          >
            <span
              aria-hidden
              className="inline-block rounded-full"
              style={{
                width: 6,
                height: 6,
                background: STATUS_PRESETS[cur.kind].dot,
                boxShadow: `0 0 0 2px ${STATUS_PRESETS[cur.kind].bg}`,
              }}
            />
            {label ?? cur.label}
            {!disabled && <WIcon name="chevron-down" size={11} color={STATUS_PRESETS[cur.kind].fg} />}
          </button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            align="start"
            sideOffset={6}
            className="z-50 w-[320px] rounded-[10px] border border-[var(--border-hairline-strong)] bg-[var(--bg-surface)] shadow-[var(--shadow-popover)] overflow-hidden"
          >
            <StatusPopoverBody
              entity={entity}
              currentId={currentId}
              onPick={onPick}
              onClose={() => setPopoverOpen(false)}
            />
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      {modalState && (
        <StatusChangeModal
          entity={entity}
          fromState={modalState.from}
          toState={modalState.to}
          onCancel={() => setModalState(null)}
          onConfirm={onConfirm}
        />
      )}
    </>
  );
}

// ─── Popover body ────────────────────────────────────────────────────────

function StatusPopoverBody({
  entity,
  currentId,
  onPick,
  onClose,
}: {
  entity: StatusEntity;
  currentId: string;
  onPick: (s: StatusState) => void;
  onClose: () => void;
}) {
  const machine = STATE_MACHINES[entity];
  const all = Object.values(machine.states);
  const allowedIds = new Set(
    machine.transitions && machine.transitions[currentId]
      ? machine.transitions[currentId]
      : all.filter((s) => s.id !== currentId).map((s) => s.id),
  );
  const grouped: { cat: StatusCategory; items: StatusState[] }[] = (
    ['Active', 'Paused', 'Terminal'] as StatusCategory[]
  )
    .map((cat) => ({ cat, items: all.filter((s) => s.category === cat) }))
    .filter((g) => g.items.length > 0);

  const currentLabel = machine.states[currentId]?.label ?? '—';
  const entityLabel = entity[0].toUpperCase() + entity.slice(1);

  return (
    <>
      <header className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border-hairline)]">
        <div>
          <div className="text-[12px] font-semibold text-foreground">Change status</div>
          <div className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
            {entityLabel} · current: {currentLabel}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="focus-ring inline-flex items-center justify-center w-[22px] h-[22px] rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)]"
          aria-label="Close"
        >
          <WIcon name="close" size={11} />
        </button>
      </header>
      <div className="max-h-[380px] overflow-auto px-1.5 pb-2 pt-2 scroll-thin">
        {grouped.map((g) => (
          <div key={g.cat} className="mb-1.5">
            <div
              className="px-2 pt-1 pb-1.5 text-[10px] font-bold uppercase tracking-[0.1em]"
              style={{ color: CATEGORY_TONES[g.cat].fg }}
            >
              {g.cat}
            </div>
            {g.items.map((s) => {
              const allowed = allowedIds.has(s.id);
              const isCurrent = s.id === currentId;
              const dim = !allowed && !isCurrent;
              const preset = STATUS_PRESETS[s.kind];
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={!allowed || isCurrent}
                  onClick={() => onPick(s)}
                  className={cn(
                    'focus-ring w-full px-2.5 py-2 rounded-md flex items-center gap-2.5 text-left',
                    allowed && !isCurrent && 'hover:bg-[var(--bg-row-hover)] cursor-pointer',
                    (!allowed || isCurrent) && 'cursor-not-allowed',
                    dim && 'opacity-35',
                  )}
                >
                  <span
                    aria-hidden
                    className="inline-block rounded-full shrink-0"
                    style={{ width: 8, height: 8, background: preset.dot }}
                  />
                  <span className="flex-1 min-w-0 text-[12.5px] text-foreground font-medium">
                    {s.label}
                    {isCurrent && (
                      <span className="ml-1.5 text-[10.5px] font-normal text-[var(--text-tertiary)]">(current)</span>
                    )}
                  </span>
                  {s.terminal && (
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.04em]"
                      style={{ background: 'rgba(239,68,68,0.10)', color: '#B43030' }}
                    >
                      Terminal
                    </span>
                  )}
                  {dim && (
                    <span className="shrink-0 text-[10.5px] text-[var(--text-tertiary)]">Not allowed</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Confirmation modal ──────────────────────────────────────────────────

function StatusChangeModal({
  entity,
  fromState,
  toState,
  onCancel,
  onConfirm,
}: {
  entity: StatusEntity;
  fromState: StatusState;
  toState: StatusState;
  onCancel: () => void;
  onConfirm: (payload: StatusChangePayload) => void | Promise<void>;
}) {
  const today = React.useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [date, setDate] = React.useState(today);
  const [reason, setReason] = React.useState('');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const reasonOptions = REASONS_BY_TARGET[toState.id] ?? ['Other'];
  const tone = CATEGORY_TONES[toState.category];
  const valid = reason.length > 0 && !busy;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await onConfirm({ from: fromState, to: toState, reason, note: note || undefined, effectiveDate: date });
    } finally {
      setBusy(false);
    }
  };

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && valid) {
        e.preventDefault();
        void submit();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const terminalCopy =
    entity === 'truck' || entity === 'trailer'
      ? 'will be removed from active fleet pools'
      : entity === 'driver'
        ? 'will be removed from dispatch eligibility'
        : 'will no longer appear in active lists';

  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={onCancel}
      className="fixed inset-0 z-[90] flex items-center justify-center p-6"
      style={{ background: 'rgba(15,22,36,0.32)' }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[500px] max-w-full rounded-xl border border-[var(--border-hairline-strong)] bg-[var(--bg-surface)] shadow-[var(--shadow-popover)] overflow-hidden"
      >
        <header
          className="flex items-center justify-between px-4 py-3.5 border-b border-[var(--border-hairline)]"
          style={{ background: tone.bg }}
        >
          <div>
            <div
              className="mb-1 text-[10px] font-bold uppercase tracking-[0.1em]"
              style={{ color: tone.fg }}
            >
              Confirm status change
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[16px] font-semibold text-foreground">
              <Chip status={fromState.kind} label={fromState.label} />
              <WIcon name="arrow-up-right" size={14} color="var(--text-secondary)" />
              <Chip status={toState.kind} label={toState.label} />
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="focus-ring inline-flex items-center justify-center w-[26px] h-[26px] rounded-md"
            style={{ background: 'rgba(255,255,255,0.5)', color: tone.fg }}
            aria-label="Close"
          >
            <WIcon name="close" size={12} />
          </button>
        </header>

        <div className="flex flex-col gap-4 p-[18px]">
          {toState.terminal && (
            <div
              className="rounded-lg border px-3 py-2.5 text-[12.5px] leading-[17px]"
              style={{
                borderColor: 'rgba(239,68,68,0.30)',
                background: 'rgba(239,68,68,0.06)',
                color: '#B43030',
              }}
            >
              <strong>Terminal status.</strong> This is hard to reverse. The {entity} {terminalCopy} effective on the date below.
            </div>
          )}

          <div>
            <SLabel>Effective date</SLabel>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full h-8 px-2.5 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[13px] text-foreground outline-0"
            />
          </div>

          <div>
            <SLabel required>Reason</SLabel>
            <div className="flex flex-wrap gap-1.5">
              {reasonOptions.map((r) => {
                const on = reason === r;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setReason(r)}
                    className="focus-ring rounded-full border px-2.5 py-1 text-[11.5px] font-medium"
                    style={{
                      borderColor: on ? tone.fg : 'var(--border-hairline)',
                      background: on ? tone.bg : 'var(--bg-surface)',
                      color: on ? tone.fg : 'var(--text-secondary)',
                    }}
                  >
                    {r}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <SLabel>Note (optional)</SLabel>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                toState.terminal
                  ? 'Required documentation, exit-interview link, etc.'
                  : 'Anything dispatch / accounting needs to know…'
              }
              className="w-full min-h-[64px] rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[13px] text-foreground outline-0 resize-y"
            />
          </div>

          <div className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface-2)] px-2.5 py-2 text-[11.5px] leading-[16px] text-[var(--text-tertiary)]">
            This will be logged in <strong className="text-[var(--text-secondary)]">Status history</strong>{' '}
            and the Activity feed.
          </div>
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-[var(--border-hairline)] px-4 py-2.5">
          <span className="text-[11px] text-[var(--text-tertiary)]">
            <Kbd>⌘↵</Kbd> confirm · <Kbd>esc</Kbd> cancel
          </span>
          <span className="flex gap-1.5">
            <WBtn size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </WBtn>
            <WBtn
              size="sm"
              variant={toState.terminal ? 'secondary' : 'primary'}
              danger={toState.terminal}
              onClick={submit}
              disabled={!valid}
              style={!valid ? { opacity: 0.4 } : undefined}
            >
              {toState.terminal ? `Set ${toState.label}` : `Change to ${toState.label}`}
            </WBtn>
          </span>
        </footer>
      </div>
    </div>
  );
}

function SLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text-tertiary)]">
      {children}
      {required && <span className="ml-1" style={{ color: '#B43030' }}>*</span>}
    </div>
  );
}
