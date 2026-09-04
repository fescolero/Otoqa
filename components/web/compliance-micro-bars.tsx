/**
 * ComplianceMicroBars — list of driver/asset compliance items, each with
 * a chip showing its valid/expiring/expired status. Lives inside the
 * "Compliance" card on the Overview composer.
 *
 *   <ComplianceMicroBars items={[
 *     { label: 'License', number: 'A1234567', expires: 'May 2, 2026',
 *       status: 'expiring' },
 *     { label: 'Medical', number: '—', expires: '—', status: 'na' },
 *     { label: 'Background', untracked: true },
 *   ]} />
 *
 * `untracked` rows render the placeholder copy "Not tracked yet" with a
 * muted chip. Used for fields the backend doesn't currently store.
 *
 * Rows are sorted by urgency (expired → expiring → warning → valid → the
 * rest) so what needs action is on top, and only the first `maxVisible`
 * show by default with a "Show N more" toggle beneath — the card sits
 * beside the Now card and must not tower over it.
 */

'use client';

import * as React from 'react';
import { Chip, type ChipStatus } from './chip';
import { cn } from '@/lib/utils';

export interface ComplianceItem {
  label: React.ReactNode;
  number?: React.ReactNode;
  expires?: React.ReactNode;
  status?: ChipStatus;
  /** When true, renders the placeholder "Not tracked yet" copy with a
   *  muted chip — used when the backend doesn't carry this field. */
  untracked?: boolean;
}

interface ComplianceMicroBarsProps {
  items: ComplianceItem[];
  /** Rows shown before the "Show N more" toggle. `Infinity` shows all. */
  maxVisible?: number;
  className?: string;
}

export const DEFAULT_COMPLIANCE_MAX_VISIBLE = 4;

/** Lower sorts first. Statuses outside the compliance set (and untracked
 *  rows) sink to the bottom in their original order. */
const STATUS_RANK: Partial<Record<ChipStatus, number>> = {
  expired: 0,
  danger: 0,
  expiring: 1,
  warning: 1,
  valid: 2,
  active: 2,
  na: 3,
};

function rankOf(it: ComplianceItem): number {
  if (it.untracked) return 4;
  return STATUS_RANK[it.status ?? 'na'] ?? 3;
}

export function sortComplianceItems(items: readonly ComplianceItem[]): ComplianceItem[] {
  // Array.prototype.sort is stable, so ties keep the caller's order.
  return items.slice().sort((a, b) => rankOf(a) - rankOf(b));
}

export function ComplianceMicroBars({
  items,
  maxVisible = DEFAULT_COMPLIANCE_MAX_VISIBLE,
  className,
}: ComplianceMicroBarsProps) {
  const [expanded, setExpanded] = React.useState(false);
  const sorted = React.useMemo(() => sortComplianceItems(items), [items]);
  const hidden = Math.max(0, sorted.length - maxVisible);
  const visible = expanded || hidden === 0 ? sorted : sorted.slice(0, maxVisible);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {visible.map((it, i) => (
        <div
          key={i}
          className="grid items-center gap-2"
          style={{ gridTemplateColumns: '1fr auto' }}
        >
          <div className="min-w-0">
            <div className="flex items-baseline gap-2 text-[12.5px] text-foreground">
              <span className="font-medium">{it.label}</span>
              {it.number && (
                <span className="num text-[11px] text-[var(--text-tertiary)] truncate">
                  {it.number}
                </span>
              )}
            </div>
            <div className="mt-px text-[11px] text-[var(--text-tertiary)]">
              {it.untracked ? (
                <span className="italic">Not tracked yet</span>
              ) : it.expires ? (
                <>
                  expires <span className="num">{it.expires}</span>
                </>
              ) : null}
            </div>
          </div>
          <Chip status={it.untracked ? 'na' : (it.status ?? 'na')} label={it.untracked ? 'Not tracked' : undefined} />
        </div>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="focus-ring self-start mt-1 text-[12px] font-medium text-[var(--accent)] hover:underline bg-transparent border-0 p-0 cursor-pointer"
        >
          {expanded ? 'Show less' : `Show ${hidden} more`}
        </button>
      )}
    </div>
  );
}
