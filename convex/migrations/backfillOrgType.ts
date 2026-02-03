import { internalMutation } from '../_generated/server';

/**
 * Migration: Backfill orgType for existing organizations
 *
 * Sets orgType to BROKER for all organizations that have workosOrgId
 * (existing web TMS users are brokers by default)
 *
 * Run this with: npx convex run migrations/backfillOrgType:run
 */
export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    console.log('🔄 Starting orgType backfill migration...');
    const startTime = Date.now();

    // Get all organizations without orgType
    const orgs = await ctx.db.query('organizations').collect();

    let updated = 0;
    let skipped = 0;

    for (const org of orgs) {
      // Skip if already has orgType
      if (org.orgType) {
        skipped++;
        continue;
      }

      // Determine orgType based on auth provider
      let orgType: 'BROKER' | 'CARRIER' | 'BROKER_CARRIER';

      if (org.workosOrgId && org.clerkOrgId) {
        // Has both - upgraded carrier
        orgType = 'BROKER_CARRIER';
      } else if (org.clerkOrgId) {
        // Only Clerk - mobile carrier
        orgType = 'CARRIER';
      } else {
        // Only WorkOS (or neither, default) - web broker
        orgType = 'BROKER';
      }

      await ctx.db.patch(org._id, {
        orgType,
        updatedAt: Date.now(),
      });

      updated++;
      console.log(`  ✅ ${org.name}: ${orgType}`);
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Migration complete in ${duration}ms`);
    console.log(`   Updated: ${updated}, Skipped: ${skipped}`);

    return { updated, skipped, duration };
  },
});
