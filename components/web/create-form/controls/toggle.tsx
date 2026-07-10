/**
 * Toggle control — wraps the shadcn <Switch>. The schema's
 * `toggleLabel` renders next to the switch (the field's `label` above
 * is the section-level descriptor, not the affordance text).
 *
 * Typical use:
 *   { kind: 'toggle', label: 'Mailing address',
 *     toggleLabel: 'Mailing address is the same as physical',
 *     default: true }
 */

'use client';

import * as React from 'react';
import { Switch } from '@/components/ui/switch';

export interface ToggleControlProps {
  id: string;
  value: boolean;
  onChange: (next: boolean) => void;
  toggleLabel?: string;
  disabled?: boolean;
}

export function ToggleControl({
  id,
  value,
  onChange,
  toggleLabel,
  disabled,
}: ToggleControlProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minHeight: 32,
      }}
    >
      <Switch
        id={id}
        checked={Boolean(value)}
        onCheckedChange={onChange}
        disabled={disabled}
      />
      {toggleLabel && (
        <label
          htmlFor={id}
          style={{
            fontSize: 12.5,
            color: 'var(--text-secondary)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            userSelect: 'none',
          }}
        >
          {toggleLabel}
        </label>
      )}
    </div>
  );
}
