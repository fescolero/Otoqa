import { NextResponse } from 'next/server';
import { getTeamContext, isTeamContextError } from '@/lib/team-server';
import {
  allPermissionSlugs,
  permissionName,
  permissionsFromMatrix,
  PRESET_ROLES,
} from '@/lib/team-rbac';

/**
 * POST /api/team/roles/seed — idempotently create the permission catalog
 * (24 area×level slugs) and the preset environment roles in WorkOS.
 *
 * Safe to call repeatedly: existing permissions are left alone, existing
 * roles are only touched when they carry no permissions yet (so a role an
 * admin has customized in the WorkOS dashboard is never overwritten).
 * Environment-level state is shared across orgs, hence seeded once here
 * rather than per organization.
 */
export async function POST() {
  try {
    const ctx = await getTeamContext();
    if (isTeamContextError(ctx)) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }
    const { workos } = ctx;

    // 1. Permission catalog.
    const existing = await workos.authorization.listPermissions();
    const have = new Set((existing.data ?? []).map((p) => p.slug));
    let createdPermissions = 0;
    for (const slug of allPermissionSlugs()) {
      if (have.has(slug)) continue;
      await workos.authorization.createPermission({ slug, name: permissionName(slug) });
      createdPermissions++;
    }

    // 2. Preset environment roles.
    const envRoles = await workos.authorization.listEnvironmentRoles();
    const bySlug = new Map((envRoles.data ?? []).map((r) => [r.slug, r]));
    let createdRoles = 0;
    let populatedRoles = 0;
    for (const preset of PRESET_ROLES) {
      const current = bySlug.get(preset.slug);
      if (!current) {
        await workos.authorization.createEnvironmentRole({
          slug: preset.slug,
          name: preset.name,
          description: preset.description,
        });
        await workos.authorization.setEnvironmentRolePermissions(preset.slug, {
          permissions: permissionsFromMatrix(preset.matrix),
        });
        createdRoles++;
      } else if ((current.permissions ?? []).length === 0) {
        await workos.authorization.setEnvironmentRolePermissions(preset.slug, {
          permissions: permissionsFromMatrix(preset.matrix),
        });
        populatedRoles++;
      }
    }

    return NextResponse.json({ ok: true, createdPermissions, createdRoles, populatedRoles });
  } catch (error) {
    console.error('POST /api/team/roles/seed failed:', error);
    const message = error instanceof Error ? error.message : 'Failed to seed roles';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
