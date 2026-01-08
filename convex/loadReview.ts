/**
 * Load Review Mutations and Queries
 * Handles the "Spot Review" workflow for loads that matched wildcard lanes
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

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
    const load = await ctx.db.get(args.loadId);
    if (!load) {
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
    const load = await ctx.db.get(args.loadId);
    if (!load) {
      throw new Error("Load not found");
    }

    if (!load.parsedHcr || !load.parsedTripNumber) {
      throw new Error("Cannot convert: Load missing HCR or Trip information");
    }

    // Check if specific lane already exists
    const existingLane = await ctx.db
      .query("contractLanes")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", load.workosOrgId))
      .filter((q) =>
        q.and(
          q.eq(q.field("hcr"), load.parsedHcr),
          q.eq(q.field("tripNumber"), load.parsedTripNumber),
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
        hcr: load.parsedHcr,
        tripNumber: load.parsedTripNumber,
        contractName: args.contractName || `Lane: ${customer.name} - ${load.parsedTripNumber}`,
        contractPeriodStart: today,
        contractPeriodEnd,
        rateType: (args.rateType || "Flat Rate") as "Per Mile" | "Flat Rate" | "Per Stop",
        rate: args.rate ?? 0,
        currency: "USD" as const, // Default to USD
        miles: load.contractMiles,
        stops: [], // Empty - can be filled later
        isActive: true,
        isDeleted: false,
        createdBy: args.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // 2. Find ALL existing loads with the same HCR+Trip that are SPOT
    const matchingLoads = await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", load.workosOrgId))
      .filter((q) =>
        q.and(
          q.eq(q.field("parsedHcr"), load.parsedHcr),
          q.eq(q.field("parsedTripNumber"), load.parsedTripNumber),
          q.eq(q.field("loadType"), "SPOT")
        )
      )
      .collect();

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
      ? `${laneAction} contract lane for ${load.parsedHcr}/${load.parsedTripNumber}. Load converted to CONTRACT.`
      : `${laneAction} contract lane for ${load.parsedHcr}/${load.parsedTripNumber}. ${loadsConverted} loads converted to CONTRACT.`;

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
    const loads = await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .filter((q) =>
        q.and(
          q.eq(q.field("parsedHcr"), args.hcr),
          q.eq(q.field("parsedTripNumber"), args.tripNumber),
          q.eq(q.field("loadType"), "SPOT")
        )
      )
      .collect();

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
    const loads = await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .filter((q) => q.eq(q.field("requiresManualReview"), true))
      .collect();

    return loads.length;
  },
});
