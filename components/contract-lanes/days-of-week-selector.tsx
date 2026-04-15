'use client';

import { useId } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

// 0=Sun, 1=Mon, ..., 6=Sat (matches schedule rule activeDays)
const DAYS = [
  { value: 0, label: 'S', full: 'Sun' },
  { value: 1, label: 'M', full: 'Mon' },
  { value: 2, label: 'T', full: 'Tue' },
  { value: 3, label: 'W', full: 'Wed' },
  { value: 4, label: 'T', full: 'Thu' },
  { value: 5, label: 'F', full: 'Fri' },
  { value: 6, label: 'S', full: 'Sat' },
];

interface DaysOfWeekSelectorProps {
  value: number[];
  onChange: (days: number[]) => void;
  excludeHolidays: boolean;
  onExcludeHolidaysChange: (exclude: boolean) => void;
}

export function DaysOfWeekSelector({
  value,
  onChange,
  excludeHolidays,
  onExcludeHolidaysChange,
}: DaysOfWeekSelectorProps) {
  const holidayId = useId();

  const toggleDay = (day: number) => {
    if (value.includes(day)) {
      onChange(value.filter((d) => d !== day));
    } else {
      onChange([...value, day].sort((a, b) => a - b));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        {DAYS.map((day) => {
          const isActive = value.includes(day.value);
          return (
            <button
              key={day.value}
              type="button"
              title={day.full}
              onClick={() => toggleDay(day.value)}
              className={cn(
                'h-9 w-9 rounded-full text-sm font-medium transition-colors',
                'border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground border-input hover:bg-accent hover:text-accent-foreground'
              )}
            >
              {day.label}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id={holidayId}
          checked={excludeHolidays}
          onCheckedChange={(checked) => onExcludeHolidaysChange(checked === true)}
        />
        <Label htmlFor={holidayId} className="text-sm text-muted-foreground cursor-pointer">
          Exclude Federal Holidays
        </Label>
      </div>
    </div>
  );
}
