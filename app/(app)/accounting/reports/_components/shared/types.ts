import { startOfMonth, endOfMonth, subMonths, startOfYear, subQuarters, startOfQuarter, endOfQuarter } from 'date-fns';

// ============================================
// DATE RANGE
// ============================================

export type DatePreset = 'this-month' | 'last-month' | 'this-quarter' | 'last-quarter' | 'ytd' | 'custom';

export interface DateRange {
  start: number;
  end: number;
}

export const DATE_PRESETS: { label: string; value: DatePreset }[] = [
  { label: 'This Month', value: 'this-month' },
  { label: 'Last Month', value: 'last-month' },
  { label: 'This Quarter', value: 'this-quarter' },
  { label: 'Last Quarter', value: 'last-quarter' },
  { label: 'YTD', value: 'ytd' },
  { label: 'Range', value: 'custom' },
];

export function getDateRange(preset: DatePreset, customStart?: Date, customEnd?: Date): DateRange {
  const now = new Date();
  switch (preset) {
    case 'this-month':
      return { start: startOfMonth(now).getTime(), end: now.getTime() };
    case 'last-month': {
      const last = subMonths(now, 1);
      return { start: startOfMonth(last).getTime(), end: endOfMonth(last).getTime() };
    }
    case 'this-quarter':
      return { start: startOfQuarter(now).getTime(), end: now.getTime() };
    case 'last-quarter': {
      const lq = subQuarters(now, 1);
      return { start: startOfQuarter(lq).getTime(), end: endOfQuarter(lq).getTime() };
    }
    case 'ytd':
      return { start: startOfYear(now).getTime(), end: now.getTime() };
    case 'custom':
      return {
        start: customStart?.getTime() ?? startOfMonth(now).getTime(),
        end: customEnd?.getTime() ?? now.getTime(),
      };
    default:
      return { start: startOfMonth(now).getTime(), end: now.getTime() };
  }
}

// ============================================
// TABLE
// ============================================

export type TableDensity = 'compact' | 'normal';

export interface QuickFilter {
  label: string;
  value: string;
}

// ============================================
// TAB PROPS
// ============================================

export interface TabComponentProps {
  organizationId: string;
  dateRange: DateRange;
  searchQuery: string;
}
