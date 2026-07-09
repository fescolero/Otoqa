/**
 * EditableSSN — sensitive-data inline edit primitive.
 *
 * Read mode  → masked `***-**-XXXX` by default; eye toggle reveals the
 *              full value while held in local state only.
 * Edit mode  → input renders as `type="password"` by default so the value
 *              isn't shoulder-surfable; the same eye toggle flips the
 *              input to `type="text"` for confirmation.
 *
 * The eye icon sits alongside the pencil edit affordance and shares the
 * group-hover visibility behavior — keeps the row clean at rest.
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { WIcon } from './icons';

interface EditableSSNProps {
  value?: string;
  onCommit?: (next: string) => void | Promise<void>;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  ariaLabel?: string;
}

const maskedFor = (raw?: string) => {
  if (!raw) return '';
  const last4 = raw.replace(/\D/g, '').slice(-4);
  return last4 ? `***-**-${last4}` : '***-**-****';
};

export function EditableSSN({
  value,
  onCommit,
  placeholder = 'Add SSN',
  readOnly,
  className,
  ariaLabel,
}: EditableSSNProps) {
  const [editing, setEditing] = React.useState(false);
  const [revealed, setRevealed] = React.useState(false);
  const [draft, setDraft] = React.useState(value ?? '');
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => setDraft(value ?? ''), [value]);
  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);
  // Reset reveal when leaving edit mode so the field returns to masked.
  React.useEffect(() => {
    if (!editing) setRevealed(false);
  }, [editing]);

  if (readOnly || !onCommit) {
    return (
      <span className={cn('inline-flex items-center text-[13px] text-foreground', className)}>
        {value ? (revealed ? value : maskedFor(value)) : <span className="text-[var(--text-tertiary)]">{placeholder}</span>}
      </span>
    );
  }

  if (editing) {
    return (
      <span className={cn('group inline-flex items-center gap-1.5', className)}>
        <input
          ref={inputRef}
          type={revealed ? 'text' : 'password'}
          value={draft}
          aria-label={ariaLabel ?? 'SSN'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== (value ?? '')) onCommit(draft);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              setDraft(value ?? '');
              setEditing(false);
            }
          }}
          className="w-full bg-transparent border-0 outline-none text-[13px] text-foreground rounded -mx-1 px-1 py-0.5 ring-2 ring-[var(--accent)]"
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault() /* keep focus on input */}
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? 'Hide SSN' : 'Reveal SSN'}
          title={revealed ? 'Hide SSN' : 'Reveal SSN'}
          className="inline-flex items-center justify-center h-5 w-5 rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
        >
          <WIcon name={revealed ? 'eye-off' : 'eye'} size={11} />
        </button>
      </span>
    );
  }

  return (
    <span className={cn('group inline-flex items-center gap-1.5', className)}>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={ariaLabel ?? 'Edit SSN'}
        className="text-left text-[13px] text-foreground rounded -mx-1 px-1 py-0.5 hover:bg-[var(--bg-row-hover)] cursor-text min-w-0"
      >
        {value ? (
          <span className="num">{revealed ? value : maskedFor(value)}</span>
        ) : (
          <span className="text-[var(--text-tertiary)]">{placeholder}</span>
        )}
      </button>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label="Edit SSN"
        title="Edit SSN"
        className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center h-5 w-5 rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
      >
        <WIcon name="edit" size={11} />
      </button>
      {value && (
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? 'Hide SSN' : 'Reveal SSN'}
          title={revealed ? 'Hide SSN' : 'Reveal SSN'}
          className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center h-5 w-5 rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
        >
          <WIcon name={revealed ? 'eye-off' : 'eye'} size={11} />
        </button>
      )}
    </span>
  );
}
