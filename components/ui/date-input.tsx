'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { CalendarIcon } from 'lucide-react';
import { format } from 'date-fns';

export interface DateInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value'> {
  name?: string;
  value?: string;
  defaultValue?: string;
  onDateChange?: (date: string | undefined) => void;
}

// Helper functions for date parsing and formatting
const parseISODate = (dateStr: string): Date | null => {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  return isNaN(date.getTime()) ? null : date;
};

const formatDisplayDate = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
};

const formatToISO = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseDateInput = (input: string): Date | null => {
  // Remove all non-digits
  const digits = input.replace(/\D/g, '');

  // Handle different input lengths
  if (digits.length === 8) {
    // MMDDYYYY format
    const month = parseInt(digits.slice(0, 2), 10);
    const day = parseInt(digits.slice(2, 4), 10);
    const year = parseInt(digits.slice(4, 8), 10);

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
      const date = new Date(year, month - 1, day);
      // Validate the date is real (e.g., not Feb 30)
      if (
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day
      ) {
        return date;
      }
    }
  }

  return null;
};

/**
 * DateInput component with manual entry and calendar picker fallback
 * Accepts typing like 01011990 → auto-formats to 01/01/1990
 * Stores ISO format (YYYY-MM-DD) for backend
 */
const DateInput = React.forwardRef<HTMLInputElement, DateInputProps>(
  ({ className, name, value, defaultValue, onChange, onDateChange, required, ...props }, ref) => {
    // Initialize from value or defaultValue
    const initialValue = value ?? defaultValue ?? '';
    const initialDate = React.useMemo(() => {
      if (!initialValue) return null;
      return parseISODate(initialValue);
    }, []);

    const [displayValue, setDisplayValue] = React.useState(initialDate ? formatDisplayDate(initialDate) : '');
    const [isoValue, setIsoValue] = React.useState(initialValue);
    const [calendarDate, setCalendarDate] = React.useState<Date | undefined>(initialDate || undefined);
    const [isOpen, setIsOpen] = React.useState(false);

    // Update when controlled value changes
    React.useEffect(() => {
      if (value !== undefined) {
        const date = parseISODate(value);
        if (date) {
          setDisplayValue(formatDisplayDate(date));
          setIsoValue(value);
          setCalendarDate(date);
        }
      }
    }, [value]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.target.value;
      setDisplayValue(input);

      // Try to parse as date
      const date = parseDateInput(input);
      if (date) {
        const iso = formatToISO(date);
        setIsoValue(iso);
        setCalendarDate(date);
        onDateChange?.(iso);

        // Format display nicely
        setDisplayValue(formatDisplayDate(date));
      } else {
        setIsoValue('');
        setCalendarDate(undefined);
        onDateChange?.(undefined);
      }

      // Call parent onChange if provided
      if (onChange) {
        const syntheticEvent = {
          ...e,
          target: {
            ...e.target,
            value: date ? formatToISO(date) : '',
          },
        } as React.ChangeEvent<HTMLInputElement>;
        onChange(syntheticEvent);
      }
    };

    const handleCalendarSelect = (date: Date | undefined) => {
      if (date) {
        const iso = formatToISO(date);
        setDisplayValue(formatDisplayDate(date));
        setIsoValue(iso);
        setCalendarDate(date);
        onDateChange?.(iso);
        setIsOpen(false);
      }
    };

    return (
      <div className="flex gap-2">
        <div className="flex-1">
          <Input
            ref={ref}
            type="text"
            value={displayValue}
            onChange={handleChange}
            className={cn(className)}
            placeholder="MM/DD/YYYY"
            {...props}
          />
          {/* Hidden input for form submission with ISO value */}
          {name && <input type="hidden" name={name} value={isoValue} />}
        </div>
        <Popover open={isOpen} onOpenChange={setIsOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="icon" className="shrink-0">
              <CalendarIcon className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar
              mode="single"
              selected={calendarDate}
              onSelect={handleCalendarSelect}
              initialFocus
            />
          </PopoverContent>
        </Popover>
      </div>
    );
  },
);

DateInput.displayName = 'DateInput';

export { DateInput };
