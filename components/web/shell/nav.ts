/**
 * NAV — single source of truth for the app shell navigation.
 *
 * Consumed by the Sidebar (rendering), Topbar (breadcrumb derivation), and
 * CommandPalette (jump-to actions). Keeping it in one place means a new
 * route only needs to be added here, not in three places.
 */

import type { IconName } from '@/components/web';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  /** Optional shortcut hint shown in the command palette. */
  kbd?: string;
}

export interface NavSection {
  id: string;
  label: string;
  /** Top-level icon shown in rail and pinned modes. */
  icon: IconName;
  /** Top-level destination if this section has no children. */
  href?: string;
  items?: NavItem[];
}

export const NAV: NavSection[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: 'home',
    href: '/dashboard',
  },
  {
    id: 'fleet',
    label: 'Fleet Management',
    icon: 'truck',
    items: [
      { id: 'drivers',  label: 'Drivers',  href: '/fleet/drivers' },
      { id: 'trucks',   label: 'Trucks',   href: '/fleet/trucks' },
      { id: 'trailers', label: 'Trailers', href: '/fleet/trailers' },
    ],
  },
  {
    id: 'operations',
    label: 'Company Operations',
    icon: 'building',
    items: [
      { id: 'carriers',     label: 'Carriers',     href: '/operations/carriers' },
      { id: 'customers',    label: 'Customers',    href: '/operations/customers' },
      { id: 'compliance',   label: 'Compliance',   href: '/operations/compliance' },
      { id: 'diesel',       label: 'Diesel',       href: '/operations/diesel' },
      { id: 'fuel-vendors', label: 'Fuel Vendors', href: '/operations/diesel/vendors' },
      { id: 'fuel-reports', label: 'Fuel Reports', href: '/operations/diesel/reports' },
    ],
  },
  {
    id: 'load-ops',
    label: 'Load Operations',
    icon: 'package',
    items: [
      { id: 'loads',    label: 'Loads',                  href: '/loads' },
      { id: 'planner',  label: 'Dispatch Planner',       href: '/dispatch/planner' },
      { id: 'schedule', label: 'Schedule',               href: '/dispatch/schedule' },
      { id: 'sessions', label: 'Active sessions',         href: '/dispatch/sessions' },
    ],
  },
  {
    id: 'lane-analyzer',
    label: 'Lane Analyzer',
    icon: 'chart-bar',
    href: '/lane-analyzer',
  },
  {
    id: 'accounting',
    label: 'Accounting',
    icon: 'calculator',
    items: [
      { id: 'invoices',            label: 'Invoices',            href: '/invoices' },
      { id: 'driver-settlements',  label: 'Driver Settlements',  href: '/accounting/driver-settlements' },
      { id: 'carrier-settlements', label: 'Carrier Settlements', href: '/accounting/carrier-settlements' },
      { id: 'reports',             label: 'Reports',             href: '/accounting/reports' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'settings',
    items: [
      { id: 'general',      label: 'General',         href: '/settings/general' },
      { id: 'team',         label: 'Team & roles',    href: '/settings/team' },
      { id: 'pay-profiles', label: 'Pay profiles',    href: '/org-settings/pay-profiles' },
      { id: 'integrations', label: 'Integrations',    href: '/settings/integrations' },
      { id: 'billing',      label: 'Billing & usage', href: '/settings/billing' },
    ],
  },
];

/** Resolve the breadcrumb trail for a given pathname. Uses the same
 *  longest-match logic as `findActive` so a deeply-nested route
 *  (`/operations/diesel/vendors/<id>`) breadcrumbs to
 *  `Dashboard › Company Operations › Fuel Vendors`, not Diesel. */
export function deriveBreadcrumb(pathname: string): string[] {
  const trail: string[] = ['Dashboard'];
  const { section, item } = findActive(pathname);
  if (!section) return trail;
  if (section.id !== 'dashboard') trail.push(section.label);
  if (item) trail.push(item.label);
  return trail;
}

/** Find the active (section, item) pair for a pathname.
 *  Prefers the LONGEST matching href so nested routes like
 *  `/operations/diesel/vendors` highlight `Fuel Vendors` instead of the
 *  shorter `/operations/diesel` (Diesel) prefix sibling. */
export function findActive(pathname: string): { section?: NavSection; item?: NavItem } {
  let best: { section?: NavSection; item?: NavItem; len: number } = { len: -1 };
  const consider = (sec: NavSection, item: NavItem | undefined, href: string) => {
    if (pathname !== href && !pathname.startsWith(href + '/')) return;
    if (href.length > best.len) best = { section: sec, item, len: href.length };
  };
  for (const sec of NAV) {
    if (sec.href) consider(sec, undefined, sec.href);
    if (sec.items) {
      for (const item of sec.items) consider(sec, item, item.href);
    }
  }
  return { section: best.section, item: best.item };
}
