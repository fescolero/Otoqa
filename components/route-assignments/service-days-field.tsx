'use client';

import * as React from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/**
 * Service-calendar editor for a route assignment.
 *
 * Deliberately NOT the `components/web/create-form/controls/days.tsx`
 * DaysControl — that one is styled with the web design-system tokens
 * (--accent, --bg-surface) and would clash inside a shadcn Dialog. Same
 * value shape though: a sorted `number[]`, 0 = Sunday.
 *
 * The days are matched against the LOAD'S service date (its first stop),
 * not the clock — so "Monday" means Monday at the pickup facility. The
 * helper text says so, because a dispatcher reading "runs on Mondays"
 * could reasonably assume either.
 *
 * `undefined` means "runs every day", which is also what the backend stores
 * for a full seven-day selection.
 */

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];
const WEEKDAYS = [1, 2, 3, 4, 5];

export interface ServiceDaysValue {
  activeDays: number[] | undefined;
  excludeFederalHolidays: boolean;
}

export function ServiceDaysField({
  value,
  onChange,
  disabled,
}: {
  value: ServiceDaysValue;
  onChange: (next: ServiceDaysValue) => void;
  disabled?: boolean;
}) {
  const restricted = value.activeDays !== undefined;
  const days = value.activeDays ?? [];

  const setRestricted = (on: boolean) =>
    onChange({ ...value, activeDays: on ? WEEKDAYS : undefined });

  const toggleDay = (day: number) => {
    const next = days.includes(day)
      ? days.filter((d) => d !== day)
      : [...days, day].sort((a, b) => a - b);
    // Never let the picker reach zero days — the backend rejects an empty
    // list (it means "never", and reading it as "always" is the worst
    // possible guess), so don't offer the state at all.
    if (next.length === 0) return;
    onChange({ ...value, activeDays: next });
  };

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="restrict-days">Runs only on specific days</Label>
          <p className="text-xs text-muted-foreground">
            Matched against the load&apos;s pickup date, not today&apos;s date.
          </p>
        </div>
        <Switch
          id="restrict-days"
          checked={restricted}
          onCheckedChange={setRestricted}
          disabled={disabled}
        />
      </div>

      {restricted && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {DAY_ABBR.map((abbr, day) => {
              const on = days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleDay(day)}
                  disabled={disabled}
                  aria-pressed={on}
                  aria-label={DAY_NAMES[day]}
                  title={DAY_NAMES[day]}
                  className={cn(
                    'h-8 rounded-full border px-3 text-xs font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    on
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input bg-background text-muted-foreground hover:bg-accent',
                  )}
                >
                  {abbr}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="skip-holidays" className="text-sm font-normal">
              Skip federal holidays
            </Label>
            <Switch
              id="skip-holidays"
              checked={value.excludeFederalHolidays}
              onCheckedChange={(on) => onChange({ ...value, excludeFederalHolidays: on })}
              disabled={disabled}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Loads on other days stay unassigned for a dispatcher to handle.
          </p>
        </>
      )}
    </div>
  );
}
