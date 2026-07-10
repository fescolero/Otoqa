// Shared semantic colors + compact formatters for the Reports views, matching
// the design mock's palette so charts/KPIs read consistently in both themes.

export const AC_POS = '#0F8C5F'; // credit / good / paid
export const AC_NEG = '#C33C3C'; // overdue / loss
export const AC_WARN = '#A66800'; // attention

/** Compact whole-dollar money, e.g. $386,000 / −$4,100. */
export const acMoney = (n: number): string =>
  (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString();

/**
 * Exact money with cents, e.g. $204.87 / −$1.06. Use in reconciliation tables
 * where the amount columns must tie out with the % column — whole-dollar
 * rounding makes a $56.77→$57.83 (1.9%) row look like $57→$58 (1.75%).
 */
export const acMoneyCents = (n: number): string =>
  (n < 0 ? '−$' : '$') +
  Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Abbreviated money for tight spots, e.g. $386K / $1.2K. */
export const acK = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1000) return (n < 0 ? '−$' : '$') + (a / 1000).toFixed(a >= 100000 ? 0 : 1) + 'K';
  return (n < 0 ? '−$' : '$') + Math.round(a);
};

/** Percent from a fraction (0.152 → "15.2%"). */
export const acPctFrac = (n: number, d = 1): string => (n * 100).toFixed(d) + '%';

/** Percent from an already-scaled number (15.2 → "15.2%"). */
export const acPct = (n: number, d = 1): string => n.toFixed(d) + '%';
