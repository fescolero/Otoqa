import { NextResponse } from 'next/server';
import { getTeamContext, isTeamContextError, requireTeamManage } from '@/lib/team-server';

/**
 * Membership actions. Every action first proves the membership belongs to
 * the caller's org — membership IDs are global, so an unchecked ID would
 * let a caller reach into another workspace.
 *
 *   PATCH  { roleSlug }                           — change role
 *   POST   { action: 'deactivate'|'reactivate' }  — status flip
 *   DELETE                                        — remove from workspace
 */

async function resolveMembership(membershipId: string) {
  const ctx = await getTeamContext();
  if (isTeamContextError(ctx)) return { failure: NextResponse.json({ error: ctx.error }, { status: ctx.status }) };
  const denied = await requireTeamManage(ctx);
  if (denied) return { failure: NextResponse.json({ error: denied.error }, { status: denied.status }) };
  const membership = await ctx.workos.userManagement.getOrganizationMembership(membershipId);
  if (membership.organizationId !== ctx.organizationId) {
    return { failure: NextResponse.json({ error: 'Membership not found' }, { status: 404 }) };
  }
  return { ctx, membership };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ membershipId: string }> },
) {
  try {
    const { membershipId } = await params;
    const resolved = await resolveMembership(membershipId);
    if ('failure' in resolved) return resolved.failure;

    const { roleSlug } = (await request.json()) as { roleSlug?: string };
    if (!roleSlug || typeof roleSlug !== 'string') {
      return NextResponse.json({ error: 'roleSlug is required' }, { status: 400 });
    }

    const updated = await resolved.ctx.workos.userManagement.updateOrganizationMembership(
      membershipId,
      { roleSlug },
    );
    return NextResponse.json({ ok: true, roleSlug: updated.role?.slug ?? roleSlug });
  } catch (error) {
    console.error('PATCH /api/team/members/[id] failed:', error);
    return NextResponse.json({ error: 'Failed to change role' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ membershipId: string }> },
) {
  try {
    const { membershipId } = await params;
    const resolved = await resolveMembership(membershipId);
    if ('failure' in resolved) return resolved.failure;
    const { ctx, membership } = resolved;

    const { action } = (await request.json()) as { action?: string };
    if (action !== 'deactivate' && action !== 'reactivate') {
      return NextResponse.json({ error: 'action must be deactivate or reactivate' }, { status: 400 });
    }
    if (action === 'deactivate' && membership.userId === ctx.userId) {
      return NextResponse.json({ error: 'You cannot deactivate your own account' }, { status: 400 });
    }

    if (action === 'deactivate') {
      await ctx.workos.userManagement.deactivateOrganizationMembership(membershipId);
    } else {
      await ctx.workos.userManagement.reactivateOrganizationMembership(membershipId);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('POST /api/team/members/[id] failed:', error);
    return NextResponse.json({ error: 'Failed to update member status' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ membershipId: string }> },
) {
  try {
    const { membershipId } = await params;
    const resolved = await resolveMembership(membershipId);
    if ('failure' in resolved) return resolved.failure;
    const { ctx, membership } = resolved;

    if (membership.userId === ctx.userId) {
      return NextResponse.json({ error: 'You cannot remove your own account' }, { status: 400 });
    }

    await ctx.workos.userManagement.deleteOrganizationMembership(membershipId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('DELETE /api/team/members/[id] failed:', error);
    return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 });
  }
}
