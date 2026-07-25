import type { QueryCtx, MutationCtx, ActionCtx } from '../_generated/server';
import { isPermitted, type PermissionClaims } from './permissions';
import { normalizePhoneForMatch } from '../_helpers/mobileAuth';

/**
 * Shared authorization helpers for Convex functions.
 *
 * The central rule: a client-supplied `organizationId` / `workosOrgId` must
 * NEVER be trusted. Functions that operate on per-org data must derive the
 * caller's org from the authenticated identity and scope all reads/writes
 * to that value. These helpers make that pattern consistent across the
 * codebase and fail-closed on any ambiguity.
 */

type AnyCtx = QueryCtx | MutationCtx | ActionCtx;

/**
 * Shape of the identity claims we care about. WorkOS issues `org_id` on its
 * JWTs; older code and Clerk-issued identities may use `organizationId`.
 */
interface IdentityWithOrg {
  subject: string;
  org_id?: string;
  organizationId?: string;
}

/**
 * Non-throwing variant of `requireCallerOrgId` for functions that serve
 * BOTH org-member (WorkOS) and driver-app (Clerk, no org claim) callers
 * and branch on which one they got. Returns null when unauthenticated or
 * when the identity carries no org claim — callers must treat null as
 * "not an org member", never as "allowed".
 */
export async function getCallerOrgId(ctx: AnyCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  const claims = identity as unknown as IdentityWithOrg;
  const orgId = claims.org_id ?? claims.organizationId;
  return typeof orgId === 'string' && orgId ? orgId : null;
}

/**
 * Derive the caller's org ID from the authenticated identity.
 *
 * Fail-closed: throws if the caller is unauthenticated OR if the identity
 * has no org claim at all. Never returns undefined. Never accepts a
 * client-supplied org ID.
 */
export async function requireCallerOrgId(ctx: AnyCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Unauthenticated');

  const claims = identity as unknown as IdentityWithOrg;
  const orgId = claims.org_id ?? claims.organizationId;

  if (!orgId || typeof orgId !== 'string') {
    throw new Error('No organization claim on identity');
  }
  return orgId;
}

/**
 * Like `requireCallerOrgId`, but also returns the identity for callers that
 * need `identity.subject` (e.g. to record who performed a mutation).
 */
export async function requireCallerIdentity(ctx: AnyCtx): Promise<{
  orgId: string;
  userId: string;
  userName: string | undefined;
  userEmail: string | undefined;
}> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Unauthenticated');

  const claims = identity as unknown as IdentityWithOrg;
  const orgId = claims.org_id ?? claims.organizationId;

  if (!orgId || typeof orgId !== 'string') {
    throw new Error('No organization claim on identity');
  }
  return {
    orgId,
    userId: identity.subject,
    userName: identity.name ?? undefined,
    userEmail: identity.email ?? undefined,
  };
}

/**
 * Asserts that a client-supplied org ID matches the caller's identity org.
 *
 * Use this for legacy endpoints that still accept `workosOrgId` as an arg
 * for historical reasons (e.g. cron-triggered mutations, admin tools) but
 * still need to prove the caller owns that org. New code should just call
 * `requireCallerOrgId` and ignore any client-supplied value entirely.
 */
export async function assertCallerOwnsOrg(
  ctx: AnyCtx,
  claimedOrgId: string,
): Promise<{ orgId: string; userId: string; userName: string | undefined; userEmail: string | undefined }> {
  const result = await requireCallerIdentity(ctx);
  if (result.orgId !== claimedOrgId) {
    throw new Error('Not authorized for this organization');
  }
  return result;
}

/**
 * RBAC claims from the caller's access token. WorkOS puts `role`, `roles`,
 * and `permissions` on the JWT once RBAC is configured; sessions predating
 * that carry none (see lib/permissions.ts for how the policy treats them).
 */
export async function getCallerPermissionClaims(ctx: AnyCtx): Promise<PermissionClaims> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return {};
  const claims = identity as unknown as PermissionClaims;
  return {
    role: typeof claims.role === 'string' ? claims.role : undefined,
    roles: Array.isArray(claims.roles) ? claims.roles : undefined,
    permissions: Array.isArray(claims.permissions) ? claims.permissions : undefined,
  };
}

/**
 * `assertCallerOwnsOrg` plus an RBAC permission check — the standard guard
 * for permission-gated mutations that still take a client-supplied org ID.
 * `slug` is an `area:level` permission (e.g. `settings:edit`).
 */
export async function assertOrgPermission(
  ctx: AnyCtx,
  claimedOrgId: string,
  slug: string,
): Promise<{ orgId: string; userId: string; userName: string | undefined; userEmail: string | undefined }> {
  const result = await assertCallerOwnsOrg(ctx, claimedOrgId);
  const claims = await getCallerPermissionClaims(ctx);
  if (!isPermitted(claims, slug)) {
    throw new Error(`Your role doesn't have the ${slug} permission`);
  }
  return result;
}

/**
 * Mobile Dispatch capabilities (split-plan §4.2, decision D9) mapped to
 * RBAC permission slugs for WorkOS staff callers. Clerk mobile callers
 * (the "Owner-operator" persona) hold every capability by definition.
 */
export const CAPABILITY_SLUGS = {
  canDispatch: 'loads:edit',
  canViewSettlements: 'accounting:view',
  canManageDrivers: 'fleet:edit',
} as const;

export type DispatchCapability = keyof typeof CAPABILITY_SLUGS;

/**
 * Resolve a Clerk mobile caller to their carrier-org membership, mirroring
 * `carrierMobile.getUserRoles` Methods 1 and 2 exactly (split-plan §4.2
 * parity rule): `userIdentityLinks` by `clerkUserId` first, then by
 * verified phone number (same variant set). Only OWNER/ADMIN links on a
 * non-deleted CARRIER/BROKER_CARRIER-capable org count — those are the
 * roles that unlock owner mode in shipped builds. Returns null when the
 * caller has no qualifying membership (e.g. MEMBER links, staff tokens).
 */
export async function resolveClerkCarrierMembership(
  ctx: QueryCtx | MutationCtx,
): Promise<{
  org: {
    _id: string;
    name: string;
    clerkOrgId?: string;
    workosOrgId?: string;
    orgType?: string;
  };
  role: 'OWNER' | 'ADMIN';
} | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  const qualify = async (link: {
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    organizationId: import('../_generated/dataModel').Id<'organizations'>;
  }) => {
    if (link.role !== 'OWNER' && link.role !== 'ADMIN') return null;
    const org = await ctx.db.get(link.organizationId);
    if (!org || org.isDeleted) return null;
    return { org, role: link.role };
  };

  // Method 1: by Clerk user id.
  const link = await ctx.db
    .query('userIdentityLinks')
    .withIndex('by_clerk', (q) => q.eq('clerkUserId', identity.subject))
    .first();
  if (link) {
    const hit = await qualify(link);
    if (hit) return hit;
  }

  // Method 2: by verified phone, same variants as getUserRoles.
  const rawPhone =
    (identity as unknown as { phoneNumber?: string; phone_number?: string }).phoneNumber ??
    (identity as unknown as { phoneNumber?: string; phone_number?: string }).phone_number;
  if (typeof rawPhone === 'string' && rawPhone) {
    const normalized = normalizePhoneForMatch(rawPhone);
    for (const variant of [normalized, `+1${normalized}`, `1${normalized}`]) {
      const phoneLink = await ctx.db
        .query('userIdentityLinks')
        .withIndex('by_phone', (q) => q.eq('phone', variant))
        .first();
      if (phoneLink) {
        const hit = await qualify(phoneLink);
        if (hit) return hit;
      }
    }
  }

  return null;
}

/**
 * The Dispatch-app capability guard (split-plan §4.3) — dual-path,
 * FAIL-LOUD. Unlike the fail-soft `requireCarrierAuth` used by legacy
 * driver-app reads, every denial throws a typed error so staff never see
 * silently-empty screens.
 *
 *   - WorkOS caller (org claim on the token): org claim must equal
 *     `orgExternalId` AND the RBAC claims must carry the capability's
 *     permission slug (`assertOrgPermission` — admin bypass and the
 *     legacy-grandfather rule per lib/permissions.ts apply).
 *   - Clerk caller (no org claim): must resolve to an OWNER/ADMIN
 *     carrier membership (`resolveClerkCarrierMembership`) whose org
 *     matches `orgExternalId` (clerkOrgId/workosOrgId/_id — the
 *     requireCarrierAuth match set). Owner-operators hold every
 *     capability (D9).
 */
export async function requireCapability(
  ctx: QueryCtx | MutationCtx,
  orgExternalId: string,
  capability: DispatchCapability,
): Promise<{ userId: string; userName: string | undefined; userEmail: string | undefined }> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Unauthenticated');

  const claims = identity as unknown as IdentityWithOrg;
  const claimOrg = claims.org_id ?? claims.organizationId;

  if (claimOrg) {
    // WorkOS/staff path — org claim + RBAC slug.
    return await assertOrgPermission(ctx, orgExternalId, CAPABILITY_SLUGS[capability]);
  }

  // Clerk/owner-operator path.
  const membership = await resolveClerkCarrierMembership(ctx);
  if (
    membership &&
    (membership.org.clerkOrgId === orgExternalId ||
      membership.org.workosOrgId === orgExternalId ||
      membership.org._id === orgExternalId)
  ) {
    return {
      userId: identity.subject,
      userName: identity.name ?? undefined,
      userEmail: identity.email ?? undefined,
    };
  }

  throw new Error(`Not authorized: missing ${capability} for this organization`);
}

/**
 * Asserts the caller belongs to the carrier org identified by an EXTERNAL
 * org id — the clerkOrgId/workosOrgId value stored on
 * `loadCarrierAssignments.carrierOrgId`. Serves BOTH caller populations of
 * the carrier-side assignment mutations:
 *
 *   1. Org-claim tokens (WorkOS web/staff, org-scoped Clerk sessions):
 *      the token's org claim must equal the external id.
 *   2. Clerk mobile tokens (owner mode; no org claim): resolve via
 *      `userIdentityLinks` — first by `clerkUserId`, then by verified
 *      phone — mirroring `carrierMobile.getUserRoles` Methods 1 and 2
 *      exactly (split-plan §4.2 parity rule). The link role must be
 *      OWNER or ADMIN (the roles that unlock owner mode in shipped
 *      builds), the org must not be soft-deleted, and its
 *      clerkOrgId/workosOrgId/_id must equal the external id (the same
 *      match set as `requireCarrierAuth`).
 *
 * Fail-closed: throws on any miss. Returns identity fields for audit
 * logging. Needs db access, so unlike the claim-only helpers above it
 * cannot run in an action ctx.
 */
export async function assertCallerInCarrierOrg(
  ctx: QueryCtx | MutationCtx,
  carrierExternalOrgId: string,
): Promise<{ userId: string; userName: string | undefined; userEmail: string | undefined }> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Unauthenticated');

  const result = {
    userId: identity.subject,
    userName: identity.name ?? undefined,
    userEmail: identity.email ?? undefined,
  };

  // Path 1: org claim on the token.
  const claims = identity as unknown as IdentityWithOrg;
  const claimOrg = claims.org_id ?? claims.organizationId;
  if (claimOrg && claimOrg === carrierExternalOrgId) {
    return result;
  }

  const orgMatches = (org: {
    _id: string;
    clerkOrgId?: string;
    workosOrgId?: string;
    isDeleted?: boolean;
  }) =>
    !org.isDeleted &&
    (org.clerkOrgId === carrierExternalOrgId ||
      org.workosOrgId === carrierExternalOrgId ||
      org._id === carrierExternalOrgId);

  // Path 2a: Clerk identity link by user id.
  const link = await ctx.db
    .query('userIdentityLinks')
    .withIndex('by_clerk', (q) => q.eq('clerkUserId', identity.subject))
    .first();
  if (link && (link.role === 'OWNER' || link.role === 'ADMIN')) {
    const org = await ctx.db.get(link.organizationId);
    if (org && orgMatches(org)) return result;
  }

  // Path 2b: Clerk phone fallback — same variant set as getUserRoles.
  const rawPhone =
    (identity as unknown as { phoneNumber?: string; phone_number?: string }).phoneNumber ??
    (identity as unknown as { phoneNumber?: string; phone_number?: string }).phone_number;
  if (typeof rawPhone === 'string' && rawPhone) {
    const normalized = normalizePhoneForMatch(rawPhone);
    for (const variant of [normalized, `+1${normalized}`, `1${normalized}`]) {
      const phoneLink = await ctx.db
        .query('userIdentityLinks')
        .withIndex('by_phone', (q) => q.eq('phone', variant))
        .first();
      if (phoneLink && (phoneLink.role === 'OWNER' || phoneLink.role === 'ADMIN')) {
        const org = await ctx.db.get(phoneLink.organizationId);
        if (org && orgMatches(org)) return result;
      }
    }
  }

  throw new Error('Not authorized for this carrier');
}
