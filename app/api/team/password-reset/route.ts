import { NextResponse } from 'next/server';
import { getTeamContext, isTeamContextError, requireTeamManage } from '@/lib/team-server';

/**
 * POST /api/team/password-reset — { email } → { url }.
 *
 * Creates a WorkOS password-reset token for a member of the caller's org
 * and returns the reset URL for the admin to hand to the member (WorkOS
 * does not send an email for API-created resets). The email must belong
 * to a current member of the org.
 */
export async function POST(request: Request) {
  try {
    const ctx = await getTeamContext();
    if (isTeamContextError(ctx)) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }
    const denied = await requireTeamManage(ctx);
    if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
    const { workos, organizationId } = ctx;

    const { email } = (await request.json()) as { email?: string };
    if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });

    // Membership check — resets may only be minted for this org's members.
    const users = await workos.userManagement.listUsers({ organizationId, email, limit: 1 });
    if (users.data.length === 0) {
      return NextResponse.json({ error: 'No member with that email' }, { status: 404 });
    }

    const reset = await workos.userManagement.createPasswordReset({ email });
    return NextResponse.json({ url: reset.passwordResetUrl });
  } catch (error) {
    console.error('POST /api/team/password-reset failed:', error);
    return NextResponse.json({ error: 'Failed to create password reset' }, { status: 500 });
  }
}
