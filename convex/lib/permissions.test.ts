import { describe, expect, it } from 'vitest';
import { isPermitted, permissionSlug } from './permissions';

describe('isPermitted', () => {
  it('grants admins everything regardless of claims', () => {
    expect(isPermitted({ role: 'admin', permissions: [] }, 'loads:manage')).toBe(true);
    expect(isPermitted({ roles: ['billing', 'admin'], permissions: [] }, 'team:manage')).toBe(true);
  });

  it('grandfathers tokens with no permissions claim (pre-RBAC sessions)', () => {
    expect(isPermitted({ role: 'member' }, 'loads:edit')).toBe(true);
    expect(isPermitted({}, 'settings:manage')).toBe(true);
  });

  it('enforces strictly once a permissions claim is present', () => {
    const claims = { role: 'dispatcher', permissions: ['loads:view', 'loads:edit'] };
    expect(isPermitted(claims, 'loads:edit')).toBe(true);
    expect(isPermitted(claims, 'loads:manage')).toBe(false);
    expect(isPermitted(claims, 'team:manage')).toBe(false);
    expect(isPermitted({ role: 'member', permissions: [] }, 'loads:view')).toBe(false);
  });

  it('builds area:level slugs', () => {
    expect(permissionSlug('accounting', 'edit')).toBe('accounting:edit');
  });
});
