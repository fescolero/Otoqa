/**
 * DuplicateAlert — amber inset block shown under a field when its
 * `dupCheck` returns a hit. Never blocks save (Save & New / Save stay
 * enabled). Offers "Open existing" / "Continue anyway" affordances —
 * the caller can override the click handlers per-field.
 */

'use client';

import * as React from 'react';
import type { DupCheckHit } from './schema-types';

interface DuplicateAlertProps {
  match: DupCheckHit;
  onOpenExisting?: () => void;
  onDismiss?: () => void;
}

export function DuplicateAlert({
  match,
  onOpenExisting,
  onDismiss,
}: DuplicateAlertProps) {
  return (
    <div
      role="status"
      style={{
        marginTop: 6,
        padding: '8px 10px',
        background: 'rgba(245, 158, 11, 0.08)',
        border: '1px solid rgba(245, 158, 11, 0.22)',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 11.5,
          color: '#7A4F00',
          lineHeight: 1.45,
        }}
      >
        <strong style={{ fontWeight: 600 }}>{match.label}</strong>{' '}
        looks like a potential match{' '}
        <span style={{ color: '#A66800' }}>· {match.detail}</span>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {onOpenExisting && (
          <button
            type="button"
            onClick={onOpenExisting}
            style={{
              all: 'unset',
              fontSize: 11,
              color: '#7A4F00',
              fontWeight: 600,
              textDecoration: 'underline',
              cursor: 'pointer',
            }}
          >
            Open existing
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            style={{
              all: 'unset',
              fontSize: 11,
              color: '#A66800',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Continue anyway
          </button>
        )}
      </div>
    </div>
  );
}
