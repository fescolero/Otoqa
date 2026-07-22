// Shared types + range resolution for the redesigned Accounting Reports shell.
// See ../../REDESIGN_PLAN.md. Kept JSX-free so it can be imported anywhere.

import type { ReactNode } from 'react';
import type { IconName } from '@/components/web/icons';

// ── Views (SavedViews bar) ───────────────────────────────────────────────
export type ReportViewId = 'overview' | 'aging' | 'pl' | 'profit' | 'disc';

export interface ReportView {
  id: ReportViewId;
  label: string;
}

export const REPORT_VIEWS: ReportView[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'aging', label: 'A/R aging' },
  { id: 'pl', label: 'Profit & loss' },
  { id: 'profit', label: 'Profitability' },
  { id: 'disc', label: 'Discrepancies' },
];

// ── Range selector ───────────────────────────────────────────────────────
export type RangePresetId = 'this-month' | 'last-month' | 'this-quarter' | 'ytd' | 'custom';

export const RANGE_PRESETS: { id: Exclude<RangePresetId, 'custom'>; label: string }[] = [
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'this-quarter', label: 'This quarter' },
  { id: 'ytd', label: 'Year to date' },
];

export interface CustomRange {
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
}

export interface ResolvedRange {
  start: number;
  end: number;
  label: string;
  sub: string;
  preset: RangePresetId;
}

// Formatted in UTC on purpose: range boundaries are UTC month/quarter/year
// starts (see resolveRange) so they line up with the UTC period keys the
// accounting stats are bucketed by. Formatting in local time would print a
// boundary date that's off by the timezone offset (e.g. "May 31" for a
// Jun 1 UTC start in Pacific).
function fmtSub(start: number, end: number): string {
  const opt: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  const s = new Date(start).toLocaleDateString('en-US', opt);
  const e = new Date(end).toLocaleDateString('en-US', { ...opt, year: 'numeric' });
  return `${s} – ${e}`;
}

/**
 * Resolve a preset to a UTC-aligned [start, end] window.
 *
 * Accounting periods are keyed by UTC month (getPeriodKey) and invoices are
 * anchored to their service date's UTC month, so the range MUST use UTC month
 * boundaries — otherwise a local end-of-month (e.g. Jun 30 23:59 Pacific =
 * Jul 1 UTC) spills the next month into the filter.
 */
export function resolveRange(preset: RangePresetId, custom: CustomRange): ResolvedRange {
  const now = new Date();
  const nowMs = now.getTime();
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();

  if (preset === 'custom' && custom.from && custom.to) {
    // Interpret the picked calendar days as UTC (matching period bucketing).
    const start = Date.parse(`${custom.from}T00:00:00.000Z`);
    const end = Date.parse(`${custom.to}T23:59:59.999Z`);
    return { start, end, label: 'Custom range', sub: fmtSub(start, end), preset: 'custom' };
  }

  switch (preset) {
    case 'this-month': {
      // Full current month (Jul 1 – Jul 31), not just up to today — future days
      // have no data, so numbers are unchanged; the label reads as a real month.
      const start = Date.UTC(y, mo, 1);
      const end = Date.UTC(y, mo + 1, 1) - 1;
      return { start, end, label: 'This month', sub: fmtSub(start, end), preset };
    }
    case 'last-month': {
      const start = Date.UTC(y, mo - 1, 1);
      const end = Date.UTC(y, mo, 1) - 1; // last ms of the previous UTC month
      return { start, end, label: 'Last month', sub: fmtSub(start, end), preset };
    }
    case 'ytd': {
      // "To date" by definition — Jan 1 through today.
      const start = Date.UTC(y, 0, 1);
      return { start, end: nowMs, label: 'Year to date', sub: fmtSub(start, nowMs), preset };
    }
    case 'this-quarter':
    default: {
      // Full current quarter (e.g. Q3 = Jul 1 – Sep 30), not just up to today.
      const q = Math.floor(mo / 3) * 3;
      const start = Date.UTC(y, q, 1);
      const end = Date.UTC(y, q + 3, 1) - 1;
      return { start, end, label: 'This quarter', sub: fmtSub(start, end), preset: 'this-quarter' };
    }
  }
}

// ── Drill slide-over content ─────────────────────────────────────────────
export interface DrillMetric {
  label: string;
  value: ReactNode;
  tone?: string; // css color
}

export interface DrillContent {
  icon?: IconName;
  title: string;
  subtitle?: string;
  metrics?: DrillMetric[];
  body?: ReactNode;
  footLabel?: string;
  footAction?: { label: string; icon?: IconName; onClick?: () => void };
}
