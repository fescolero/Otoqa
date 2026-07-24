/**
 * Days-of-week composite — S M T W T F S circle toggles.
 *
 * Value is an array of day indices (0 = Sunday … 6 = Saturday), kept
 * sorted — matches `scheduleRuleValidator.activeDays` so the page
 * wrapper copies it straight onto the mutation. Mirrors the design's
 * DayPicker (record-create-shell.jsx); the "exclude federal holidays"
 * switch is a separate `toggle` field in the schema, not part of this
 * control.
 */

'use client';

import * as React from 'react';

// Three-letter labels — single letters made Sat/Sun and Tue/Thu
// indistinguishable.
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export interface DaysControlProps {
  id: string;
  value: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
}

export function DaysControl({ id, value, onChange, disabled }: DaysControlProps) {
  const sel = Array.isArray(value) ? value : [];
  const toggle = (i: number) =>
    onChange(
      sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i].sort((a, b) => a - b),
    );

  return (
    <div id={id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {DAY_ABBR.map((d, i) => {
        const on = sel.includes(i);
        return (
          <button
            key={i}
            type="button"
            onClick={() => toggle(i)}
            disabled={disabled}
            className="focus-ring"
            title={DAY_NAMES[i]}
            aria-pressed={on}
            aria-label={DAY_NAMES[i]}
            style={{
              height: 34,
              padding: '0 14px',
              borderRadius: 999,
              border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border-hairline-strong)'),
              background: on ? 'var(--accent)' : 'var(--bg-surface)',
              color: on ? '#fff' : 'var(--text-secondary)',
              fontSize: 12.5,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              transition:
                'background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
            }}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}
