/**
 * Detail-Slide card primitives.
 *
 *   DSCard          — bordered card with optional header bar (title + action)
 *   DSProps         — key/value grid (120px label col, 1fr value col) with
 *                     hairline dividers between rows; falsy items dropped
 *   DSPropsEditable — same shape, but each value is an inline-editable
 *                     <EditableField>. Items can opt out per-row via
 *                     `readOnly: true`, or carry an `editor: { type, options,
 *                     placeholder }` config that selects the editor flavour
 *                     (text / phone / email / textarea / date / select /
 *                     multiselect)
 *   DSStat          — large number stat with label and optional delta
 *   DSSectionBlock  — labeled section grouping for the scroll layout
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { EditableField, type EditableSelectOption } from './editable-field';
import { WIcon, type IconName } from './icons';

interface DSCardProps {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function DSCard({ title, action, children, className, bodyClassName }: DSCardProps) {
  return (
    <section
      className={cn('rounded-xl border border-[var(--border-hairline)] bg-card overflow-hidden', className)}
    >
      {(title || action) && (
        <header
          className="flex items-center justify-between gap-2 px-4 h-11 border-b border-[var(--border-hairline)] bg-[var(--bg-surface-2)]"
        >
          {title && (
            <h3 className="m-0 text-[13px] font-semibold text-foreground tracking-[0.002em]">{title}</h3>
          )}
          {action && <div className="flex items-center gap-1.5">{action}</div>}
        </header>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export interface DSPropItem {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Optional editable wrapper / chip / etc. — render-only sentinel. */
  hint?: React.ReactNode;
}

export type DSPropsEditableType =
  | 'text'
  | 'email'
  | 'phone'
  | 'textarea'
  | 'date'
  | 'select'
  | 'multiselect';

export interface DSPropsEditableEditor {
  type?: DSPropsEditableType;
  options?: EditableSelectOption[];
  placeholder?: string;
  rows?: number;
  /** Date display format passed to date-fns. */
  format?: string;
}

export interface DSPropsEditableItem {
  /** Stable key used by `onCommit` to identify the field. */
  key: string;
  label: React.ReactNode;
  /** Current raw value (string for most types, string[] for `multiselect`). */
  value?: string | string[];
  /** Optional rich display override — chips, highlights, formatted spans. */
  display?: React.ReactNode;
  editor?: DSPropsEditableEditor;
  /** Skips edit affordance — renders the display value only. */
  readOnly?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  /** Custom value cell. When provided, replaces the entire EditableField
   *  for this row — used for fields that need a non-string editor (e.g.
   *  `<EditableAddress>` with a structured AddressData payload). The row
   *  still gets the same hairline + label-column treatment as the rest. */
  custom?: React.ReactNode;
  /** Decorative content rendered AFTER the editable value but OUTSIDE the
   *  editor's click target — use this for status chips, badges, etc. so the
   *  editor's hover/focus background doesn't extend over the decoration and
   *  visually suggest it's interactive. */
  trailing?: React.ReactNode;
}

interface DSPropsProps {
  items: Array<DSPropItem | null | undefined | false>;
  className?: string;
  /** Width of the label column in pixels. Default 120. */
  labelWidth?: number;
}

export function DSProps({ items, className, labelWidth = 120 }: DSPropsProps) {
  const live = items.filter(Boolean) as DSPropItem[];
  return (
    <dl className={cn('grid gap-0', className)} style={{ gridTemplateColumns: `${labelWidth}px 1fr` }}>
      {live.map((it, i) => (
        <React.Fragment key={i}>
          <dt
            className={cn(
              'py-2.5 pr-3 text-[12.5px] text-[var(--text-tertiary)]',
              i > 0 && 'border-t border-[var(--border-hairline)]',
            )}
          >
            {it.label}
          </dt>
          <dd
            className={cn(
              // min-w-0 lets flex children shrink so `truncate` on a value
              // can actually engage instead of overflowing the card.
              'py-2.5 m-0 text-[13px] text-foreground inline-flex items-center gap-2 min-w-0',
              i > 0 && 'border-t border-[var(--border-hairline)]',
            )}
          >
            {it.value}
            {it.hint}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

interface DSPropsEditableProps {
  items: Array<DSPropsEditableItem | null | undefined | false>;
  /** Called when a row's editor commits a new value. */
  onCommit?: (key: string, next: string | string[]) => void;
  className?: string;
  labelWidth?: number;
}

export function DSPropsEditable({
  items,
  onCommit,
  className,
  labelWidth = 120,
}: DSPropsEditableProps) {
  const live = items.filter(Boolean) as DSPropsEditableItem[];
  return (
    <dl className={cn('grid gap-0', className)} style={{ gridTemplateColumns: `${labelWidth}px 1fr` }}>
      {live.map((it, i) => (
        <React.Fragment key={it.key}>
          <dt
            className={cn(
              'py-2.5 pr-3 text-[12.5px] text-[var(--text-tertiary)]',
              i > 0 && 'border-t border-[var(--border-hairline)]',
            )}
          >
            {it.label}
          </dt>
          <dd
            className={cn(
              'py-2.5 m-0 text-[13px] text-foreground inline-flex items-center gap-2 min-w-0',
              i > 0 && 'border-t border-[var(--border-hairline)]',
            )}
          >
            {it.custom !== undefined ? it.custom : <DSPropsEditableField item={it} onCommit={onCommit} />}
            {it.trailing != null && <span className="inline-flex items-center shrink-0">{it.trailing}</span>}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function DSPropsEditableField({
  item,
  onCommit,
}: {
  item: DSPropsEditableItem;
  onCommit?: (key: string, next: string | string[]) => void;
}) {
  const editor = item.editor ?? {};
  const type = editor.type ?? 'text';
  const commit = (next: string | string[]) => onCommit?.(item.key, next);

  const itemValue = item.value ?? '';

  if (type === 'multiselect') {
    const value = Array.isArray(itemValue) ? itemValue : itemValue ? itemValue.split(' · ').map((s) => s.trim()).filter(Boolean) : [];
    return (
      <EditableField
        type="multiselect"
        value={value}
        options={editor.options ?? []}
        display={item.display}
        placeholder={item.placeholder ?? editor.placeholder}
        readOnly={item.readOnly}
        onCommit={(next) => commit(next)}
        ariaLabel={item.ariaLabel}
      />
    );
  }

  const value = Array.isArray(itemValue) ? itemValue.join(', ') : itemValue;

  if (type === 'date') {
    return (
      <EditableField
        type="date"
        value={value}
        display={item.display}
        format={editor.format}
        placeholder={item.placeholder ?? editor.placeholder}
        readOnly={item.readOnly}
        onCommit={(next) => commit(next)}
        ariaLabel={item.ariaLabel}
      />
    );
  }
  if (type === 'select') {
    return (
      <EditableField
        type="select"
        value={value}
        options={editor.options ?? []}
        display={item.display}
        placeholder={item.placeholder ?? editor.placeholder}
        readOnly={item.readOnly}
        onCommit={(next) => commit(next)}
        ariaLabel={item.ariaLabel}
      />
    );
  }
  if (type === 'textarea') {
    return (
      <EditableField
        type="textarea"
        value={value}
        rows={editor.rows}
        display={item.display}
        placeholder={item.placeholder ?? editor.placeholder}
        readOnly={item.readOnly}
        onCommit={(next) => commit(next)}
        ariaLabel={item.ariaLabel}
      />
    );
  }
  return (
    <EditableField
      type={type as 'text' | 'email' | 'phone'}
      value={value}
      display={item.display}
      placeholder={item.placeholder ?? editor.placeholder}
      readOnly={item.readOnly}
      onCommit={(next: string) => commit(next)}
      ariaLabel={item.ariaLabel}
    />
  );
}

interface DSStatProps {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: { value: React.ReactNode; tone?: 'up' | 'down' | 'neutral' };
  className?: string;
}

export function DSStat({ label, value, delta, className }: DSStatProps) {
  const deltaColor =
    delta?.tone === 'up'   ? '#0F8C5F' :
    delta?.tone === 'down' ? '#B43030' :
                             'var(--text-tertiary)';
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="tw-label">{label}</span>
      <span className="num text-[24px] leading-7 font-semibold tracking-[-0.01em] text-foreground">{value}</span>
      {delta && (
        <span className="text-[11.5px] font-medium" style={{ color: deltaColor }}>
          {delta.value}
        </span>
      )}
    </div>
  );
}

interface DSSectionBlockProps {
  icon?: IconName;
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function DSSectionBlock({ icon, label, children, className }: DSSectionBlockProps) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <header className="flex items-center gap-2 text-[var(--text-tertiary)]">
        {icon && <WIcon name={icon} size={13} />}
        <span className="tw-label">{label}</span>
      </header>
      {children}
    </section>
  );
}
