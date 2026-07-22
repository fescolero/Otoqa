import { describe, expect, it } from 'vitest';
import {
  PERM_AREAS,
  PRESET_ROLES,
  allPermissionSlugs,
  levelForArea,
  matrixFromPermissions,
  permissionName,
  permissionsForLevel,
  permissionsFromMatrix,
} from '../team-rbac';

describe('permission catalog', () => {
  it('is 3 slugs per area', () => {
    const slugs = allPermissionSlugs();
    expect(slugs).toHaveLength(PERM_AREAS.length * 3);
    expect(slugs).toContain('loads:view');
    expect(slugs).toContain('team:manage');
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('names slugs readably', () => {
    expect(permissionName('loads:edit')).toBe('Loads & dispatch — Edit');
    expect(permissionName('unknown:thing')).toBe('unknown:thing');
  });
});

describe('cumulative levels', () => {
  it('stores lower levels alongside higher ones', () => {
    expect(permissionsForLevel('loads', 'none')).toEqual([]);
    expect(permissionsForLevel('loads', 'view')).toEqual(['loads:view']);
    expect(permissionsForLevel('loads', 'edit')).toEqual(['loads:view', 'loads:edit']);
    expect(permissionsForLevel('loads', 'manage')).toEqual([
      'loads:view',
      'loads:edit',
      'loads:manage',
    ]);
  });

  it('reads the highest slug as the level', () => {
    expect(levelForArea(['loads:view', 'loads:edit'], 'loads')).toBe('edit');
    expect(levelForArea(['loads:manage'], 'loads')).toBe('manage');
    expect(levelForArea([], 'loads')).toBe('none');
  });

  it('round-trips matrix → permissions → matrix', () => {
    for (const preset of PRESET_ROLES) {
      const permissions = permissionsFromMatrix(preset.matrix);
      expect(matrixFromPermissions(permissions)).toEqual(preset.matrix);
    }
  });
});

describe('preset roles', () => {
  it('admin manages everything; nobody but admin touches team settings', () => {
    const admin = PRESET_ROLES.find((r) => r.slug === 'admin')!;
    expect(Object.values(admin.matrix).every((l) => l === 'manage')).toBe(true);
    for (const r of PRESET_ROLES.filter((r) => r.slug !== 'admin')) {
      expect(r.matrix.team).toBe('none');
      expect(r.matrix.settings).toBe('none');
    }
  });

  it('only uses catalog areas', () => {
    const areaIds = new Set(PERM_AREAS.map((a) => a.id));
    for (const r of PRESET_ROLES) {
      for (const key of Object.keys(r.matrix)) expect(areaIds.has(key)).toBe(true);
    }
  });
});
