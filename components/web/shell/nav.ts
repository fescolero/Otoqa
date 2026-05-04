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
      { id: 'sessions', label: 'Active Driver Sessions', href: '/dispatch/sessions' },
    ],
  },
  {
    id: 'route-assignments',
    label: 'Route Assignments',
    icon: 'route',
    href: '/route-assignments',
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
      { id: 'driver-settlements',  label: 'Driver Settlements',  href: '/settlements' },
      { id: 'carrier-settlements', label: 'Carrier Settlements', href: '/accounting/carrier-settlements' },
      { id: 'reports',             label: 'Reports',             href: '/accounting/reports' },
    ],
  },
];

/** Resolve the breadcrumb trail for a given pathname. */
export function deriveBreadcrumb(pathname: string): string[] {
  const trail: string[] = ['Dashboard'];
  // Exact match on a section href first.
  for (const sec of NAV) {
    if (sec.href === pathname) {
      if (sec.id !== 'dashboard') trail.push(sec.label);
      return trail;
    }
    if (sec.items) {
      const item = sec.items.find((i) => pathname === i.href || pathname.startsWith(i.href + '/'));
      if (item) {
        trail.push(sec.label);
        trail.push(item.label);
        return trail;
      }
    } else if (sec.href && pathname.startsWith(sec.href + '/')) {
      trail.push(sec.label);
      return trail;
    }
  }
  return trail;
}

/** Find the active (section, item) pair for a pathname. */
export function findActive(pathname: string): { section?: NavSection; item?: NavItem } {
  for (const sec of NAV) {
    if (sec.href === pathname) return { section: sec };
    if (sec.items) {
      const item = sec.items.find((i) => pathname === i.href || pathname.startsWith(i.href + '/'));
      if (item) return { section: sec, item };
    } else if (sec.href && pathname.startsWith(sec.href + '/')) {
      return { section: sec };
    }
  }
  return {};
}
