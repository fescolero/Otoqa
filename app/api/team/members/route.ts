import { NextResponse } from 'next/server';
import { getTeamContext, isTeamContextError } from '@/lib/team-server';
import { humanizeRoleSlug } from '@/lib/team-utils';
import type {
  PendingInviteDTO,
  TeamMemberDTO,
  TeamPayload,
  TeamRoleDTO,
} from '@/lib/team-types';

/**
 * GET /api/team/members — everything the Members tab needs in one payload:
 * memberships joined with user profiles, pending invitations, the role
 * catalog (environment + org custom roles, with a degraded fallback when
 * the roles API isn't enabled), and per-user 2FA status.
 */
export async function GET() {
  try {
    const ctx = await getTeamContext();
    if (isTeamContextError(ctx)) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }
    const { workos, organizationId } = ctx;

    // Memberships — active and deactivated (pending ones surface through
    // the invitations list instead).
    const memberships: Array<{
      id: string;
      userId: string;
      status: string;
      createdAt: string;
      role?: { slug?: string } | null;
    }> = [];
    let after: string | undefined;
    do {
      const page = await workos.userManagement.listOrganizationMemberships({
        organizationId,
        statuses: ['active', 'inactive'],
        limit: 100,
        after,
      });
      memberships.push(...page.data);
      after = page.listMetadata?.after ?? undefined;
    } while (after);

    // User profiles for the join.
    const users = new Map<
      string,
      {
        firstName: string | null;
        lastName: string | null;
        email: string;
        lastSignInAt: string | null;
        profilePictureUrl: string | null;
      }
    >();
    after = undefined;
    do {
      const page = await workos.userManagement.listUsers({ organizationId, limit: 100, after });
      for (const u of page.data) users.set(u.id, u);
      after = page.listMetadata?.after ?? undefined;
    } while (after);

    // 2FA — one listAuthFactors call per member; fine at back-office team
    // sizes, and a failure just reads as "off" rather than failing the page.
    const twoFactor = new Map<string, boolean>();
    await Promise.all(
      memberships.map(async (m) => {
        try {
          const factors = await workos.userManagement.listAuthFactors({ userId: m.userId });
          twoFactor.set(m.userId, factors.data.length > 0);
        } catch {
          twoFactor.set(m.userId, false);
        }
      }),
    );

    const members: TeamMemberDTO[] = memberships.map((m) => {
      const u = users.get(m.userId);
      const name =
        [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() || u?.email || 'Unknown user';
      return {
        membershipId: m.id,
        userId: m.userId,
        name,
        email: u?.email ?? '',
        roleSlug: m.role?.slug ?? 'member',
        status: m.status === 'inactive' ? 'inactive' : 'active',
        twoFactorEnabled: twoFactor.get(m.userId) ?? false,
        lastSignInAt: u?.lastSignInAt ?? null,
        createdAt: m.createdAt,
        profilePictureUrl: u?.profilePictureUrl ?? null,
      };
    });

    // Pending invitations. WorkOS doesn't return the invited role on the
    // invitation object, so invite rows carry no role tag.
    const invitations: PendingInviteDTO[] = [];
    after = undefined;
    do {
      const page = await workos.userManagement.listInvitations({
        organizationId,
        limit: 100,
        after,
      });
      for (const inv of page.data) {
        if (inv.state !== 'pending') continue;
        const inviter = inv.inviterUserId ? users.get(inv.inviterUserId) : undefined;
        invitations.push({
          invitationId: inv.id,
          email: inv.email,
          createdAt: inv.createdAt,
          expiresAt: inv.expiresAt,
          inviterName: inviter
            ? [inviter.firstName, inviter.lastName].filter(Boolean).join(' ') || inviter.email
            : null,
          acceptUrl: inv.acceptInvitationUrl,
        });
      }
      after = page.listMetadata?.after ?? undefined;
    } while (after);

    // Role catalog — environment roles + org custom roles. The
    // authorization module may not be enabled for every WorkOS account, so
    // each source is best-effort with a fallback derived from the role
    // slugs already in use.
    const roles: TeamRoleDTO[] = [];
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
    } catch {
      // roles API unavailable — fall through
    }
    try {
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
      // roles API unavailable — fall through
    }
    if (roles.length === 0) {
      const inUse = new Set(members.map((m) => m.roleSlug));
      inUse.add('admin');
      inUse.add('member');
      for (const slug of inUse) {
        roles.push({
          slug,
          name: humanizeRoleSlug(slug),
          description: null,
          type: 'environment',
          permissions: [],
        });
      }
    }

    const payload: TeamPayload = { members, invitations, roles };
    return NextResponse.json(payload);
  } catch (error) {
    console.error('GET /api/team/members failed:', error);
    return NextResponse.json({ error: 'Failed to load team' }, { status: 500 });
  }
}
