import { NextResponse } from 'next/server';
import { getTeamContext, isTeamContextError, requireTeamManage } from '@/lib/team-server';
import { parseInviteEmails } from '@/lib/team-utils';

/**
 * POST /api/team/invites — send invitations.
 * Body: { emails: string, roleSlug?: string } — emails is the raw input
 * (comma/space separated); parsing and dedupe happen server-side so the
 * client and server always agree on what was sent.
 */
export async function POST(request: Request) {
  try {
    const ctx = await getTeamContext();
    if (isTeamContextError(ctx)) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }
    const denied = await requireTeamManage(ctx);
    if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
    const { workos, organizationId, userId } = ctx;

    const body = (await request.json()) as { emails?: string; roleSlug?: string };
    const emails = parseInviteEmails(body.emails ?? '');
    if (emails.length === 0) {
      return NextResponse.json({ error: 'Enter at least one valid email address' }, { status: 400 });
    }
    if (emails.length > 25) {
      return NextResponse.json({ error: 'At most 25 invites at a time' }, { status: 400 });
    }

    const sent: string[] = [];
    const failed: Array<{ email: string; error: string }> = [];
    for (const email of emails) {
      try {
        await workos.userManagement.sendInvitation({
          email,
          organizationId,
          inviterUserId: userId,
          ...(body.roleSlug ? { roleSlug: body.roleSlug } : {}),
        });
        sent.push(email);
      } catch (error) {
        failed.push({
          email,
          error: error instanceof Error ? error.message : 'Failed to send',
        });
      }
    }

    return NextResponse.json({ sent, failed });
  } catch (error) {
    console.error('POST /api/team/invites failed:', error);
    return NextResponse.json({ error: 'Failed to send invites' }, { status: 500 });
  }
}
