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
  className?: string;
}

export function ComplianceMicroBars({ items, className }: ComplianceMicroBarsProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {items.map((it, i) => (
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
    </div>
  );
}
