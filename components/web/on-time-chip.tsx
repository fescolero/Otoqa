/**
 * OnTimeChip — per-load delivery badge: "On time", "Late 42m", or a
 * muted "—" when the leg is still open or no delivery was evaluable.
 *
 * Renders the summary the completed leg carries (deliveriesEvaluated /
 * deliveriesOnTime / deliveriesMaxLateMs — convex/_helpers/onTime.ts);
 * a load with several deliveries shows the worst one. Nothing here
 * re-derives on-time from stop times, so the badge and the driver KPI
 * always agree.
 */

'use client';

import * as React from 'react';
import { Chip } from './chip';
import { formatLateDuration } from '@/convex/_helpers/onTime';

export interface OnTimeSummary {
  evaluated: number;
  onTime: number;
  maxLateMs: number;
}

export function onTimeChipProps(
  s: OnTimeSummary | null | undefined,
): { status: 'valid' | 'expired' | 'na'; label: string } {
  if (!s || s.evaluated <= 0) return { status: 'na', label: '—' };
  if (s.onTime === s.evaluated) return { status: 'valid', label: 'On time' };
  const late = s.evaluated - s.onTime;
  const base = `Late ${formatLateDuration(s.maxLateMs)}`;
  // Several deliveries, some late: say how many so "Late 42m" on a
  // 3-drop load isn't read as the whole load being 42m late.
  return { status: 'expired', label: s.evaluated > 1 ? `${base} · ${late}/${s.evaluated}` : base };
}

export function OnTimeChip({ onTime }: { onTime: OnTimeSummary | null | undefined }) {
  const p = onTimeChipProps(onTime);
  return <Chip status={p.status} label={p.label} />;
}
