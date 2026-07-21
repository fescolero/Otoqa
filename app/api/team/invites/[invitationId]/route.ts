import { NextResponse } from 'next/server';
import { getTeamContext, isTeamContextError } from '@/lib/team-server';

/**
 * POST /api/team/invites/[invitationId] — { action: 'resend' | 'revoke' }.
 * The invitation is verified to belong to the caller's org first.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ invitationId: string }> },
) {
  try {
    const ctx = await getTeamContext();
    if (isTeamContextError(ctx)) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }
    const { workos, organizationId } = ctx;
    const { invitationId } = await params;

    const invitation = await workos.userManagement.getInvitation(invitationId);
    if (invitation.organizationId !== organizationId) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    const { action } = (await request.json()) as { action?: string };
    if (action === 'resend') {
      await workos.userManagement.resendInvitation(invitationId);
    } else if (action === 'revoke') {
      await workos.userManagement.revokeInvitation(invitationId);
    } else {
      return NextResponse.json({ error: 'action must be resend or revoke' }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('POST /api/team/invites/[id] failed:', error);
    return NextResponse.json({ error: 'Failed to update invitation' }, { status: 500 });
  }
}
