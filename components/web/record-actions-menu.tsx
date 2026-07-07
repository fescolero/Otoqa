'use client';

/**
 * RecordActionsMenu — record-level "⋯" overflow menu (per design v3
 * `web/screens/record-actions-menu.jsx`).
 *
 * Renders a Radix dropdown of grouped actions. Each item can be:
 *   • a no-op `onClick` (e.g. Duplicate / Export / Print stubs)
 *   • a soft-confirm action (one-step modal — Cancel / Archive)
 *   • a hard-confirm action (modal with a type-the-record-id gate —
 *     Delete on records that retain history)
 *
 * The component is entity-agnostic; consumers pass `groups`, the chosen
 * `recordLabel` (typed into the hard-confirm input to unlock the CTA),
 * and the `onAction(itemId)` callback that fires after the user
 * confirms a destructive item or clicks a stub item.
 *
 * The dropdown trigger (the ⋯ button) is rendered by this component;
 * place it directly inside `DetailsFullPage`'s `toolbarActions` slot.
 */

import * as React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { MoreHorizontal } from 'lucide-react';
import { WIcon, type IconName } from './icons';
import { cn } from '@/lib/utils';

export interface RecordActionItem {
  id: string;
  label: React.ReactNode;
  icon?: IconName;
  /** When set, picking this item opens a confirmation modal before
   *  `onAction(item.id)` fires. `'soft'` is a single-button confirm,
   *  `'hard'` adds a type-the-record-label input that must match before
   *  the CTA enables. */
  confirm?: 'soft' | 'hard';
  confirmTitle?: React.ReactNode;
  confirmBody?: React.ReactNode;
  confirmCta?: React.ReactNode;
  /** Renders the menu item in red. */
  danger?: boolean;
  /** Disables the menu item (e.g. when adminOnly and the caller isn't
   *  an admin). The item stays visible but is greyed out. */
  disabled?: boolean;
}

export interface RecordActionGroup {
  /** Items in this group; rendered together with a divider before the
   *  next group. */
  items: RecordActionItem[];
}

interface RecordActionsMenuProps {
  groups: RecordActionGroup[];
  /** Used by the hard-confirm variant — the user must type this exact
   *  string to enable the destructive CTA. Typically the record's order
   *  number, unit ID, or driver name. */
  recordLabel: string;
  /** Fires after the user confirms a destructive action (or immediately
   *  when a non-confirm stub item is picked). */
  onAction: (itemId: string) => void;
  /** Extra class applied to the ⋯ trigger button. */
  className?: string;
}

export function RecordActionsMenu({
  groups,
  recordLabel,
  onAction,
  className,
}: RecordActionsMenuProps) {
  const [confirmItem, setConfirmItem] = React.useState<RecordActionItem | null>(null);

  const onPick = (item: RecordActionItem) => {
    if (item.disabled) return;
    if (item.confirm) {
      setConfirmItem(item);
    } else {
      onAction(item.id);
    }
  };

  const onConfirm = (item: RecordActionItem) => {
    setConfirmItem(null);
    onAction(item.id);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-8 w-8 p-0', className)}
            aria-label="More actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[240px]">
          {groups.map((group, gi) => (
            <React.Fragment key={gi}>
              {gi > 0 && <DropdownMenuSeparator />}
              {group.items.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  disabled={item.disabled}
                  onClick={() => onPick(item)}
                  className={cn(
                    item.danger && 'text-red-600 focus:text-red-600',
                    item.disabled && 'opacity-60 cursor-not-allowed',
                  )}
                >
                  {item.icon && (
                    <WIcon name={item.icon} size={13} className="mr-2 text-current" />
                  )}
                  {item.label}
                </DropdownMenuItem>
              ))}
            </React.Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmModal
        item={confirmItem}
        recordLabel={recordLabel}
        onCancel={() => setConfirmItem(null)}
        onConfirm={onConfirm}
      />
    </>
  );
}

interface ConfirmModalProps {
  item: RecordActionItem | null;
  recordLabel: string;
  onCancel: () => void;
  onConfirm: (item: RecordActionItem) => void;
}

function ConfirmModal({ item, recordLabel, onCancel, onConfirm }: ConfirmModalProps) {
  const [typed, setTyped] = React.useState('');
  React.useEffect(() => {
    setTyped('');
  }, [item?.id]);

  if (!item) return null;
  const isHard = item.confirm === 'hard';
  const ctaEnabled = !isHard || typed.trim() === recordLabel;

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item.confirmTitle ?? 'Are you sure?'}</DialogTitle>
          {item.confirmBody && <DialogDescription>{item.confirmBody}</DialogDescription>}
        </DialogHeader>
        {isHard && (
          <div className="flex flex-col gap-2">
            <p className="text-[12.5px] text-[var(--text-secondary)] m-0">
              Type <span className="font-mono font-semibold text-foreground">{recordLabel}</span>{' '}
              to confirm.
            </p>
            <Input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={recordLabel}
              className="font-mono"
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!ctaEnabled}
            onClick={() => onConfirm(item)}
            className={cn(
              item.danger && ctaEnabled && 'bg-red-600 hover:bg-red-700 text-white',
            )}
          >
            {item.confirmCta ?? 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
