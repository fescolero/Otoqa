import { internalMutation } from '../_generated/server';
import { Id } from '../_generated/dataModel';

/**
 * Migration: Unlink falsely-linked carrier partnerships
 *
 * When brokers created carriers with a contact phone, the old create() logic
 * auto-created a carrier organization and set carrierOrgId + linkedAt on the
 * partnership, making it appear "Linked" even though the carrier never signed
 * up or accepted the partnership.
 *
 * Detection: partnerships where carrierOrgId points to a carrier org that was
 * auto-created by the broker (has no workosOrgId, meaning the carrier never
 * signed up through the real auth flow).
 *
 * This migration:
 * 1. Clears carrierOrgId and linkedAt on these partnerships (makes them reference-only)
 * 2. Preserves the carrier org record (no data deleted) for potential future use
 *
 * Run with: npx convex run migrations/unlinkFalselyLinkedCarriers:run
 * Dry run:  npx convex run migrations/unlinkFalselyLinkedCarriers:dryRun
 */

/**
 * Helper: Find the organization for a carrierOrgId.
 * carrierOrgId can be a Convex _id, a workosOrgId, or a clerkOrgId.
 * Returns the org if it's a broker-created carrier (no workosOrgId), null otherwise.
 */
async function findBrokerCreatedOrg(
  ctx: any,
  carrierOrgId: string
): Promise<boolean> {
  // Try as Convex document ID first
  try {
    const org = await ctx.db.get(carrierOrgId as Id<'organizations'>);
    if (org && org.orgType === 'CARRIER' && !org.workosOrgId) {
      return true;
    }
  } catch {
    // Not a valid Convex ID — could be a workosOrgId or clerkOrgId
  }

  // Try looking up by clerkOrgId (auto-created orgs may have been given a clerkOrgId)
  const byClerk = await ctx.db
    .query('organizations')
    .filter((q: any) => q.eq(q.field('clerkOrgId'), carrierOrgId))
    .first();

  if (byClerk && byClerk.orgType === 'CARRIER' && !byClerk.workosOrgId) {
    return true;
  }

  return false;
}

export const dryRun = internalMutation({
  args: {},
  handler: async (ctx) => {
    console.log('🔍 Dry run: finding falsely-linked carrier partnerships...');

    const partnerships = await ctx.db.query('carrierPartnerships').collect();
    const falselyLinked = [];

    for (const p of partnerships) {
      if (!p.carrierOrgId) continue;

      if (await findBrokerCreatedOrg(ctx, p.carrierOrgId)) {
        falselyLinked.push({
          partnershipId: p._id,
          carrierName: p.carrierName,
          mcNumber: p.mcNumber,
          status: p.status,
          carrierOrgId: p.carrierOrgId,
          linkedAt: p.linkedAt ? new Date(p.linkedAt).toISOString() : null,
        });
      }
    }

    console.log(`\n📊 Found ${falselyLinked.length} falsely-linked partnerships:`);
    for (const p of falselyLinked) {
      console.log(`  - ${p.carrierName} (MC# ${p.mcNumber}) | status: ${p.status} | linked: ${p.linkedAt}`);
    }

    return {
      count: falselyLinked.length,
      partnerships: falselyLinked,
    };
  },
});

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    console.log('🔄 Starting migration: unlink falsely-linked carrier partnerships...');
    const startTime = Date.now();

    const partnerships = await ctx.db.query('carrierPartnerships').collect();

    let unlinked = 0;
    let skipped = 0;

    for (const p of partnerships) {
      if (!p.carrierOrgId) {
        skipped++;
        continue;
      }

      if (await findBrokerCreatedOrg(ctx, p.carrierOrgId)) {
        await ctx.db.patch(p._id, {
          carrierOrgId: undefined,
          linkedAt: undefined,
          updatedAt: Date.now(),
        });
        unlinked++;
        console.log(`  ✅ Unlinked: ${p.carrierName} (MC# ${p.mcNumber})`);
      } else {
        skipped++;
      }
    }

    const duration = Date.now() - startTime;
    console.log(`\n✅ Migration complete in ${duration}ms`);
    console.log(`   Unlinked: ${unlinked}, Skipped: ${skipped}`);

    return { unlinked, skipped, duration };
  },
});
