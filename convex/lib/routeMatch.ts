import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

/**
 * Route-assignment matching — the single supported way to resolve
 * (org, HCR, trip) to the route rule that should drive auto-assignment.
 *
 * This logic used to exist in four places that had already drifted:
 * autoAssignment.autoAssignLoad (sweep), autoAssignment
 * .triggerAutoAssignmentForLoad (on create), autoAssignment
 * .findRouteAssignment (dead), and routeAssignments.getByRoute (which was
 * missing the third tier, so the UI preview disagreed with the engine).
 * Any new matching rule — day-of-week restrictions, exclusions — belongs
 * here and nowhere else.
 *
 * Tiers, most specific first:
 *   1. exact HCR + trip
 *   2. HCR-only rule (a route with no tripNumber — "everything on this HCR")
 *   3. any active route on this HCR
 *
 * Within a tier, lowest `priority` wins. That sort is the point: every
 * previous copy used `.first()`, which returns index order, so `priority`
 * was stored, edited, and displayed but never actually consulted by the
 * assignment engine.
 */

/** Candidates are collected and filtered in JS rather than via `.filter()`
 *  on the query: array-valued rules (activeDays) can't be expressed in a
 *  Convex index or filter, and per-(org, HCR) row counts are small. */
function best(candidates: Doc<'routeAssignments'>[]): Doc<'routeAssignments'> | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => a.priority - b.priority)[0];
}

export async function matchRouteAssignment(
  ctx: QueryCtx | MutationCtx,
  args: { workosOrgId: string; hcr: string; trip?: string },
): Promise<Doc<'routeAssignments'> | null> {
  // Tier 1 — exact HCR + trip.
  if (args.trip) {
    const exact = await ctx.db
      .query('routeAssignments')
      .withIndex('by_org_hcr_trip', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('hcr', args.hcr).eq('tripNumber', args.trip),
      )
      .collect();

    const hit = best(exact.filter((r) => r.isActive));
    if (hit) return hit;
  }

  // Tiers 2 and 3 share the same index read.
  const onHcr = (
    await ctx.db
      .query('routeAssignments')
      .withIndex('by_org_hcr', (q) => q.eq('workosOrgId', args.workosOrgId).eq('hcr', args.hcr))
      .collect()
  ).filter((r) => r.isActive);

  // Tier 2 — the HCR-only rule.
  const hcrOnly = best(onHcr.filter((r) => r.tripNumber === undefined));
  if (hcrOnly) return hcrOnly;

  // Tier 3 — any active route on this HCR.
  return best(onHcr);
}
