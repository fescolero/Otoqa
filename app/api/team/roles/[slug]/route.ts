import { NextResponse } from 'next/server';
import { getTeamContext, isTeamContextError } from '@/lib/team-server';
import { allPermissionSlugs, permissionsFromMatrix, type PermMatrix } from '@/lib/team-rbac';

/**
 * Org custom-role actions. Environment ("System") roles are read-only from
 * the app — the editor offers Duplicate instead.
 *
 *   PATCH  { name?, description?, matrix? | permissions? } — update
 *   DELETE                                                 — remove (refused
 *          while members still hold the role)
 */

async function resolveOrgRole(slug: string) {
  const ctx = await getTeamContext();
  if (isTeamContextError(ctx)) {
    return { failure: NextResponse.json({ error: ctx.error }, { status: ctx.status }) };
  }
  try {
    const role = await ctx.workos.authorization.getOrganizationRole(ctx.organizationId, slug);
    if (role.type !== 'OrganizationRole') {
      return {
        failure: NextResponse.json(
          { error: 'System roles are read-only — duplicate the role to customize it' },
          { status: 403 },
        ),
      };
    }
    return { ctx, role };
  } catch {
    return { failure: NextResponse.json({ error: 'Role not found' }, { status: 404 }) };
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const resolved = await resolveOrgRole(slug);
    if ('failure' in resolved) return resolved.failure;
    const { ctx } = resolved;

    const body = (await request.json()) as {
      name?: string;
      description?: string | null;
      matrix?: PermMatrix;
      permissions?: string[];
    };

    if (body.name !== undefined || body.description !== undefined) {
      await ctx.workos.authorization.updateOrganizationRole(ctx.organizationId, slug, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      });
    }

    if (body.matrix !== undefined || body.permissions !== undefined) {
      const catalog = new Set(allPermissionSlugs());
      const permissions = body.matrix
        ? permissionsFromMatrix(body.matrix)
        : (body.permissions ?? []).filter((p) => catalog.has(p));
      await ctx.workos.authorization.setOrganizationRolePermissions(ctx.organizationId, slug, {
        permissions,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('PATCH /api/team/roles/[slug] failed:', error);
    return NextResponse.json({ error: 'Failed to update role' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const resolved = await resolveOrgRole(slug);
    if ('failure' in resolved) return resolved.failure;
    const { ctx } = resolved;

    // Refuse while anyone still holds the role — deleting from under a
    // member would silently strip their access.
    let after: string | undefined;
    do {
      const page = await ctx.workos.userManagement.listOrganizationMemberships({
        organizationId: ctx.organizationId,
        statuses: ['active', 'inactive'],
        limit: 100,
        after,
      });
      if (page.data.some((m) => m.role?.slug === slug)) {
        return NextResponse.json(
          { error: 'Reassign the members holding this role before deleting it' },
          { status: 409 },
        );
      }
      after = page.listMetadata?.after ?? undefined;
    } while (after);

    await ctx.workos.authorization.deleteOrganizationRole(ctx.organizationId, slug);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('DELETE /api/team/roles/[slug] failed:', error);
    return NextResponse.json({ error: 'Failed to delete role' }, { status: 500 });
  }
}
