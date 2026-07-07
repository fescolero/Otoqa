/**
 * AField — wrapper applied to every rendered field.
 *
 * Responsibilities:
 *   - Inline label + Required/Recommended tag (Rule 4).
 *   - Grid placement: full row (composite), span 2, or single track.
 *   - Hint text when there's no error.
 *   - Error row (alert icon + message, `role="alert"`).
 *   - `data-field={id}` for the jump-to-error helper to find.
 *
 * The actual control is `children`. Side-block content like the amber
 * duplicate-warning sits in `after` so it renders below the control but
 * inside the field's grid cell.
 */

'use client';

import * as React from 'react';
import { WIcon } from '@/components/web/icons';
import type { RequiredTier } from './schema-types';

interface AFieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  required?: RequiredTier;
  recommended?: boolean;
  /** 1 = single track, 2 = two tracks. */
  span?: 1 | 2;
  /** Forces grid-column: 1 / -1 — used by composite kinds. */
  full?: boolean;
  children: React.ReactNode;
  /** Content rendered after the control (e.g. DuplicateAlert). */
  after?: React.ReactNode;
}

export function AField({
  id,
  label,
  hint,
  error,
  required,
  recommended,
  span,
  full,
  children,
  after,
}: AFieldProps) {
  return (
    <div
      data-field={id}
      style={{
        gridColumn: full ? '1 / -1' : span === 2 ? 'span 2' : 'auto',
        minWidth: 0,
        scrollMarginTop: 24,
      }}
    >
      <label
        htmlFor={id}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 7,
          flexWrap: 'wrap',
          marginBottom: 5,
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 500,
            color: 'var(--text-secondary)',
          }}
        >
          {label}
        </span>
        {required === 'tier1' && <TierTag tone="required">Required</TierTag>}
        {recommended && required !== 'tier1' && (
          <TierTag tone="recommended">Recommended</TierTag>
        )}
        {/* 'Optional' tag intentionally omitted — it's the default state. */}
      </label>

      {children}
      {after}

      {hint && !error && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-tertiary)',
            marginTop: 5,
            lineHeight: 1.45,
          }}
        >
          {hint}
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 5,
            fontSize: 11.5,
            color: '#B43030',
            marginTop: 5,
            lineHeight: 1.45,
          }}
        >
          <WIcon
            name="alert"
            size={11}
            color="#B43030"
            style={{ marginTop: 2, flexShrink: 0 }}
          />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

function TierTag({
  tone,
  children,
}: {
  tone: 'required' | 'recommended';
  children: React.ReactNode;
}) {
  const color = tone === 'required' ? '#B43030' : '#A66800';
  return (
    <span
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        color,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  );
}
