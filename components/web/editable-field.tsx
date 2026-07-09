/**
 * EditableField — Linear/Attio-style inline editor.
 *
 * Click the value → it becomes a borderless input that takes the same
 * visual space (no jump). Inline ⌘↵ / ↵ saves; Esc cancels. Hover surfaces
 * an edit affordance (pencil for text, calendar for date, chevron for
 * select). After commit a faint "Saved Ns ago" hint fades in for a few
 * seconds.
 *
 * Editors:
 *   - text / email / phone — single-line input
 *   - textarea — multiline (Cmd+↵ saves, ↵ inserts newline)
 *   - date — popover calendar (uses react-day-picker)
 *   - select — searchable popover, keyboard-navigable
 *   - multiselect — chip list + popover; tokens joined by " · "
 *
 * Read-only mode (`readOnly`) just renders the display value and never
 * enters edit mode. Used by system-managed fields (Driver ID, Trip ID, …).
 */

'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { format as formatDate } from 'date-fns';
import { cn } from '@/lib/utils';
import { Calendar } from '@/components/ui/calendar';
import { WIcon } from './icons';

type EditableType = 'text' | 'email' | 'phone' | 'textarea' | 'date' | 'select' | 'multiselect';

export interface EditableSelectOption {
  value: string;
  label: string;
}

interface EditableFieldBaseProps {
  value: string;
  onCommit?: (next: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  /** Display-only override (renders e.g. a Chip). */
  display?: React.ReactNode;
  ariaLabel?: string;
}

interface TextProps extends EditableFieldBaseProps {
  type?: 'text' | 'email' | 'phone';
}

interface TextareaProps extends EditableFieldBaseProps {
  type: 'textarea';
  rows?: number;
}

interface DateProps extends EditableFieldBaseProps {
  type: 'date';
  /** ISO date string in/out. */
  format?: string;
}

interface SelectProps extends EditableFieldBaseProps {
  type: 'select';
  options: EditableSelectOption[];
}

interface MultiselectProps {
  value: string[];
  onCommit?: (next: string[]) => void;
  type: 'multiselect';
  options: EditableSelectOption[];
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  display?: React.ReactNode;
  ariaLabel?: string;
}

type EditableFieldProps = TextProps | TextareaProps | DateProps | SelectProps | MultiselectProps;

/* eslint-disable react-hooks/rules-of-hooks */
export function EditableField(props: EditableFieldProps) {
  const t = props.type ?? 'text';
  if (t === 'multiselect') return <MultiselectField {...(props as MultiselectProps)} />;
  if (t === 'date') return <DateField {...(props as DateProps)} />;
  if (t === 'select') return <SelectField {...(props as SelectProps)} />;
  if (t === 'textarea') return <TextareaField {...(props as TextareaProps)} />;
  return <TextField {...(props as TextProps)} />;
}
/* eslint-enable react-hooks/rules-of-hooks */

// ─── Shared display chrome ───────────────────────────────────────────────

function useSavedHint() {
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (savedAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    const clear = setTimeout(() => setSavedAt(null), 4000);
    return () => {
      clearInterval(id);
      clearTimeout(clear);
    };
  }, [savedAt]);
  const flash = () => setSavedAt(Date.now());
  const ago = savedAt == null ? null : Math.max(0, Math.floor((now - savedAt) / 1000));
  return { flash, ago };
}

function ReadOnlyValue({
  display,
  value,
  className,
}: {
  display?: React.ReactNode;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center text-[13px] text-foreground', className)}>
      {display ?? value}
    </span>
  );
}

/**
 * Decorative-only edit affordance. The wrapping editor (date / select /
 * text field) already owns the click target — this icon exists purely as
 * a visual cue that the value is editable. Making it `pointer-events-none`
 * avoids a second tap target alongside the value, which confused users
 * (e.g. the calendar icon next to a status chip looked like a separate
 * action distinct from clicking the date itself).
 */
function EditAffordance({ icon, label }: { icon: 'edit' | 'calendar' | 'chevron-down'; label?: string }) {
  return (
    <span
      aria-hidden
      title={label ?? 'Edit'}
      className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center h-5 w-5 rounded text-[var(--text-tertiary)]"
    >
      <WIcon name={icon} size={11} />
    </span>
  );
}

function SavedHint({ ago }: { ago: number | null }) {
  if (ago == null) return null;
  return (
    <span className="text-[11px] text-[var(--text-tertiary)] inline-flex items-center gap-1">
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: '#10B981' }} />
      Saved {ago === 0 ? 'just now' : `${ago}s ago`}
    </span>
  );
}

// ─── text / email / phone ───────────────────────────────────────────────

function TextField({ type = 'text', value, onCommit, placeholder, readOnly, className, display, ariaLabel }: TextProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const { flash, ago } = useSavedHint();

  React.useEffect(() => setDraft(value), [value]);
  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (readOnly || !onCommit) return <ReadOnlyValue display={display} value={value || placeholder} className={className} />;

  if (editing) {
    return (
      <input
        ref={inputRef}
        type={type === 'phone' ? 'tel' : type}
        value={draft}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) {
            onCommit(draft);
            flash();
          }
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        className={cn(
          'w-full bg-transparent border-0 outline-none text-[13px] text-foreground',
          'rounded -mx-1 px-1 py-0.5 ring-2 ring-[var(--accent)]',
          className,
        )}
      />
    );
  }

  return (
    <span className={cn('group inline-flex items-center gap-1.5', className)}>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={ariaLabel}
        className="text-left text-[13px] text-foreground hover:text-foreground rounded -mx-1 px-1 py-0.5 hover:bg-[var(--bg-row-hover)] cursor-text min-w-0 truncate"
      >
        {display ?? value ?? <span className="text-[var(--text-tertiary)]">{placeholder ?? '—'}</span>}
      </button>
      <EditAffordance icon="edit" />
      <SavedHint ago={ago} />
    </span>
  );
}

// ─── textarea ───────────────────────────────────────────────────────────

function TextareaField({ value, onCommit, rows = 3, placeholder, readOnly, className, display, ariaLabel }: TextareaProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const { flash, ago } = useSavedHint();

  React.useEffect(() => setDraft(value), [value]);
  React.useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (readOnly || !onCommit) return <ReadOnlyValue display={display} value={value || placeholder} className={className} />;

  if (editing) {
    return (
      <div className={cn('w-full flex flex-col gap-1', className)}>
        <textarea
          ref={ref}
          rows={rows}
          aria-label={ariaLabel}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== value) {
              onCommit(draft);
              flash();
            }
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
            } else if (e.key === 'Escape') {
              setDraft(value);
              setEditing(false);
            }
          }}
          className="w-full bg-transparent border border-[var(--accent)] outline-none rounded p-1.5 text-[13px] text-foreground resize-y"
        />
        <span className="text-[10.5px] text-[var(--text-tertiary)]">⌘↵ to save · esc to cancel</span>
      </div>
    );
  }

  return (
    <span className={cn('group inline-flex items-center gap-1.5', className)}>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={ariaLabel}
        className="text-left text-[13px] text-foreground rounded -mx-1 px-1 py-0.5 hover:bg-[var(--bg-row-hover)] cursor-text whitespace-pre-line"
      >
        {display ?? value ?? <span className="text-[var(--text-tertiary)]">{placeholder ?? '—'}</span>}
      </button>
      <EditAffordance icon="edit" />
      <SavedHint ago={ago} />
    </span>
  );
}

// ─── date ───────────────────────────────────────────────────────────────

function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

function DateField({ value, onCommit, placeholder, readOnly, className, display, format = 'MMM d, yyyy', ariaLabel }: DateProps) {
  const [open, setOpen] = React.useState(false);
  const { flash, ago } = useSavedHint();
  const date = parseDate(value);

  const display_ = display ?? (date ? formatDate(date, format) : <span className="text-[var(--text-tertiary)]">{placeholder ?? '—'}</span>);

  if (readOnly || !onCommit) return <ReadOnlyValue display={display_} value={value} className={className} />;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <span className={cn('group inline-flex items-center gap-1.5', className)}>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label={ariaLabel ?? 'Pick date'}
            className="text-left text-[13px] text-foreground rounded -mx-1 px-1 py-0.5 hover:bg-[var(--bg-row-hover)] cursor-pointer"
          >
            {display_}
          </button>
        </PopoverPrimitive.Trigger>
        <EditAffordance icon="calendar" />
        <SavedHint ago={ago} />
      </span>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          side="bottom"
          sideOffset={4}
          avoidCollisions
          collisionPadding={8}
          className="z-50 rounded-lg border border-[var(--border-hairline-strong)] bg-popover shadow-[var(--shadow-popover)] p-0"
        >
          <Calendar
            mode="single"
            selected={date}
            defaultMonth={date}
            captionLayout="dropdown"
            startMonth={new Date(1920, 0)}
            endMonth={new Date(2050, 11)}
            onSelect={(d) => {
              if (!d) return;
              const iso = d.toISOString().slice(0, 10);
              onCommit(iso);
              flash();
              setOpen(false);
            }}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// ─── select ─────────────────────────────────────────────────────────────

function SelectField({ value, onCommit, options, placeholder, readOnly, className, display, ariaLabel }: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const { flash, ago } = useSavedHint();

  React.useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const current = options.find((o) => o.value === value);
  const display_ = display ?? (current ? current.label : <span className="text-[var(--text-tertiary)]">{placeholder ?? '—'}</span>);

  if (readOnly || !onCommit) return <ReadOnlyValue display={display_} value={value} className={className} />;

  const filtered = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <span className={cn('group inline-flex items-center gap-1.5', className)}>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label={ariaLabel ?? 'Choose option'}
            className="text-left text-[13px] text-foreground rounded -mx-1 px-1 py-0.5 hover:bg-[var(--bg-row-hover)] cursor-pointer"
          >
            {display_}
          </button>
        </PopoverPrimitive.Trigger>
        <EditAffordance icon="chevron-down" />
        <SavedHint ago={ago} />
      </span>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 w-60 rounded-lg border border-[var(--border-hairline-strong)] bg-card shadow-[var(--shadow-popover)] overflow-hidden"
        >
          <div className="p-1.5 border-b border-[var(--border-hairline)]">
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="w-full h-7 bg-transparent border-0 outline-0 text-[12.5px] text-foreground"
            />
          </div>
          <div className="scroll-thin max-h-72 overflow-auto p-1">
            {filtered.length === 0 ? (
              <div className="p-4 text-center text-[12px] text-[var(--text-tertiary)]">No matches</div>
            ) : (
              filtered.map((o) => {
                const sel = o.value === value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => {
                      onCommit(o.value);
                      flash();
                      setOpen(false);
                    }}
                    className={cn(
                      'focus-ring w-full h-[30px] px-2 rounded text-left flex items-center gap-2 text-[12.5px] hover:bg-[var(--bg-row-hover)]',
                      sel ? 'text-[var(--accent)] font-medium' : 'text-foreground',
                    )}
                  >
                    <span className="flex-1">{o.label}</span>
                    {sel && <WIcon name="check" size={11} />}
                  </button>
                );
              })
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// ─── multiselect ────────────────────────────────────────────────────────

function MultiselectField({ value, onCommit, options, placeholder, readOnly, className, display, ariaLabel }: MultiselectProps) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const { flash, ago } = useSavedHint();
  const sel = new Set(value);

  React.useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const labelFor = (v: string) => options.find((o) => o.value === v)?.label ?? v;

  const display_ =
    display ??
    (value.length ? value.map(labelFor).join(' · ') : <span className="text-[var(--text-tertiary)]">{placeholder ?? '—'}</span>);

  if (readOnly || !onCommit) return <ReadOnlyValue display={display_} value={value.join(', ')} className={className} />;

  const toggle = (v: string) => {
    const next = new Set(sel);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onCommit([...next]);
    flash();
  };

  const filtered = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <span className={cn('group inline-flex items-center gap-1.5 flex-wrap', className)}>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label={ariaLabel ?? 'Choose options'}
            className="text-left text-[13px] text-foreground rounded -mx-1 px-1 py-0.5 hover:bg-[var(--bg-row-hover)] cursor-pointer"
          >
            {display_}
          </button>
        </PopoverPrimitive.Trigger>
        <EditAffordance icon="chevron-down" />
        <SavedHint ago={ago} />
      </span>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 w-60 rounded-lg border border-[var(--border-hairline-strong)] bg-card shadow-[var(--shadow-popover)] overflow-hidden"
        >
          <div className="p-1.5 border-b border-[var(--border-hairline)]">
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="w-full h-7 bg-transparent border-0 outline-0 text-[12.5px] text-foreground"
            />
          </div>
          <div className="scroll-thin max-h-72 overflow-auto p-1">
            {filtered.length === 0 ? (
              <div className="p-4 text-center text-[12px] text-[var(--text-tertiary)]">No matches</div>
            ) : (
              filtered.map((o) => {
                const checked = sel.has(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggle(o.value)}
                    className="focus-ring w-full h-[30px] px-2 rounded text-left flex items-center gap-2 text-[12.5px] text-foreground hover:bg-[var(--bg-row-hover)]"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'h-3.5 w-3.5 rounded shrink-0 inline-flex items-center justify-center',
                        checked
                          ? 'bg-[var(--accent)] border border-[var(--accent)]'
                          : 'border border-[var(--border-hairline-strong)]',
                      )}
                    >
                      {checked && <WIcon name="check" size={9} strokeWidth={2.6} color="#fff" />}
                    </span>
                    <span className="flex-1">{o.label}</span>
                  </button>
                );
              })
            )}
          </div>
          <div className="border-t border-[var(--border-hairline)] p-1.5 text-[11.5px] text-[var(--text-tertiary)]">
            {sel.size} selected
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
