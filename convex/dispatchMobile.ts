import { query } from './_generated/server';
import {
  CAPABILITY_SLUGS,
  getCallerPermissionClaims,
  resolveClerkCarrierMembership,
  type DispatchCapability,
} from './lib/auth';
import { isPermitted } from './lib/permissions';

/**
 * Otoqa Dispatch — mobile session bootstrap (split-plan §3.3 / §4.2).
 *
 * One query the Dispatch app calls after sign-in to learn who the caller
 * is and what to render. Serves BOTH auth populations on one Convex
 * deployment:
 *
 *   - WorkOS staff (org claim + RBAC permission claims on the token):
 *     capabilities derive from the claims via the same isPermitted policy
 *     the web uses (admin bypass → legacy grandfathering → strict check).
 *   - Clerk owner-operators (no org claim): membership resolves through
 *     userIdentityLinks (by clerkUserId, then verified phone — the
 *     getUserRoles parity paths), and the persona holds every capability
 *     (decision D9).
 *
 * The app renders from the returned capability flags ONLY — never from
 * "which provider am I". Server-side enforcement lives in
 * requireCapability (lib/auth.ts); this query is the display-side twin.
 *
 * NOTE (§4.4 behavior freeze): this is a NEW endpoint. carrierMobile.
 * getUserRoles is intentionally untouched — old Driver builds keep their
 * exact behavior.
 */

interface DispatchSession {
  authenticated: boolean;
  /** Which auth population the token belongs to (informational only). */
  provider: 'workos' | 'clerk' | null;
  /** External org id (workosOrgId for staff, clerkOrgId/workosOrgId for owner-ops). */
  orgExternalId: string | null;
  /** Convex organizations doc id, when the org doc is known. */
  orgConvexId: string | null;
  orgName: string | null;
  orgType: string | null;
  /** UI label: staff see their RBAC role; all Clerk users are "Owner-operator" (D9). */
  persona: 'staff' | 'owner_operator' | null;
  capabilities: Record<DispatchCapability, boolean>;
}

const NO_SESSION: DispatchSession = {
  authenticated: false,
  provider: null,
  orgExternalId: null,
  orgConvexId: null,
  orgName: null,
  orgType: null,
  persona: null,
  capabilities: { canDispatch: false, canViewSettlements: false, canManageDrivers: false },
};

export const getSession = query({
  args: {},
  handler: async (ctx): Promise<DispatchSession> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return NO_SESSION;

    const claims = identity as unknown as { org_id?: string; organizationId?: string };
    const claimOrg = claims.org_id ?? claims.organizationId;

    if (claimOrg) {
      // WorkOS staff path. Capabilities from RBAC claims; org doc looked up
      // for display metadata (may be absent for orgs not mirrored yet).
      const permissionClaims = await getCallerPermissionClaims(ctx);
      const capabilities = Object.fromEntries(
        (Object.keys(CAPABILITY_SLUGS) as DispatchCapability[]).map((cap) => [
          cap,
          isPermitted(permissionClaims, CAPABILITY_SLUGS[cap]),
        ]),
      ) as Record<DispatchCapability, boolean>;

      const org = await ctx.db
        .query('organizations')
        .withIndex('by_organization', (q) => q.eq('workosOrgId', claimOrg))
        .first();

      return {
        authenticated: true,
        provider: 'workos',
        orgExternalId: claimOrg,
        orgConvexId: org?._id ?? null,
        orgName: org?.name ?? null,
        orgType: org?.orgType ?? null,
        persona: 'staff',
        capabilities,
      };
    }

    // Clerk path — owner-operator persona or nothing.
    const membership = await resolveClerkCarrierMembership(ctx);
    if (!membership) {
      // Authenticated, but no qualifying carrier membership (e.g. a driver
      // with no owner role, or a MEMBER link). The app shows its
      // "not registered for dispatch" dead-end — fail loud, not empty.
      return { ...NO_SESSION, authenticated: true, provider: 'clerk' };
    }

    return {
      authenticated: true,
      provider: 'clerk',
      orgExternalId: membership.org.clerkOrgId ?? membership.org.workosOrgId ?? null,
      orgConvexId: membership.org._id,
      orgName: membership.org.name,
      orgType: membership.org.orgType ?? null,
      persona: 'owner_operator',
      capabilities: { canDispatch: true, canViewSettlements: true, canManageDrivers: true },
    };
  },
});
