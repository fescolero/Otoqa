import { describe, expect, it } from 'vitest';
import { NAV, deriveBreadcrumb, findActive } from '../nav';

describe('NAV', () => {
  it('starts with Dashboard and exposes the sections we expect', () => {
    expect(NAV.map((s) => s.id)).toEqual([
      'dashboard',
      'fleet',
      'operations',
      'load-ops',
      'lane-analyzer',
      'accounting',
      'settings',
    ]);
  });

  it('includes Schedule under Load Operations between Planner and Sessions', () => {
    const loadOps = NAV.find((s) => s.id === 'load-ops');
    expect(loadOps?.items?.map((i) => i.id)).toEqual([
      'loads',
      'planner',
      'schedule',
      'sessions',
    ]);
    const schedule = loadOps?.items?.find((i) => i.id === 'schedule');
    expect(schedule?.href).toBe('/dispatch/schedule');
  });
});

describe('deriveBreadcrumb()', () => {
  it('returns ["Dashboard"] for unknown paths', () => {
    expect(deriveBreadcrumb('/totally-unknown')).toEqual(['Dashboard']);
  });

  it('returns just ["Dashboard"] for the dashboard route', () => {
    expect(deriveBreadcrumb('/dashboard')).toEqual(['Dashboard']);
  });

  it('returns Dashboard › Section › Item for nested routes', () => {
    expect(deriveBreadcrumb('/fleet/drivers')).toEqual([
      'Dashboard',
      'Fleet Management',
      'Drivers',
    ]);
  });

  it('matches descendants of an item href', () => {
    expect(deriveBreadcrumb('/fleet/drivers/abc123')).toEqual([
      'Dashboard',
      'Fleet Management',
      'Drivers',
    ]);
  });

  it('matches descendants of a section href when there are no items', () => {
    expect(deriveBreadcrumb('/lane-analyzer/abc')).toEqual([
      'Dashboard',
      'Lane Analyzer',
    ]);
  });
});

describe('findActive()', () => {
  it('returns the section when the path matches a section href', () => {
    const r = findActive('/dashboard');
    expect(r.section?.id).toBe('dashboard');
    expect(r.item).toBeUndefined();
  });

  it('returns both section + item for a nested route', () => {
    const r = findActive('/loads');
    expect(r.section?.id).toBe('load-ops');
    expect(r.item?.id).toBe('loads');
  });

  it('returns nothing for an unknown path', () => {
    expect(findActive('/totally-unknown')).toEqual({});
  });
});
