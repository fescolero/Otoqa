/**
 * Org-wide regional formatting — the runtime behind the "Regional & formats"
 * card on Settings → General.
 *
 * The app shell subscribes to the org's settings and pushes them here via
 * `setOrgFormatPrefs` (see components/web/shell/app-shell.tsx). The shared
 * formatters in `lib/utils/format.ts` delegate to these functions, so every
 * call site using them respects the workspace preferences automatically.
 *
 * Implementation note: this is a module-level store, not React state. Prefs
 * change rarely (only on the settings page, which re-renders through its own
 * live query); the trade-off buys us pref-aware formatting everywhere without
 * threading a context through hundreds of call sites. Server-side rendering
 * simply uses the defaults — the client re-renders with prefs applied.
 */

export interface OrgFormatPrefs {
  /** "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD" */
  dateFormat: string;
  /** "1,234.56" | "1.234,56" | "1 234.56" */
  numberFormat: string;
  /** "mi" | "km" — stored distances are miles; km display converts. */
  distanceUnit: string;
  /** "sunday" | "monday" */
  weekStart: string;
  /** ISO 4217 — used as the default currency for money formatting. */
  currency: string;
}

export const ORG_FORMAT_DEFAULTS: OrgFormatPrefs = {
  dateFormat: 'MM/DD/YYYY',
  numberFormat: '1,234.56',
  distanceUnit: 'mi',
  weekStart: 'monday',
  currency: 'USD',
};

let prefs: OrgFormatPrefs = ORG_FORMAT_DEFAULTS;

export function setOrgFormatPrefs(next: Partial<OrgFormatPrefs>): void {
  prefs = {
    ...ORG_FORMAT_DEFAULTS,
    ...Object.fromEntries(Object.entries(next).filter(([, v]) => v != null && v !== '')),
  };
}

export function getOrgFormatPrefs(): OrgFormatPrefs {
  return prefs;
}

// ─── Numbers ──────────────────────────────────────────────────────────────

/**
 * Rewrites an en-US formatted number ("1,234.56") into the workspace's
 * separator convention. Pattern-based rather than Intl-locale-based because
 * "1 234.56" (space groups, dot decimal) matches no standard locale.
 */
function applyNumberPattern(enUs: string): string {
  switch (prefs.numberFormat) {
    case '1.234,56':
      return enUs.replace(/[.,]/g, (c) => (c === ',' ? '.' : ','));
    case '1 234.56':
      return enUs.replace(/,/g, ' ');
    default:
      return enUs;
  }
}

export function orgFormatNumber(n: number, decimals = 0): string {
  return applyNumberPattern(
    new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(n),
  );
}

export function orgFormatCurrency(amount: number, currency?: string): string {
  return applyNumberPattern(
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency ?? prefs.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount),
  );
}

// ─── Distance ─────────────────────────────────────────────────────────────

const KM_PER_MILE = 1.60934;

/** Miles in, workspace units out — "128 mi" or "206 km". */
export function orgFormatDistance(miles: number, decimals = 0): string {
  const km = prefs.distanceUnit === 'km';
  const value = km ? miles * KM_PER_MILE : miles;
  return `${orgFormatNumber(value, decimals)} ${km ? 'km' : 'mi'}`;
}

// ─── Dates ────────────────────────────────────────────────────────────────

/**
 * Format a date per the workspace date-format preference.
 *
 * The default (MM/DD/YYYY) keeps the app's existing pretty US style
 * ("Jul 15, 2026" / "Jul 15") so nothing regresses out of the box; the
 * explicit numeric preferences render literally.
 */
export function orgFormatDate(
  input: number | Date,
  style: 'long' | 'short' = 'long',
): string {
  const d = input instanceof Date ? input : new Date(input);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');

  switch (prefs.dateFormat) {
    case 'DD/MM/YYYY':
      return style === 'short' ? `${dd}/${mm}` : `${dd}/${mm}/${yyyy}`;
    case 'YYYY-MM-DD':
      return style === 'short' ? `${mm}-${dd}` : `${yyyy}-${mm}-${dd}`;
    default:
      return d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        ...(style === 'long' ? { year: 'numeric' } : {}),
      });
  }
}

/** date-fns pattern for the workspace date format (calendar editors). */
export function orgDateFnsFormat(): string {
  switch (prefs.dateFormat) {
    case 'DD/MM/YYYY':
      return 'dd/MM/yyyy';
    case 'YYYY-MM-DD':
      return 'yyyy-MM-dd';
    default:
      return 'MMM d, yyyy';
  }
}

// ─── Calendar ─────────────────────────────────────────────────────────────

/** react-day-picker `weekStartsOn` for the workspace preference. */
export function orgWeekStartsOn(): 0 | 1 {
  return prefs.weekStart === 'sunday' ? 0 : 1;
}
