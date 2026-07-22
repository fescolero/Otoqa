import { NextResponse } from 'next/server';
import { getTeamContext, isTeamContextError, listAllPermissionSlugs, requireTeamManage } from '@/lib/team-server';
import { humanizeRoleSlug } from '@/lib/team-utils';
import { allPermissionSlugs, permissionsFromMatrix, type PermMatrix } from '@/lib/team-rbac';
import type { TeamRoleDTO } from '@/lib/team-types';

/**
 * GET  /api/team/roles — role catalog (environment + org custom roles with
 *      permissions) plus seeding state: `seeded` is true when the 24-slug
 *      permission catalog exists, `rbacAvailable` false when the WorkOS
 *      authorization module can't be reached at all.
 * POST /api/team/roles — create an org custom role:
 *      { name, description?, permissions? } (permissions as catalog slugs,
 *      typically copied from the role being duplicated).
 */

export async function GET() {
  try {
    const ctx = await getTeamContext();
    if (isTeamContextError(ctx)) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }
    const { workos, organizationId } = ctx;

    let rbacAvailable = true;
    let seeded = false;
    const roles: TeamRoleDTO[] = [];

    try {
      const have = await listAllPermissionSlugs(workos);
      seeded = allPermissionSlugs().every((slug) => have.has(slug));
    } catch {
      rbacAvailable = false;
    }

    if (rbacAvailable) {
      try {
        const env = await workos.authorization.listEnvironmentRoles();
        for (const r of env.data ?? []) {
          roles.push({
            slug: r.slug,
            name: r.name || humanizeRoleSlug(r.slug),
            description: r.description ?? null,
            type: 'environment',
            permissions: r.permissions ?? [],
          });
        }
        const org = await workos.authorization.listOrganizationRoles(organizationId);
        for (const r of org.data ?? []) {
          if (roles.some((existing) => existing.slug === r.slug)) continue;
          roles.push({
            slug: r.slug,
            name: r.name || humanizeRoleSlug(r.slug),
            description: r.description ?? null,
            type: 'organization',
            permissions: r.permissions ?? [],
          });
        }
      } catch {
        rbacAvailable = false;
      }
    }

    return NextResponse.json({ roles, seeded, rbacAvailable });
  } catch (error) {
    console.error('GET /api/team/roles failed:', error);
    return NextResponse.json({ error: 'Failed to load roles' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getTeamContext();
    if (isTeamContextError(ctx)) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }
    const denied = await requireTeamManage(ctx);
    if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
    const { workos, organizationId } = ctx;

    const body = (await request.json()) as {
      name?: string;
      description?: string;
      permissions?: string[];
      matrix?: PermMatrix;
    };
    const name = body.name?.trim();
    if (!name) return NextResponse.json({ error: 'Role name is required' }, { status: 400 });

    // Slug from the name — WorkOS prefixes org roles with `org-` itself
    // when the slug is omitted, so let it mint one to avoid collisions.
    const created = await workos.authorization.createOrganizationRole(organizationId, {
      slug: `org-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'custom-role'}`,
      name,
      ...(body.description ? { description: body.description } : {}),
    });

    // Only catalog slugs are accepted — a custom role can't smuggle in
    // permissions outside the area model.
    const catalog = new Set(allPermissionSlugs());
    const permissions = body.matrix
      ? permissionsFromMatrix(body.matrix)
      : (body.permissions ?? []).filter((p) => catalog.has(p));
    if (permissions.length > 0) {
      await workos.authorization.setOrganizationRolePermissions(organizationId, created.slug, {
        permissions,
      });
    }

    return NextResponse.json({ ok: true, slug: created.slug });
  } catch (error) {
    console.error('POST /api/team/roles failed:', error);
    const message = error instanceof Error ? error.message : 'Failed to create role';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
