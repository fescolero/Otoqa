'use client';

import * as React from 'react';
import { CalendarIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

function formatDate(date: Date | undefined) {
  if (!date) {
    return '';
  }

  // Format as yyyy-MM-dd
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day));
    if (
      parsed.getFullYear() === Number(year) &&
      parsed.getMonth() === Number(month) - 1 &&
      parsed.getDate() === Number(day)
    ) {
      return parsed;
    }
    return undefined;
  }

  const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day));
    if (
      parsed.getFullYear() === Number(year) &&
      parsed.getMonth() === Number(month) - 1 &&
      parsed.getDate() === Number(day)
    ) {
      return parsed;
    }
    return undefined;
  }

  const parsed = new Date(trimmed);
  return isValidDate(parsed) ? parsed : undefined;
}

function isValidDate(date: Date | undefined) {
  if (!date) {
    return false;
  }
  return !isNaN(date.getTime());
}

interface DatePickerProps {
  id?: string;
  name: string;
  value?: Date;
  defaultValue?: string; // ISO date string from database
  onChange?: (date: Date | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
}

export function DatePicker({
  id,
  name,
  value,
  defaultValue,
  onChange,
  placeholder = 'yyyy-mm-dd',
  disabled = false,
  required = false,
}: DatePickerProps) {
  // Initialize from defaultValue (ISO string) or value (Date object)
  const initialDate = React.useMemo(() => {
    if (value) return value;
    if (defaultValue) {
      const parsed = new Date(defaultValue);
      return isValidDate(parsed) ? parsed : undefined;
    }
    return undefined;
  }, [value, defaultValue]);

  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState<Date | undefined>(initialDate);
  const [month, setMonth] = React.useState<Date | undefined>(initialDate);
  const [inputValue, setInputValue] = React.useState(formatDate(initialDate));

  React.useEffect(() => {
    setDate(initialDate);
    setMonth(initialDate);
    setInputValue(formatDate(initialDate));
  }, [initialDate]);

  // Dynamic year range based on current year
  const currentYear = new Date().getFullYear();
  const fromYear = currentYear - 100; // 100 years back for birthdates
  const toYear = currentYear + 50; // 50 years ahead for expiration dates

  const handleDateSelect = (selectedDate: Date | undefined) => {
    setDate(selectedDate);
    setInputValue(formatDate(selectedDate));
    setOpen(false);
    onChange?.(selectedDate);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);

    const parsedDate = parseDateInput(newValue);
    if (parsedDate) {
      setDate(parsedDate);
      setMonth(parsedDate);
      onChange?.(parsedDate);
    }
  };

  return (
    <>
      <div className="relative flex gap-2 max-w-[180px]">
        <Input
          id={id}
          value={inputValue}
          placeholder={placeholder}
          className="bg-background pr-10"
          disabled={disabled}
          onChange={handleInputChange}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
            }
          }}
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="absolute top-1/2 right-2 size-6 -translate-y-1/2"
              disabled={disabled}
            >
              <CalendarIcon className="size-3.5" />
              <span className="sr-only">Select date</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto overflow-hidden p-0" align="end" alignOffset={-8} sideOffset={10}>
            <Calendar
              mode="single"
              selected={date}
              captionLayout="dropdown"
              month={month}
              onMonthChange={setMonth}
              onSelect={handleDateSelect}
              fromYear={fromYear}
              toYear={toYear}
            />
          </PopoverContent>
        </Popover>
      </div>
      {/* Hidden input to submit the date value with the form */}
      <input
        type="hidden"
        name={name}
        value={
          date
            ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
            : ''
        }
        required={required}
      />
    </>
  );
}
