'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface NumberInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue'> {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number | undefined) => void;
}

const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ className, value, defaultValue, onValueChange, onChange, name, ...props }, ref) => {
    const [displayValue, setDisplayValue] = React.useState('');
    const hiddenInputRef = React.useRef<HTMLInputElement>(null);

    // Format number with commas
    const formatNumber = (num: number | string | undefined): string => {
      if (num === undefined || num === '') return '';
      const numStr = typeof num === 'number' ? num.toString() : num;
      const cleaned = numStr.replace(/[^0-9.]/g, '');
      if (cleaned === '') return '';
      
      const parts = cleaned.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return parts.join('.');
    };

    // Parse formatted number back to raw number
    const parseNumber = (formatted: string): number | undefined => {
      if (formatted === '') return undefined;
      const cleaned = formatted.replace(/,/g, '');
      const parsed = parseFloat(cleaned);
      return isNaN(parsed) ? undefined : parsed;
    };

    // Initialize display value
    React.useEffect(() => {
      if (value !== undefined) {
        setDisplayValue(formatNumber(value));
      } else if (defaultValue !== undefined) {
        setDisplayValue(formatNumber(defaultValue));
      }
    }, [value, defaultValue]);

    // Update hidden input value when display value changes
    React.useEffect(() => {
      if (hiddenInputRef.current) {
        const numericValue = parseNumber(displayValue);
        hiddenInputRef.current.value = numericValue !== undefined ? numericValue.toString() : '';
      }
    }, [displayValue]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const inputValue = e.target.value;
      
      // Allow empty string
      if (inputValue === '') {
        setDisplayValue('');
        if (onValueChange) {
          onValueChange(undefined);
        }
        return;
      }

      // Only allow numbers, commas, and decimal point
      const cleaned = inputValue.replace(/[^0-9.,]/g, '');
      
      // Remove all commas for parsing
      const withoutCommas = cleaned.replace(/,/g, '');
      
      // Validate it's a valid number
      if (withoutCommas !== '' && !isNaN(parseFloat(withoutCommas))) {
        setDisplayValue(formatNumber(withoutCommas));
        
        if (onValueChange) {
          onValueChange(parseFloat(withoutCommas));
        }
      } else if (withoutCommas === '') {
        setDisplayValue('');
        if (onValueChange) {
          onValueChange(undefined);
        }
      }
    };

    return (
      <>
        <Input
          type="text"
          className={cn(className)}
          value={displayValue}
          onChange={handleChange}
          ref={ref}
          {...props}
        />
        {/* Hidden input for form submission with actual numeric value */}
        <input
          type="hidden"
          name={name}
          ref={hiddenInputRef}
        />
      </>
    );
  }
);
NumberInput.displayName = 'NumberInput';

export { NumberInput };
