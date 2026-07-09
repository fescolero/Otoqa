/**
 * ErrorSummary — red banner shown at the top of the content column
 * after a failed Save attempt. Lists every field that failed validation
 * as a pill button that scrolls to + focuses the offending field.
 *
 * Gated by `submitted` in the parent; never shown before the user has
 * tried to save (otherwise opening a fresh form would scream red).
 */

'use client';

import * as React from 'react';
import { WIcon } from '@/components/web/icons';
import type { FormErrors } from './schema-types';

interface ErrorSummaryProps {
  errors: FormErrors;
  /** Map of field id → human label. Built once by `fieldLabels(schema)`. */
  fieldLabels: Record<string, string>;
  onJump: (fieldId: string) => void;
}

export function ErrorSummary({
  errors,
  fieldLabels,
  onJump,
}: ErrorSummaryProps) {
  const failedIds = Object.keys(errors).filter((id) => errors[id]);
  if (failedIds.length === 0) return null;

  return (
    <div
      style={{
        background: 'rgba(180, 48, 48, 0.05)',
        border: '1px solid rgba(180, 48, 48, 0.30)',
        borderRadius: 8,
        padding: '12px 14px',
        marginBottom: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12.5,
          fontWeight: 600,
          color: '#B43030',
        }}
      >
        <WIcon name="alert" size={13} />
        {failedIds.length} field{failedIds.length === 1 ? '' : 's'} need
        attention before this can be saved
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {failedIds.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onJump(id)}
            className="focus-ring"
            style={{
              all: 'unset',
              padding: '4px 10px',
              borderRadius: 999,
              background: '#fff',
              border: '1px solid rgba(180, 48, 48, 0.30)',
              color: '#B43030',
              fontSize: 11.5,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {fieldLabels[id] ?? id}
          </button>
        ))}
      </div>
    </div>
  );
}
