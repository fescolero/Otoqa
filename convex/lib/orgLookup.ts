/**
 * Organization lookups that tolerate the three id shapes stored in
 * `carrierPartnerships.carrierOrgId` over time (WorkOS id, Clerk id, or
 * the organizations Convex id). Shared by entityDocuments and the
 * platform offboarding flow.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

type Ctx = QueryCtx | MutationCtx;

/** Resolve an organizations row from a WorkOS id, a Clerk id, or a Convex id. */
export async function orgByAnyId(ctx: Ctx, id: string | undefined): Promise<Doc<'organizations'> | null> {
  if (!id) return null;
  const byWorkos = await ctx.db
    .query('organizations')
    .withIndex('by_organization', (q) => q.eq('workosOrgId', id))
    .first();
  if (byWorkos) return byWorkos;
  const byClerk = await ctx.db
    .query('organizations')
    .withIndex('by_clerk_org', (q) => q.eq('clerkOrgId', id))
    .first();
  if (byClerk) return byClerk;
  const nid = ctx.db.normalizeId('organizations', id);
  return nid ? ctx.db.get(nid) : null;
}

/** Every partnership whose carrier side is this org, across the id shapes. */
export async function partnershipsLinkedToOrg(
  ctx: Ctx,
  org: Doc<'organizations'>,
): Promise<Doc<'carrierPartnerships'>[]> {
  const ids = [org.workosOrgId, org.clerkOrgId, org._id as string].filter((x): x is string => !!x);
  const seen = new Set<string>();
  const out: Doc<'carrierPartnerships'>[] = [];
  for (const id of ids) {
    const rows = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_carrier', (q) => q.eq('carrierOrgId', id))
      .collect();
    for (const r of rows) {
      if (seen.has(r._id)) continue;
      seen.add(r._id);
      out.push(r);
    }
  }
  return out;
}

/** Offboarding window (documents-storage-spec.md §7): started, not yet purged. */
export function isOffboarding(org: Pick<Doc<'organizations'>, 'offboardingStartedAt' | 'purgedAt'> | null | undefined): boolean {
  return !!org?.offboardingStartedAt && !org.purgedAt;
}

export const OFFBOARDING_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
