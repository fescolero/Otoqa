'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface SSNInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value'> {
  name?: string;
  value?: string;
  defaultValue?: string;
}

// Format SSN helper function
const formatSSN = (value: string, showFull: boolean): string => {
  // Remove all non-digits
  const digits = value.replace(/\D/g, '');

  if (showFull) {
    // Show full SSN while typing
    if (digits.length <= 3) {
      return digits;
    } else if (digits.length <= 5) {
      return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    } else {
      return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 9)}`;
    }
  } else {
    // Show masked version (***-**-1234)
    if (digits.length === 0) {
      return '';
    } else if (digits.length <= 4) {
      return '*'.repeat(digits.length);
    } else if (digits.length <= 6) {
      return `***-${'*'.repeat(digits.length - 3)}`;
    } else if (digits.length <= 9) {
      const lastFour = digits.slice(-4);
      return `***-**-${lastFour}`;
    } else {
      const lastFour = digits.slice(5, 9);
      return `***-**-${lastFour}`;
    }
  }
};

/**
 * SSNInput component with masked display (***-**-1234)
 * Shows only last 4 digits, stores full value
 */
const SSNInput = React.forwardRef<HTMLInputElement, SSNInputProps>(
  ({ className, name, value, defaultValue, onChange, ...props }, ref) => {
    // Initialize from value or defaultValue
    const initialValue = value ?? defaultValue ?? '';
    const initialDigits = initialValue.replace(/\D/g, '');

    const [displayValue, setDisplayValue] = React.useState(formatSSN(initialDigits, false));
    const [rawValue, setRawValue] = React.useState(initialDigits);
    const [isFocused, setIsFocused] = React.useState(false);

    // Update when controlled value changes
    React.useEffect(() => {
      if (value !== undefined) {
        const digits = value.replace(/\D/g, '');
        setRawValue(digits);
        setDisplayValue(formatSSN(digits, isFocused));
      }
    }, [value, isFocused]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.target.value;
      const digits = input.replace(/\D/g, '');

      // Limit to 9 digits
      const limitedDigits = digits.slice(0, 9);

      setRawValue(limitedDigits);
      setDisplayValue(formatSSN(limitedDigits, isFocused));

      // Call parent onChange if provided
      if (onChange) {
        const syntheticEvent = {
          ...e,
          target: {
            ...e.target,
            value: limitedDigits,
          },
        } as React.ChangeEvent<HTMLInputElement>;
        onChange(syntheticEvent);
      }
    };

    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
      setIsFocused(true);
      setDisplayValue(formatSSN(rawValue, true));
      props.onFocus?.(e);
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      setIsFocused(false);
      setDisplayValue(formatSSN(rawValue, false));
      props.onBlur?.(e);
    };

    return (
      <>
        <Input
          ref={ref}
          type="text"
          value={displayValue}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className={cn(className)}
          placeholder="***-**-1234"
          {...props}
        />
        {/* Hidden input for form submission with raw value */}
        {name && <input type="hidden" name={name} value={rawValue} />}
      </>
    );
  },
);

SSNInput.displayName = 'SSNInput';

export { SSNInput };
