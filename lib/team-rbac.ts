/**
 * The Otoqa permission model over WorkOS RBAC.
 *
 * Eight workspace areas × four levels (none / view / edit / manage) map onto
 * flat WorkOS permission slugs — `loads:view`, `loads:edit`, `loads:manage`,
 * … Levels are CUMULATIVE in storage: a role at "edit" holds both
 * `area:view` and `area:edit`, so an enforcement check is always a single
 * `permissions.includes('area:level')` regardless of the role's exact level.
 *
 * The catalog (24 permissions) and the preset roles are seeded into WorkOS
 * by POST /api/team/roles/seed; this module is the single source of truth
 * for both sides — seeding, the role editor, and (later) enforcement.
 */

export type PermLevel = 'none' | 'view' | 'edit' | 'manage';

export const PERM_LEVELS: Array<{ value: PermLevel; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'view', label: 'View' },
  { value: 'edit', label: 'Edit' },
  { value: 'manage', label: 'Manage' },
];

export const PERM_LEVEL_RANK: Record<PermLevel, number> = {
  none: 0,
  view: 1,
  edit: 2,
  manage: 3,
};

export interface PermArea {
  id: string;
  label: string;
  icon: string;
  hint: string;
}

export const PERM_AREAS: PermArea[] = [
  { id: 'loads',      label: 'Loads & dispatch',     icon: 'package',    hint: 'Create loads, assign drivers, work the board.' },
  { id: 'fleet',      label: 'Fleet',                icon: 'truck',      hint: 'Drivers, trucks, and trailers.' },
  { id: 'partners',   label: 'Carriers & customers', icon: 'handshake',  hint: 'Partner records, contracts, and contacts.' },
  { id: 'accounting', label: 'Accounting',           icon: 'doc-dollar', hint: 'Invoices, settlements, and pay.' },
  { id: 'fuel',       label: 'Fuel & diesel',        icon: 'fuel',       hint: 'Fill-ups, fuel cards, and IFTA.' },
  { id: 'reports',    label: 'Reports & analytics',  icon: 'chart-bar',  hint: 'Dashboards and exports.' },
  { id: 'settings',   label: 'Workspace settings',   icon: 'gauge',      hint: 'Company profile, formats, integrations.' },
  { id: 'team',       label: 'Team & roles',         icon: 'users',      hint: 'Invite people and edit roles.' },
];

export type PermMatrix = Record<string, PermLevel>;

/** All 24 catalog permission slugs. */
export function allPermissionSlugs(): string[] {
  return PERM_AREAS.flatMap((a) => [`${a.id}:view`, `${a.id}:edit`, `${a.id}:manage`]);
}

/** Human name for one permission slug — "loads:edit" → "Loads & dispatch — Edit". */
export function permissionName(slug: string): string {
  const [areaId, level] = slug.split(':');
  const area = PERM_AREAS.find((a) => a.id === areaId);
  const lvl = PERM_LEVELS.find((l) => l.value === level);
  return area && lvl ? `${area.label} — ${lvl.label}` : slug;
}

/** Cumulative slugs for one area at a level ("edit" → view + edit). */
export function permissionsForLevel(areaId: string, level: PermLevel): string[] {
  const rank = PERM_LEVEL_RANK[level];
  const out: string[] = [];
  if (rank >= 1) out.push(`${areaId}:view`);
  if (rank >= 2) out.push(`${areaId}:edit`);
  if (rank >= 3) out.push(`${areaId}:manage`);
  return out;
}

/** The level a permission set grants for one area (highest slug wins). */
export function levelForArea(permissions: string[], areaId: string): PermLevel {
  if (permissions.includes(`${areaId}:manage`)) return 'manage';
  if (permissions.includes(`${areaId}:edit`)) return 'edit';
  if (permissions.includes(`${areaId}:view`)) return 'view';
  return 'none';
}

/** Permission list → per-area matrix. */
export function matrixFromPermissions(permissions: string[]): PermMatrix {
  const matrix: PermMatrix = {};
  for (const a of PERM_AREAS) matrix[a.id] = levelForArea(permissions, a.id);
  return matrix;
}

/** Per-area matrix → cumulative permission list (catalog slugs only). */
export function permissionsFromMatrix(matrix: PermMatrix): string[] {
  return PERM_AREAS.flatMap((a) => permissionsForLevel(a.id, matrix[a.id] ?? 'none'));
}

// ─── Preset roles (design: settings-team.jsx) ─────────────────────────────
// Seeded as WorkOS ENVIRONMENT roles — shared by every org, read-only in
// the app ("System"); orgs customize by duplicating into org-scoped roles.

export interface PresetRole {
  slug: string;
  name: string;
  description: string;
  matrix: PermMatrix;
}

export const PRESET_ROLES: PresetRole[] = [
  {
    slug: 'admin',
    name: 'Admin',
    description: 'Full run of the workspace short of transferring ownership.',
    matrix: { loads: 'manage', fleet: 'manage', partners: 'manage', accounting: 'manage', fuel: 'manage', reports: 'manage', settings: 'manage', team: 'manage' },
  },
  {
    slug: 'dispatcher',
    name: 'Dispatcher',
    description: 'Plans loads, assigns drivers, and runs the daily board.',
    matrix: { loads: 'manage', fleet: 'edit', partners: 'edit', accounting: 'view', fuel: 'view', reports: 'view', settings: 'none', team: 'none' },
  },
  {
    slug: 'billing',
    name: 'Accountant / Billing',
    description: 'Owns invoices, settlements, and financial reporting.',
    matrix: { loads: 'view', fleet: 'view', partners: 'edit', accounting: 'manage', fuel: 'edit', reports: 'manage', settings: 'none', team: 'none' },
  },
  {
    slug: 'safety',
    name: 'Safety / Compliance',
    description: 'Driver qualification, documents, and incident records.',
    matrix: { loads: 'view', fleet: 'manage', partners: 'view', accounting: 'none', fuel: 'view', reports: 'view', settings: 'none', team: 'none' },
  },
];
