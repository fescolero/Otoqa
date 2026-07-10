/**
 * SessionDatePicker — compact day stepper + popover for the Active
 * Sessions live ops PageHeader.
 *
 * Live = today, with a pulsing green dot in the label.
 * Past = any of the previous 6 days (read-only replay).
 * Future = locked (today is the max).
 *
 * Past-day data isn't backed yet (no rollup query); the component still
 * surfaces the UI so the affordance is in place once the query lands —
 * past days outside today render with no data and the map's empty state.
 */

'use client';

import * as React from 'react';
import { WIcon } from '@/components/web';

const MS_PER_DAY = 86_400_000;

interface Props {
  date: Date;
  today: Date;
  onChange: (d: Date) => void;
  /** Set of `YYYY-MM-DD` keys that have data. Other days render disabled. */
  dataDays?: Set<string>;
}

export function SessionDatePicker({
  date,
  today,
  onChange,
  dataDays,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const isToday = sameDay(date, today);
  const lockedFuture = sameDay(date, today);

  const go = (delta: number) => {
    const next = new Date(date.getTime() + delta * MS_PER_DAY);
    if (next.getTime() > today.getTime()) return;
    onChange(next);
  };

  const label = isToday
    ? `Today, ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    : date.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });

  return (
    <div ref={ref} className="relative inline-flex items-center">
      <div
        className="flex h-[30px] items-center overflow-hidden rounded-md"
        style={{
          border: '1px solid var(--border-hairline-strong)',
          background: 'var(--bg-surface)',
        }}
      >
        <button
          type="button"
          onClick={() => go(-1)}
          title="Previous day"
          className="focus-ring flex h-7 w-7 items-center justify-center p-0"
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <WIcon name="chevron-left" size={14} />
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="focus-ring flex h-7 items-center gap-[7px] px-[10px] text-[12.5px] font-medium"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontFamily: 'inherit',
            borderLeft: '1px solid var(--border-hairline)',
            borderRight: '1px solid var(--border-hairline)',
            color: 'var(--text-primary)',
          }}
        >
          {isToday ? (
            <span
              className="relative inline-block"
              style={{ width: 8, height: 8 }}
            >
              <span
                className="absolute"
                style={{
                  inset: 0,
                  borderRadius: '50%',
                  background: '#22B07D',
                  opacity: 0.35,
                  animation: 'sessionPulse 2.2s ease-out infinite',
                }}
              />
              <span
                className="absolute"
                style={{
                  inset: 1,
                  borderRadius: '50%',
                  background: '#22B07D',
                }}
              />
            </span>
          ) : (
            <WIcon name="clock" size={12} />
          )}
          <span className="num">{label}</span>
          <WIcon name="chevron-down" size={11} />
        </button>
        <button
          type="button"
          onClick={() => go(+1)}
          disabled={lockedFuture}
          title={lockedFuture ? 'Already at today' : 'Next day'}
          className="focus-ring flex h-7 w-7 items-center justify-center p-0"
          style={{
            border: 'none',
            background: 'transparent',
            color: lockedFuture
              ? 'var(--text-quaternary, #9BA3B4)'
              : 'var(--text-secondary)',
            cursor: lockedFuture ? 'default' : 'pointer',
            opacity: lockedFuture ? 0.5 : 1,
            fontFamily: 'inherit',
          }}
        >
          <WIcon name="chevron-right" size={14} />
        </button>
      </div>
      {open && (
        <DatePickerPopover
          date={date}
          today={today}
          dataDays={dataDays}
          onPick={(d) => {
            onChange(d);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function DatePickerPopover({
  date,
  today,
  dataDays,
  onPick,
}: {
  date: Date;
  today: Date;
  dataDays?: Set<string>;
  onPick: (d: Date) => void;
}) {
  const days = React.useMemo(() => {
    const arr: Date[] = [];
    for (let i = 6; i >= 0; i--) {
      arr.push(new Date(today.getTime() - i * MS_PER_DAY));
    }
    return arr;
  }, [today]);
  // If no explicit data-day map was passed, assume only today has data
  // (the past-day rollup query isn't wired yet — see header comment).
  const effective =
    dataDays && dataDays.size > 0 ? dataDays : new Set([sameDayKey(today)]);

  return (
    <div
      className="absolute right-0 top-9 z-10 rounded-lg p-[10px]"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline-strong)',
        boxShadow:
          '0 12px 28px -8px rgba(15,22,36,0.18), 0 2px 6px rgba(15,22,36,0.06)',
        minWidth: 280,
      }}
    >
      <div
        className="px-1 pb-2 pt-0.5 text-[10.5px] font-medium uppercase tracking-[0.4px]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        Pick a day
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((d, i) => {
          const isToday = sameDay(d, today);
          const isSelected = sameDay(d, date);
          const has = effective.has(sameDayKey(d));
          return (
            <button
              type="button"
              key={i}
              onClick={() => has && onPick(d)}
              disabled={!has}
              title={has ? '' : 'No sessions on this day'}
              className="focus-ring flex h-14 flex-col items-center justify-center gap-0.5 rounded-md"
              style={{
                padding: 6,
                border:
                  '1px solid ' + (isSelected ? 'var(--accent)' : 'transparent'),
                background: isSelected ? 'rgba(46,92,255,0.06)' : 'transparent',
                cursor: has ? 'pointer' : 'default',
                opacity: has ? 1 : 0.42,
                fontFamily: 'inherit',
              }}
            >
              <span
                className="text-[9.5px] uppercase tracking-[0.4px]"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3)}
              </span>
              <span
                className="num text-[16px] font-semibold"
                style={{
                  color: isSelected ? 'var(--accent)' : 'var(--text-primary)',
                }}
              >
                {d.getDate()}
              </span>
              {isToday && (
                <span
                  className="block h-1 w-1 rounded-full"
                  style={{ background: '#22B07D' }}
                />
              )}
              {!isToday && has && (
                <span
                  className="block h-1 w-1 rounded-full"
                  style={{ background: 'var(--text-tertiary)', opacity: 0.5 }}
                />
              )}
              {!has && <span className="block" style={{ width: 4, height: 4 }} />}
            </button>
          );
        })}
      </div>
      <div
        className="mt-2 flex justify-between border-t pt-2 text-[11px]"
        style={{
          borderColor: 'var(--border-hairline)',
          color: 'var(--text-tertiary)',
        }}
      >
        <span>
          <span
            className="mr-[5px] inline-block align-[1px]"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#22B07D',
            }}
          />
          Live
        </span>
        <span>Past days are read-only replays</span>
      </div>
    </div>
  );
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function sameDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
