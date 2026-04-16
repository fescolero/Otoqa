import type { QueryCtx, MutationCtx, ActionCtx } from '../_generated/server';

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
  subject: string;
  identity: IdentityWithOrg;
}> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Unauthenticated');

  const claims = identity as unknown as IdentityWithOrg;
  const orgId = claims.org_id ?? claims.organizationId;

  if (!orgId || typeof orgId !== 'string') {
    throw new Error('No organization claim on identity');
  }
  return { orgId, subject: identity.subject, identity: claims };
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
): Promise<string> {
  const callerOrgId = await requireCallerOrgId(ctx);
  if (callerOrgId !== claimedOrgId) {
    throw new Error('Not authorized for this organization');
  }
  return callerOrgId;
}
