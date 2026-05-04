/**
 * CommandPalette — ⌘K modal.
 *
 * Drives off the same NAV constant as the Sidebar so adding a route
 * exposes it everywhere. Keyboard:
 *   - ⌘K (Ctrl+K on Windows) toggles open
 *   - ↑ / ↓ navigate
 *   - ↵ jumps to the highlighted route
 *   - esc closes
 *
 * Built on the `cmdk` package (already a dep) inside a Radix Dialog so we
 * get the focus trap and overlay for free.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { cn } from '@/lib/utils';
import { WIcon } from '@/components/web';
import { NAV } from './nav';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

interface FlatItem {
  id: string;
  group: string;
  label: string;
  keywords: string[];
  href: string;
  icon: Parameters<typeof WIcon>[0]['name'];
}

function flattenNav(): FlatItem[] {
  const out: FlatItem[] = [];
  for (const sec of NAV) {
    if (sec.href) {
      out.push({
        id: `goto-${sec.id}`,
        group: 'Navigate',
        label: sec.label,
        keywords: [sec.label.toLowerCase()],
        href: sec.href,
        icon: sec.icon,
      });
    }
    if (sec.items) {
      for (const item of sec.items) {
        out.push({
          id: `goto-${sec.id}-${item.id}`,
          group: sec.label,
          label: item.label,
          keywords: [item.label.toLowerCase(), sec.label.toLowerCase()],
          href: item.href,
          icon: sec.icon,
        });
      }
    }
  }
  return out;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const items = React.useMemo(flattenNav, []);
  const groups = React.useMemo(() => {
    const map = new Map<string, FlatItem[]>();
    for (const it of items) {
      const arr = map.get(it.group) ?? [];
      arr.push(it);
      map.set(it.group, arr);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-[var(--bg-overlay)] data-[state=open]:animate-in data-[state=open]:fade-in"
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            'fixed left-1/2 top-[18vh] z-50 -translate-x-1/2 w-full max-w-[640px] mx-4',
            'rounded-xl border border-[var(--border-hairline-strong)] bg-card overflow-hidden',
            'data-[state=open]:slide-up',
          )}
          style={{ boxShadow: 'var(--shadow-cmd)' }}
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <Command label="Command palette" className="flex flex-col">
            <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border-hairline)]">
              <WIcon name="search" size={15} className="text-[var(--text-tertiary)]" />
              <Command.Input
                autoFocus
                placeholder="Search & jump…"
                className="flex-1 bg-transparent border-0 outline-0 text-[14px] text-foreground placeholder:text-[var(--text-tertiary)]"
              />
              <span className="text-[10.5px] font-medium text-[var(--text-tertiary)]">esc</span>
            </div>
            <Command.List className="scroll-thin max-h-[60vh] overflow-y-auto py-1">
              <Command.Empty className="px-4 py-8 text-center text-[12.5px] text-[var(--text-tertiary)]">
                No results.
              </Command.Empty>
              {groups.map(([group, groupItems]) => (
                <Command.Group
                  key={group}
                  heading={group}
                  className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-[0.04em] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-[var(--text-tertiary)]"
                >
                  {groupItems.map((it) => (
                    <Command.Item
                      key={it.id}
                      value={`${it.group} ${it.label} ${it.keywords.join(' ')}`}
                      onSelect={() => {
                        router.push(it.href);
                        onOpenChange(false);
                      }}
                      className={cn(
                        'mx-1.5 my-0.5 px-2.5 h-9 rounded-md flex items-center gap-2 text-[13px] cursor-pointer',
                        'data-[selected=true]:bg-[var(--bg-row-hover)] data-[selected=true]:text-foreground',
                        'text-[var(--text-secondary)]',
                      )}
                    >
                      <WIcon name={it.icon} size={14} className="text-[var(--text-tertiary)]" />
                      <span className="flex-1 truncate">{it.label}</span>
                      <WIcon name="arrow-right" size={12} className="text-[var(--text-tertiary)] opacity-0 data-[selected=true]:opacity-100" />
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
            <footer className="border-t border-[var(--border-hairline)] px-3 py-2 flex items-center gap-3 text-[10.5px] text-[var(--text-tertiary)]">
              <span className="inline-flex items-center gap-1">↑↓ navigate</span>
              <span className="inline-flex items-center gap-1">↵ select</span>
              <span className="flex-1" />
              <span className="inline-flex items-center gap-1">⌘K to toggle</span>
            </footer>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Hook that wires ⌘K (or Ctrl+K) to a setter for the palette open state. */
export function useCmdkShortcut(setOpen: React.Dispatch<React.SetStateAction<boolean>>) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
}
