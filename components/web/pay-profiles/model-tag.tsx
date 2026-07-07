/**
 * ModelTag — colored chip for a pay profile's compensation model.
 *
 * Mirrors the design's color coding in settings-screen.jsx (ModelTag):
 *   Per-mile  → blue       Percentage → violet      Salary → amber
 *   Hourly    → green      Flat       → slate
 *
 * Used on the Pay profiles list page (Model column) and in the editor header.
 */

import * as React from 'react';
import type { PayBasis } from '@/lib/payProfileDisplay';
import { PAY_BASIS_LABEL } from '@/lib/payProfileDisplay';

const TONES: Record<string, { fg: string; bg: string }> = {
  'Per-mile':   { fg: '#1A47E6', bg: 'rgba(46,92,255,0.10)'  },
  'Hourly':     { fg: '#0F8C5F', bg: 'rgba(16,185,129,0.10)' },
  'Percentage': { fg: '#7C3AED', bg: 'rgba(124,58,237,0.10)' },
  'Salary':     { fg: '#A66800', bg: 'rgba(245,158,11,0.12)' },
  'Flat':       { fg: '#5A6172', bg: 'rgba(107,115,133,0.10)' },
  'Hybrid':     { fg: '#5A6172', bg: 'rgba(107,115,133,0.10)' },
};

export interface ModelTagProps {
  payBasis: PayBasis;
}

export function ModelTag({ payBasis }: ModelTagProps) {
  const label = PAY_BASIS_LABEL[payBasis];
  const tone = TONES[label] ?? TONES.Flat;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 18,
        padding: '0 8px',
        borderRadius: 9,
        background: tone.bg,
        color: tone.fg,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.02,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}
