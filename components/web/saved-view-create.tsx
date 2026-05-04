/**
 * SavedViewCreatePopover — small popover for naming + scoping a new saved view.
 *
 * Wraps a trigger element (typically the SavedViews "+" button) with a
 * Radix Popover that captures `name` and `scope` (`user` or `org`), then
 * calls `api.savedViews.createView` with the current filter / sort /
 * visibleColumns snapshot supplied by the consumer.
 *
 * Kept presentational — the consumer owns the snapshot and the entity
 * slug, so the same component works for Drivers / Loads / Carriers / etc.
 */

'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { useMutation } from 'convex/react';
import { cn } from '@/lib/utils';
import { api } from '@/convex/_generated/api';
import { WBtn } from './btn';

interface SavedViewCreatePopoverProps {
  /** Entity slug consumed by the savedViews API ('drivers' | 'loads' | …). */
  entity: string;
  /** Snapshot of the current state to persist. The shape is opaque to the
   *  API; the page interprets it on read. */
  filters?: unknown;
  sort?: { key: string; dir: 'asc' | 'desc' };
  visibleColumns?: string[];
  /** Trigger element — receives onClick to open the popover. */
  children: React.ReactNode;
  /** Fired after successful creation. */
  onCreated?: (id: string) => void;
}

export function SavedViewCreatePopover({
  entity,
  filters,
  sort,
  visibleColumns,
  children,
  onCreated,
}: SavedViewCreatePopoverProps) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [scope, setScope] = React.useState<'user' | 'org'>('user');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const create = useMutation(api.savedViews.createView);

  React.useEffect(() => {
    if (open) {
      setName('');
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const id = await create({
        entity,
        name: trimmed,
        scope,
        filters,
        sort,
        visibleColumns,
      });
      onCreated?.(id);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save view');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          className="z-50 w-72 rounded-lg border border-[var(--border-hairline-strong)] bg-card p-3 shadow-[var(--shadow-popover)]"
        >
          <h3 className="m-0 mb-2 text-[13px] font-semibold text-foreground">Save current view</h3>
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] font-medium text-[var(--text-tertiary)] uppercase tracking-[0.04em]">
                Name
              </span>
              <input
                ref={inputRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !saving) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder="My drivers (West Coast)"
                className="h-8 px-2 rounded border border-[var(--border-hairline)] bg-card text-[13px] text-foreground outline-none focus:border-[var(--accent)]"
              />
            </label>
            <fieldset className="flex flex-col gap-1">
              <legend className="text-[11.5px] font-medium text-[var(--text-tertiary)] uppercase tracking-[0.04em] mb-1">
                Visible to
              </legend>
              <div className="grid grid-cols-2 gap-1.5">
                <ScopeOption
                  selected={scope === 'user'}
                  onSelect={() => setScope('user')}
                  label="Just me"
                  caption="Private"
                />
                <ScopeOption
                  selected={scope === 'org'}
                  onSelect={() => setScope('org')}
                  label="Whole team"
                  caption="Org-wide"
                />
              </div>
            </fieldset>
            {error && <p className="m-0 text-[11.5px] text-[#B43030]">{error}</p>}
            <div className="flex items-center justify-end gap-1.5 pt-1">
              <WBtn size="xs" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
                Cancel
              </WBtn>
              <WBtn size="xs" variant="primary" onClick={() => void submit()} disabled={saving}>
                {saving ? 'Saving…' : 'Save view'}
              </WBtn>
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function ScopeOption({
  selected,
  onSelect,
  label,
  caption,
}: {
  selected: boolean;
  onSelect: () => void;
  label: React.ReactNode;
  caption: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'focus-ring h-auto px-2.5 py-2 rounded text-left flex flex-col gap-0.5 cursor-pointer',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        selected
          ? 'bg-[var(--accent-tint)] border border-[var(--accent)] text-[var(--accent)]'
          : 'bg-card border border-[var(--border-hairline)] text-foreground hover:bg-[var(--bg-row-hover)]',
      )}
    >
      <span className="text-[12.5px] font-medium">{label}</span>
      <span className="text-[10.5px] text-[var(--text-tertiary)]">{caption}</span>
    </button>
  );
}
