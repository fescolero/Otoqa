'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface PhoneInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value'> {
  name?: string;
  value?: string;
  defaultValue?: string;
}

// Format phone number helper function
const formatPhoneNumber = (value: string): string => {
  // Remove all non-digits
  const digits = value.replace(/\D/g, '');

  // Format based on length
  if (digits.length <= 3) {
    return digits;
  } else if (digits.length <= 6) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  } else {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
  }
};

/**
 * PhoneInput component with auto-formatting to (XXX) XXX-XXXX
 * Strips formatting on form submission via hidden input
 */
const PhoneInput = React.forwardRef<HTMLInputElement, PhoneInputProps>(
  ({ className, name, value, defaultValue, onChange, ...props }, ref) => {
    // Initialize from value or defaultValue
    const initialValue = value ?? defaultValue ?? '';
    const initialDigits = initialValue.replace(/\D/g, '');

    const [displayValue, setDisplayValue] = React.useState(formatPhoneNumber(initialDigits));
    const [rawValue, setRawValue] = React.useState(initialDigits);

    // Update when controlled value changes
    React.useEffect(() => {
      if (value !== undefined) {
        const digits = value.replace(/\D/g, '');
        setRawValue(digits);
        setDisplayValue(formatPhoneNumber(digits));
      }
    }, [value]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.target.value;
      const digits = input.replace(/\D/g, '');

      // Limit to 10 digits
      const limitedDigits = digits.slice(0, 10);

      setRawValue(limitedDigits);
      setDisplayValue(formatPhoneNumber(limitedDigits));

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

    return (
      <>
        <Input
          ref={ref}
          type="tel"
          value={displayValue}
          onChange={handleChange}
          className={cn(className)}
          placeholder="(555) 123-4567"
          {...props}
        />
        {/* Hidden input for form submission with raw value */}
        {name && <input type="hidden" name={name} value={rawValue} />}
      </>
    );
  },
);

PhoneInput.displayName = 'PhoneInput';

export { PhoneInput };
