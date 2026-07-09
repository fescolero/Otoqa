/**
 * StatusHistoryCard — chronological "from → to" log of status changes.
 *
 * Used on the Overview tab of any record's full page. Each entry shows the
 * effective date (left col), the from→to chip pair, the reason, optional
 * note, and attribution (who triggered it).
 *
 * Driven by the audit log: pass an array of normalized entries (resolved
 * to state-machine IDs at the call-site so this component stays
 * presentational).
 */

'use client';

import * as React from 'react';
import { Chip } from './chip';
import { DSCard } from './ds-card';
import { WIcon } from './icons';
import { STATE_MACHINES, type StatusEntity, type StatusState } from './status-machines';

export interface StatusHistoryEntry {
  /** Display date for the row, e.g. "Apr 30, 2026". */
  date: string;
  fromId: string;
  toId: string;
  reason: string;
  note?: string;
  by: string;
}

interface StatusHistoryCardProps {
  entity: StatusEntity;
  entries: StatusHistoryEntry[];
  /** Hides the card entirely when there's nothing to show. Default true. */
  hideWhenEmpty?: boolean;
}

export function StatusHistoryCard({ entity, entries, hideWhenEmpty = true }: StatusHistoryCardProps) {
  if (hideWhenEmpty && entries.length === 0) return null;
  const machine = STATE_MACHINES[entity];

  return (
    <DSCard title="Status history">
      <div className="flex flex-col gap-0">
        {entries.length === 0 ? (
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)]">
            No status changes recorded yet.
          </p>
        ) : (
          entries.map((h, i) => {
            const from = pickState(machine.states, h.fromId);
            const to = pickState(machine.states, h.toId);
            return (
              <div
                key={i}
                className="grid gap-3 py-2"
                style={{
                  gridTemplateColumns: '90px 1fr',
                  borderBottom: i < entries.length - 1 ? '1px solid var(--border-hairline)' : undefined,
                }}
              >
                <div className="num text-[11.5px] text-[var(--text-tertiary)] whitespace-nowrap">
                  {h.date}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Chip status={from.kind} label={from.label} />
                    <WIcon name="arrow-up-right" size={11} color="var(--text-tertiary)" />
                    <Chip status={to.kind} label={to.label} />
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--text-secondary)] leading-[17px]">
                    <strong className="text-foreground">{h.reason}</strong>
                    {h.note ? ` — ${h.note}` : ''}
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-[var(--text-tertiary)]">by {h.by}</div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </DSCard>
  );
}

function pickState(
  states: Record<string, StatusState>,
  id: string,
): StatusState {
  return states[id] ?? { id, label: id, kind: 'inactive', category: 'Active' };
}
