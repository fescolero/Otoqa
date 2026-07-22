/**
 * SavedViews — horizontal tab strip for view presets (All / Active / etc.).
 *
 * Each view can carry a count + tone (neutral/accent/warn/danger) — that's
 * how "Needs attention 11" gets the amber pill. Active view shows a 2px
 * accent underline; the optional "+" trailing button saves a new view from
 * the current filter state.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { CountBadge, type CountTone } from './count-badge';
import { WIcon } from './icons';

export interface SavedView {
  id: string;
  label: React.ReactNode;
  count?: number | string;
  tone?: CountTone;
}

interface SavedViewsProps {
  views: SavedView[];
  activeId: string;
  onChange: (id: string) => void;
  /** Click handler for the "+" button. Mutually exclusive with `renderAddButton`. */
  onAddView?: () => void;
  /** If provided, replaces the default "+" button entirely. Useful for
   *  wrapping the trigger in a popover (see SavedViewCreatePopover). */
  renderAddButton?: () => React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

/** Default + button — also exported so consumers can wrap it in a popover trigger. */
export const SavedViewsAddButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  function SavedViewsAddButton(props, ref) {
    return (
      <button
        type="button"
        ref={ref}
        title="Save current view"
        {...props}
        className={cn(
          'focus-ring inline-flex items-center justify-center h-8 w-8 ml-1 mb-2 rounded-md',
          'text-[var(--text-tertiary)] cursor-pointer',
          'hover:bg-[var(--bg-row-hover)] hover:text-foreground',
          'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          props.className,
        )}
      >
        <WIcon name="plus" size={14} />
      </button>
    );
  },
);

export function SavedViews({
  views,
  activeId,
  onChange,
  onAddView,
  renderAddButton,
  actions,
  className,
}: SavedViewsProps) {
  return (
    <div
      className={cn(
        'flex items-end h-12 px-4 sm:px-6 overflow-hidden',
        'bg-card border-b border-[var(--border-hairline)]',
        className,
      )}
    >
      {views.map((v) => {
        const active = v.id === activeId;
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => onChange(v.id)}
            className={cn(
              'focus-ring relative inline-flex items-center gap-2 h-12 px-3.5 cursor-pointer bg-transparent',
              'text-[13px] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              active ? 'text-foreground font-medium' : 'text-[var(--text-secondary)] font-normal hover:text-foreground',
            )}
          >
            <span>{v.label}</span>
            {v.count != null && <CountBadge n={v.count} tone={v.tone ?? 'neutral'} />}
            <span
              aria-hidden
              className="absolute -bottom-px left-2 right-2 h-0.5 rounded-sm transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]"
              style={{ background: active ? 'var(--accent)' : 'transparent' }}
            />
          </button>
        );
      })}
      {renderAddButton ? renderAddButton() : onAddView ? <SavedViewsAddButton onClick={onAddView} /> : null}
      {actions && (
        <>
          <div className="flex-1" />
          <div className="flex items-center gap-2 mb-2">{actions}</div>
        </>
      )}
    </div>
  );
}
