/**
 * Segmented control — pill switcher for 2–4 mutually-exclusive options.
 * No existing shadcn equivalent ships with the project, so this is
 * built fresh on the radix `RadioGroup` primitive (which gives us the
 * keyboard navigation and accessibility for free).
 *
 * Visual: an inline-flex row of pill buttons. Selected option has the
 * accent background + accent border; others are quiet.
 *
 * Each `FieldOption` may carry an optional `hint` (small descriptor
 * under the label inside the pill) and `icon` (lucide name).
 */

'use client';

import * as React from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { WIcon, type IconName } from '@/components/web/icons';
import type { FieldOption } from '../schema-types';

export interface SegmentedControlProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  options: FieldOption[];
  disabled?: boolean;
}

export function SegmentedControl({
  id,
  value,
  onChange,
  options,
  disabled,
}: SegmentedControlProps) {
  return (
    <RadioGroupPrimitive.Root
      id={id}
      value={value || undefined}
      onValueChange={onChange}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        gap: 6,
        flexWrap: 'wrap',
      }}
    >
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <RadioGroupPrimitive.Item
            key={opt.value}
            value={opt.value}
            disabled={disabled}
            className="focus-ring"
            style={{
              all: 'unset',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              // Pills are sized to match the 32px-tall input baseline
              // when single-line; when a `hint` is set the column
              // stacks, so vertical padding stays light to let the
              // two-line content breathe without ballooning the row.
              padding: opt.hint ? '4px 10px' : '3px 10px',
              minHeight: opt.hint ? 30 : 26,
              borderRadius: 999,
              border: `1px solid ${
                selected ? 'var(--accent)' : 'var(--border-hairline)'
              }`,
              background: selected
                ? 'rgba(46, 92, 255, 0.08)'
                : 'var(--bg-surface)',
              color: selected
                ? 'var(--accent)'
                : 'var(--text-secondary)',
              fontSize: 12.5,
              lineHeight: 1.15,
              fontWeight: selected ? 600 : 500,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.6 : 1,
              transition: 'background 120ms, border-color 120ms, color 120ms',
            }}
          >
            {opt.icon && <WIcon name={opt.icon as IconName} size={12} />}
            <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <span>{opt.label}</span>
              {opt.hint && (
                <span
                  style={{
                    fontSize: 10,
                    color: selected
                      ? 'var(--accent)'
                      : 'var(--text-tertiary)',
                    fontWeight: 400,
                    marginTop: 1,
                  }}
                >
                  {opt.hint}
                </span>
              )}
            </span>
          </RadioGroupPrimitive.Item>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}
