/**
 * Load Review Mutations and Queries
 * Handles the "Spot Review" workflow for loads that matched wildcard lanes
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertCallerOwnsOrg, requireCallerOrgId, requireCallerIdentity } from "./lib/auth";
import { getLoadFacets, findLoadIdsByFacets } from "./lib/loadFacets";
import type { Doc } from "./_generated/dataModel";

/**
 * OPTION A: Confirm Spot Load
 * User confirms this is truly a one-time spot load
 * Clears the requiresManualReview flag, keeps loadType as SPOT
 */
export const confirmSpotLoad = mutation({
  args: {
    loadId: v.id("loadInformation"),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load) {
      throw new Error("Load not found");
    }
    if (load.workosOrgId !== callerOrgId) {
      throw new Error("Load not found");
    }

    await ctx.db.patch(args.loadId, {
      requiresManualReview: false,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * OPTION B: Convert to Contract
 * User determines this should be a recurring contract lane
 * Creates a specific contract lane for this HCR+Trip combination
 * Updates the load to CONTRACT type and clears review flag
 */
export const convertToContract = mutation({
  args: {
    loadId: v.id("loadInformation"),
    userId: v.string(), // WorkOS user ID for createdBy
    contractName: v.optional(v.string()),
    rateType: v.optional(v.string()), // "Flat Rate", "Per Mile", etc.
    rate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await requireCallerIdentity(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load) {
      throw new Error("Load not found");
    }
    if (load.workosOrgId !== callerOrgId) {
      throw new Error("Load not found");
    }

    // Read HCR/Trip from facet tags (Phase 5 drops the columns).
    const loadFacets = await getLoadFacets(ctx, load._id);
    if (!loadFacets.hcr || !loadFacets.trip) {
      throw new Error("Cannot convert: Load missing HCR or Trip information");
    }

    // Check if specific lane already exists. contractLanes still has its
    // own hcr/tripNumber columns — those stay.
    const existingLane = await ctx.db
      .query("contractLanes")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", load.workosOrgId))
      .filter((q) =>
        q.and(
          q.eq(q.field("hcr"), loadFacets.hcr),
          q.eq(q.field("tripNumber"), loadFacets.trip),
          q.eq(q.field("isDeleted"), false)
        )
      )
      .first();

    // 1. Create the specific Contract Lane (only if it doesn't exist)
    let contractLaneId = existingLane?._id;

    if (!existingLane) {
      // Get customer info for defaults
      const customer = await ctx.db.get(load.customerId);
      if (!customer || !('name' in customer)) {
        throw new Error("Customer not found");
      }

      // Create contract period (today + 1 year)
      const today = new Date().toISOString().split('T')[0];
      const oneYearLater = new Date();
      oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
      const contractPeriodEnd = oneYearLater.toISOString().split('T')[0];

      // Create new contract lane
      contractLaneId = await ctx.db.insert("contractLanes", {
        workosOrgId: load.workosOrgId,
        customerCompanyId: load.customerId,
        hcr: loadFacets.hcr,
        tripNumber: loadFacets.trip,
        contractName: args.contractName || `Lane: ${customer.name} - ${loadFacets.trip}`,
        contractPeriodStart: today,
        contractPeriodEnd,
        rateType: (args.rateType || "Flat Rate") as "Per Mile" | "Flat Rate" | "Per Stop",
        rate: args.rate ?? 0,
        currency: "USD" as const,
        miles: load.contractMiles,
        stops: [],
        isActive: true,
        isDeleted: false,
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // 2. Find ALL existing loads with the same HCR+Trip that are SPOT.
    // findLoadIdsByFacets replaces the old parsedHcr/parsedTripNumber filter.
    const matchedIds = await findLoadIdsByFacets(ctx, {
      workosOrgId: load.workosOrgId,
      hcr: loadFacets.hcr,
      trip: loadFacets.trip,
    });
    const matchingLoads = (
      await Promise.all(matchedIds.map((id) => ctx.db.get(id)))
    ).filter(
      (l): l is Doc<"loadInformation"> => l !== null && l.loadType === "SPOT",
    );

    // 3. Bulk update all matching SPOT loads to CONTRACT
    const updatePromises = matchingLoads.map((matchingLoad) =>
      ctx.db.patch(matchingLoad._id, {
        loadType: "CONTRACT", // Promote from SPOT to CONTRACT
        requiresManualReview: false, // Clear flag
        updatedAt: Date.now(),
      })
    );

    await Promise.all(updatePromises);

    const loadsConverted = matchingLoads.length;
    const laneAction = existingLane ? "Using existing" : "Created";
    const message = loadsConverted === 1
      ? `${laneAction} contract lane for ${loadFacets.hcr}/${loadFacets.trip}. Load converted to CONTRACT.`
      : `${laneAction} contract lane for ${loadFacets.hcr}/${loadFacets.trip}. ${loadsConverted} loads converted to CONTRACT.`;

    return {
      success: true,
      message,
      loadsConverted,
    };
  },
});

/**
 * Count matching SPOT loads for bulk conversion preview
 */
export const countMatchingSpotLoads = query({
  args: {
    workosOrgId: v.string(),
    hcr: v.string(),
    tripNumber: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const matchedIds = await findLoadIdsByFacets(ctx, {
      workosOrgId: args.workosOrgId,
      hcr: args.hcr,
      trip: args.tripNumber,
    });
    const loads = (
      await Promise.all(matchedIds.map((id) => ctx.db.get(id)))
    ).filter(
      (l): l is Doc<"loadInformation"> => l !== null && l.loadType === "SPOT",
    );

    return loads.length;
  },
});

/**
 * Count loads requiring manual review for badge display
 */
export const countReviewNeeded = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const loads = await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .filter((q) => q.eq(q.field("requiresManualReview"), true))
      .collect();

    return loads.length;
  },
});
