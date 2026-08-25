import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { unassignLoadResources } from '../dispatchLegs';
import { getLoadFacets } from '../lib/loadFacets';
import { matchRouteAssignment } from '../lib/routeMatch';

/**
 * One-off cleanup for assignments made by the removed third matching tier.
 *
 * That tier let any active rule on an HCR claim a load whose trip had no
 * rule of its own, so a rule scoped to Trip 1 picked up loads on Trip 821 —
 * decided by a same-priority tiebreak, with no rule in the UI to explain
 * the result.
 *
 * Deliberately narrow. It only touches a load whose (HCR, trip) has NO
 * rule at all — the tier-3 artifact, where the only thing that ever
 * matched was an unrelated trip's rule.
 *
 * A load whose trip DOES have a rule that simply does not cover that
 * weekday is a different case: those were assigned before service days
 * were configured, and retroactively undoing them is a judgment call for
 * a dispatcher, not a backfill. They are counted and returned separately
 * as `dayMismatch` and never modified.
 *
 * Loads already in motion are never touched. `dryRun` defaults to true.
 */
export const unassignTier3Matches = internalMutation({
  args: {
    workosOrgId: v.string(),
    /** Only consider loads on or after this service date (YYYY-MM-DD). */
    fromServiceDate: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    examined: v.number(),
    affected: v.number(),
    skippedInMotion: v.number(),
    dayMismatch: v.number(),
    loads: v.array(
      v.object({
        internalId: v.string(),
        hcr: v.optional(v.string()),
        trip: v.optional(v.string()),
        serviceDate: v.optional(v.string()),
        driverId: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;

    const assigned = await ctx.db
      .query('loadInformation')
      .withIndex('by_status', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('status', 'Assigned'),
      )
      .collect();

    const loads: Array<{
      internalId: string;
      hcr?: string;
      trip?: string;
      serviceDate?: string;
      driverId?: string;
    }> = [];
    let examined = 0;
    let affected = 0;
    let skippedInMotion = 0;
    let dayMismatch = 0;

    for (const load of assigned) {
      if (args.fromServiceDate && (load.firstStopDate ?? '') < args.fromServiceDate) continue;
      examined++;

      const facets = await getLoadFacets(ctx, load._id);
      if (!facets.hcr) continue;

      // Would the corrected matcher pick a rule for this load? If so the
      // assignment is legitimate regardless of how it was made.
      const match = await matchRouteAssignment(ctx, {
        workosOrgId: load.workosOrgId,
        hcr: facets.hcr,
        trip: facets.trip,
        serviceDate: load.firstStopDate,
      });
      if (match.route) continue;

      // Nothing matched — but WHY. Ask the TABLE, not the matcher: a
      // restricted route declines a dateless query (that is the
      // NO_SERVICE_DATE rule), so re-running the matcher without a date
      // would report every calendar-restricted rule as nonexistent.
      const rulesForTrip = (
        await ctx.db
          .query('routeAssignments')
          .withIndex('by_org_hcr', (q) =>
            q.eq('workosOrgId', load.workosOrgId).eq('hcr', facets.hcr!),
          )
          .collect()
      ).filter(
        (r) =>
          r.isActive && (r.tripNumber === facets.trip || r.tripNumber === undefined),
      );

      // A rule for this trip exists and simply does not cover that weekday:
      // a service-day mismatch on an assignment made before days existed,
      // not a tier-3 artifact. A dispatcher decides, not a backfill.
      if (rulesForTrip.length > 0) {
        dayMismatch++;
        continue;
      }

      // Never disturb a load the driver has already started.
      const legs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect();
      if (legs.some((l) => l.status === 'ACTIVE' || l.status === 'COMPLETED')) {
        skippedInMotion++;
        continue;
      }
      if (load.trackingStatus !== 'Pending') {
        skippedInMotion++;
        continue;
      }

      loads.push({
        internalId: load.internalId,
        hcr: facets.hcr,
        trip: facets.trip,
        serviceDate: load.firstStopDate,
        driverId: load.primaryDriverId as string | undefined,
      });
      affected++;

      if (!dryRun) {
        await unassignLoadResources(
          ctx,
          load._id,
          { userId: 'system', userName: 'Tier-3 cleanup' },
          'auto-assigned by a rule for a different trip; returned for manual dispatch',
        );
      }
    }

    return { dryRun, examined, affected, skippedInMotion, dayMismatch, loads };
  },
});
