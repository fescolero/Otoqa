/**
 * Helper mutations for the FourKites sync worker
 * Actions can't directly access the database, so we need these mutations
 */

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { updateInvoiceCount, updateLoadCount } from "./stats_helpers";

// Find contract lane by HCR and trip, stamping import match metadata
export const findContractLane = internalMutation({
  args: {
    workosOrgId: v.string(),
    hcr: v.string(),
    tripNumber: v.string(),
  },
  handler: async (ctx, args) => {
    const lane = await ctx.db
      .query("contractLanes")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .filter((q) =>
        q.and(
          q.eq(q.field("hcr"), args.hcr),
          q.eq(q.field("tripNumber"), args.tripNumber)
        )
      )
      .first();

    if (lane) {
      await ctx.db.patch(lane._id, {
        lastImportMatchAt: Date.now(),
        importMatchCount: (lane.importMatchCount ?? 0) + 1,
      });
    }

    return lane;
  },
});

// Create invoice with line items
export const createInvoice = internalMutation({
  args: {
    loadId: v.id("loadInformation"),
    customerId: v.id("customers"),
    workosOrgId: v.string(),
    status: v.union(
      v.literal("MISSING_DATA"),
      v.literal("DRAFT"),
      v.literal("BILLED"),
      v.literal("PENDING_PAYMENT"),
      v.literal("PAID"),
      v.literal("VOID")
    ),
    currency: v.union(v.literal("USD"), v.literal("CAD"), v.literal("MXN")),
    subtotal: v.number(),
    fuelSurcharge: v.optional(v.number()),
    accessorialsTotal: v.optional(v.number()),
    taxAmount: v.optional(v.number()),
    totalAmount: v.number(),
    missingDataReason: v.optional(v.string()),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const invoiceId = await ctx.db.insert("loadInvoices", {
      ...args,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    
    // ✅ Update organization stats (aggregate table pattern)
    await updateInvoiceCount(ctx, args.workosOrgId, undefined, args.status);
    
    return invoiceId;
  },
});

// Create invoice line item
export const createInvoiceLineItem = internalMutation({
  args: {
    invoiceId: v.id("loadInvoices"),
    type: v.union(
      v.literal("FREIGHT"),
      v.literal("FUEL"),
      v.literal("ACCESSORIAL"),
      v.literal("TAX")
    ),
    description: v.string(),
    quantity: v.number(),
    rate: v.number(),
    amount: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("invoiceLineItems", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

// Find existing load by external ID
export const findLoadByExternalId = internalMutation({
  args: {
    externalLoadId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("loadInformation")
      .withIndex("by_external_id", (q) =>
        q.eq("externalSource", "FourKites").eq("externalLoadId", args.externalLoadId)
      )
      .first();
  },
});

// Update existing load
export const updateLoad = internalMutation({
  args: {
    loadId: v.id("loadInformation"),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.loadId, args.data);
    return args.loadId;
  },
});

// Create new load
export const createLoad = internalMutation({
  args: {
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const loadId = await ctx.db.insert("loadInformation", args.data);
    
    // ✅ Update organization stats (aggregate table pattern)
    await updateLoadCount(ctx, args.data.workosOrgId, undefined, args.data.status);
    
    // ✅ Trigger auto-assignment for FourKites loads
    // FourKites loads come in with parsedHcr already set
    if (args.data.parsedHcr) {
      try {
        await ctx.runMutation(internal.autoAssignment.triggerAutoAssignmentForLoad, {
          loadId: loadId as Id<"loadInformation">,
          workosOrgId: args.data.workosOrgId,
          userId: "fourkites-sync",
          userName: "FourKites Sync",
        });
      } catch (error) {
        // Log but don't fail load creation
        console.error("Auto-assignment failed for FourKites load:", error);
      }
    }
    
    return loadId;
  },
});

// Get existing stops for a load
export const getLoadStops = internalMutation({
  args: {
    loadId: v.id("loadInformation"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("loadStops")
      .withIndex("by_load", (q) => q.eq("loadId", args.loadId))
      .collect();
  },
});

// Update stop
export const updateStop = internalMutation({
  args: {
    stopId: v.id("loadStops"),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.stopId, args.data);
  },
});

// Create new stop
export const createStop = internalMutation({
  args: {
    data: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("loadStops", args.data);
  },
});

// Get customer name by ID
export const getCustomerName = internalMutation({
  args: {
    customerId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    const customer = await ctx.db.get(args.customerId);
    return customer?.name || "Unknown Customer";
  },
});

// Helper to map tracking status
function mapTrackingStatus(status: string): "Pending" | "In Transit" | "Completed" | "Delayed" | "Canceled" {
  const statusMap: Record<string, "Pending" | "In Transit" | "Completed" | "Delayed" | "Canceled"> = {
    'DELIVERED': 'Completed',
    'IN_TRANSIT': 'In Transit',
    'DELAYED': 'Delayed',
    'CANCELED': 'Canceled',
    'WITHDRAWN': 'Canceled',
  };
  return statusMap[status] || 'Pending';
}

// Import load and stops from FourKites shipment
// This is the single source of truth for creating loads from FourKites data
export const importLoadFromShipment = internalMutation({
  args: {
    workosOrgId: v.string(),
    shipment: v.any(), // FourKites shipment object
    contractLane: v.any(), // Contract lane object with customer, rate, etc.
    createdBy: v.string(),
    isWildcard: v.optional(v.boolean()), // True if matched via wildcard (*)
  },
  handler: async (ctx, args) => {
    const { workosOrgId, shipment, contractLane, createdBy, isWildcard } = args;

    // Fetch customer name
    const customer = await ctx.db.get(contractLane.customerCompanyId);
    if (!customer || !('name' in customer)) {
      throw new Error("Customer not found");
    }
    const customerName = customer.name;

    // Calculate imported miles from FourKites data first
    const importedMiles = shipment.totalDistanceInMeters
      ? Math.round((shipment.totalDistanceInMeters * 0.000621371) * 100) / 100
      : undefined;

    // Calculate effective miles for billing: contract > imported
    const effectiveMiles = contractLane.miles ?? importedMiles;

    // Calculate billing amounts for invoice
    const stopCount = shipment.stops?.length || 0;
    
    let baseRate = 0;
    if (contractLane.rateType === "Per Mile" && effectiveMiles) {
      baseRate = contractLane.rate * effectiveMiles;
    } else if (contractLane.rateType === "Flat Rate") {
      baseRate = contractLane.rate;
    } else if (contractLane.rateType === "Per Stop") {
      baseRate = contractLane.rate * stopCount;
    }

    // Calculate stop-off charges (accessorials)
    const includedStops = contractLane.includedStops || 2;
    const extraStops = Math.max(0, stopCount - includedStops);
    const stopOffCharges = extraStops * (contractLane.stopOffRate || 0);

    // Calculate fuel surcharge
    let fuelSurcharge = 0;
    if (contractLane.fuelSurchargeType === "PERCENTAGE") {
      fuelSurcharge = baseRate * ((contractLane.fuelSurchargeValue || 0) / 100);
    } else if (contractLane.fuelSurchargeType === "FLAT") {
      fuelSurcharge = contractLane.fuelSurchargeValue || 0;
    }
    // DOE_INDEX calculation would require external API call - skip for now

    // Calculate totals for invoice
    const subtotal = baseRate;
    const accessorialsTotal = stopOffCharges;
    const totalAmount = subtotal + fuelSurcharge + accessorialsTotal;

    // Prepare load data
    const loadData = {
      lastExternalUpdatedAt: shipment.updated_at,
      updatedAt: Date.now(),
      weight: shipment.weight,
      commodityDescription: shipment.commodity,
      trackingStatus: mapTrackingStatus(shipment.status),
    };

    // Create load (operations data only - no billing)
    const loadId = await ctx.db.insert("loadInformation", {
      workosOrgId,
      customerId: contractLane.customerCompanyId,
      customerName,
      externalLoadId: shipment.id,
      externalSource: "FourKites",
      parsedHcr: shipment.hcr,
      parsedTripNumber: shipment.trip,
      status: "Open",
      ...loadData,
      internalId: `FK-${shipment.loadNumber || shipment.id}`,
      orderNumber: shipment.loadNumber || shipment.id,
      createdBy,
      createdAt: Date.now(),
      fleet: "Default",
      contractMiles: contractLane.miles,
      importedMiles, // Miles from FourKites
      effectiveMiles, // Already calculated above: contract > imported
      lastMilesUpdate: effectiveMiles ? new Date().toISOString() : undefined,
      units: "Pieces",
      // Load classification based on match type
      loadType: isWildcard ? "SPOT" : "CONTRACT",
      requiresManualReview: isWildcard || false, // Flag wildcard matches for review
      isTracking: true, // GPS active
      stopCount,
    });

    // ✅ Update organization stats for load creation
    await updateLoadCount(ctx, workosOrgId, undefined, "Open");

    // Create stops
    for (const stop of shipment.stops || []) {
      try {
        const stopId = stop.fourKitesStopID || stop.id;
        const appointmentTime = stop.schedule?.appointmentTime;

        await ctx.db.insert("loadStops", {
          workosOrgId,
          loadId,
          createdBy: "FourKites",
          internalId: `FK-${shipment.loadNumber || shipment.id}`,
          externalStopId: String(stopId),
          sequenceNumber: stop.sequence,
          stopType: stop.stopType, // 'PICKUP' or 'DELIVERY'
          loadingType: "APPT",
          address: "", // Leave empty - will be populated from another source
          city: stop.city,
          state: stop.state,
          postalCode: stop.postalCode,
          latitude: stop.latitude,
          longitude: stop.longitude,
          timeZone: stop.timeZone,
          windowBeginDate: appointmentTime?.split("T")[0] || "TBD",
          windowBeginTime: appointmentTime || "TBD",
          windowEndDate: appointmentTime?.split("T")[0] || "TBD",
          windowEndTime: appointmentTime || "TBD",
          status: "Pending",
          commodityDescription: shipment.commodity || "",
          commodityUnits: "Pieces",
          pieces: stop.pallets?.[0]?.parts?.[0]?.quantity ? parseInt(stop.pallets[0].parts[0].quantity) : 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      } catch (stopErr) {
        console.error(`Failed to create stop for shipment ${shipment.id}:`, stopErr);
        // Don't throw - continue with other stops
      }
    }

    // Sync firstStopDate after all stops are created
    await ctx.runMutation(internal.loads.syncFirstStopDateMutation, { loadId });

    // Create invoice with DRAFT status (lane matched)
    // Store contract lane reference - amounts will be calculated dynamically
    await ctx.db.insert("loadInvoices", {
      loadId,
      customerId: contractLane.customerCompanyId,
      contractLaneId: contractLane._id, // Reference for dynamic calculation
      workosOrgId,
      status: "DRAFT", // Matched lane, awaiting review
      currency: contractLane.currency || "USD",
      // Amounts are NOT stored for DRAFT - calculated on-the-fly from load + contract lane
      createdBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // ✅ Update organization stats for invoice creation
    await updateInvoiceCount(ctx, workosOrgId, undefined, "DRAFT");

    // Note: Line items are no longer created during import
    // They will be calculated dynamically when querying the invoice

    return loadId;
  },
});

// Update integration stats
export const updateIntegrationStats = internalMutation({
  args: {
    integrationId: v.id("orgIntegrations"),
    stats: v.object({
      lastSyncTime: v.number(),
      lastSyncStatus: v.string(),
      recordsProcessed: v.number(),
      errorMessage: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.integrationId, {
      lastSyncStats: args.stats,
    });
  },
});

// Import UNMAPPED load (no contract lane exists)
export const importUnmappedLoad = internalMutation({
  args: {
    workosOrgId: v.string(),
    shipment: v.any(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const { workosOrgId, shipment, createdBy } = args;

    // Try to find a customer by shipper name
    // If no customer exists, use a default "Unmapped Customer" placeholder
    let customerId;
    let customerName = shipment.shipper_name || "Unknown";
    
    const potentialCustomer = await ctx.db
      .query("customers")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", workosOrgId))
      .filter((q) => q.eq(q.field("name"), customerName))
      .first();

    if (potentialCustomer) {
      customerId = potentialCustomer._id;
    } else {
      // Create placeholder customer
      customerId = await ctx.db.insert("customers", {
        name: customerName,
        companyType: "Shipper",
        status: "Prospect",
        addressLine1: "TBD",
        city: "TBD",
        state: "TBD",
        zip: "00000",
        country: "USA",
        workosOrgId,
        createdBy: "System",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isDeleted: false,
      });
    }

    // Calculate imported miles from FourKites data
    const importedMiles = shipment.totalDistanceInMeters
      ? Math.round((shipment.totalDistanceInMeters * 0.000621371) * 100) / 100
      : undefined;

    // Create load with UNMAPPED status (ops data only)
    const stopCount = shipment.stops?.length || 0;
    
    const loadId = await ctx.db.insert("loadInformation", {
      workosOrgId,
      customerId,
      customerName,
      
      // External Integration
      externalSource: "FourKites",
      externalLoadId: shipment.id,
      lastExternalUpdatedAt: shipment.updated_at,
      
      // Basic Information
      internalId: `FK-${shipment.loadNumber || shipment.id}`,
      orderNumber: shipment.loadNumber || shipment.id,
      status: "Open",
      trackingStatus: mapTrackingStatus(shipment.status),
      
      // Parsed Data
      parsedHcr: shipment.hcr,
      parsedTripNumber: shipment.trip,
      
      // Load Classification
      loadType: "UNMAPPED",          // No billing lane yet
      requiresManualReview: true,
      isTracking: true,              // ✅ GPS active
      stopCount,
      
      // Commodity (Physical Data)
      commodityDescription: shipment.commodity,
      weight: shipment.weight,
      units: "Pieces",
      
      // Miles (only imported, no contract)
      importedMiles,
      effectiveMiles: importedMiles,
      lastMilesUpdate: importedMiles ? new Date().toISOString() : undefined,
      
      // Metadata
      fleet: "Default",
      createdBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // ✅ Update organization stats for unmapped load creation
    await updateLoadCount(ctx, workosOrgId, undefined, "Open");

    // Create stops (same as CONTRACT/SPOT loads)
    for (const stop of shipment.stops || []) {
      try {
        const stopId = stop.fourKitesStopID || stop.id;
        const appointmentTime = stop.schedule?.appointmentTime;

        await ctx.db.insert("loadStops", {
          workosOrgId,
          loadId,
          createdBy: "FourKites",
          internalId: `FK-${shipment.loadNumber || shipment.id}`,
          externalStopId: String(stopId),
          sequenceNumber: stop.sequence,
          stopType: stop.stopType,
          loadingType: "APPT",
          address: "",
          city: stop.city,
          state: stop.state,
          postalCode: stop.postalCode,
          latitude: stop.latitude,
          longitude: stop.longitude,
          timeZone: stop.timeZone,
          windowBeginDate: appointmentTime?.split("T")[0] || "TBD",
          windowBeginTime: appointmentTime || "TBD",
          windowEndDate: appointmentTime?.split("T")[0] || "TBD",
          windowEndTime: appointmentTime || "TBD",
          status: "Pending",
          commodityDescription: shipment.commodity || "",
          commodityUnits: "Pieces",
          pieces: stop.pallets?.[0]?.parts?.[0]?.quantity ? parseInt(stop.pallets[0].parts[0].quantity) : 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      } catch (stopErr) {
        console.error(`Failed to create stop for unmapped shipment ${shipment.id}:`, stopErr);
      }
    }

    // Sync firstStopDate after all stops are created
    await ctx.runMutation(internal.loads.syncFirstStopDateMutation, { loadId });

    // Create invoice with MISSING_DATA status (no lane match)
    // No contractLaneId - amounts will be $0 when calculated
    await ctx.db.insert("loadInvoices", {
      loadId,
      customerId,
      contractLaneId: undefined, // No contract lane
      workosOrgId,
      status: "MISSING_DATA", // No contract lane found
      currency: "USD", // Default currency
      // Amounts NOT stored - will return $0 when calculated dynamically
      missingDataReason: `No contract lane found for HCR: ${shipment.hcr}, Trip: ${shipment.trip}`,
      createdBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // ✅ Update organization stats for unmapped invoice creation
    await updateInvoiceCount(ctx, workosOrgId, undefined, "MISSING_DATA");

    return loadId;
  },
});

/**
 * Promote an UNMAPPED load to CONTRACT/SPOT when a matching lane is found during sync
 * This handles the case where a lane is created AFTER the load was imported
 */
export const promoteUnmappedLoad = internalMutation({
  args: {
    loadId: v.id("loadInformation"),
    contractLane: v.any(), // The matching contract lane
    isWildcard: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { loadId, contractLane, isWildcard } = args;
    
    const load = await ctx.db.get(loadId);
    if (!load) {
      console.error(`[promoteUnmappedLoad] Load ${loadId} not found`);
      return { promoted: false, reason: "Load not found" };
    }
    
    if (load.loadType !== "UNMAPPED") {
      // Already promoted or not unmapped
      return { promoted: false, reason: `Load is ${load.loadType}, not UNMAPPED` };
    }

    // Get customer name
    const customer = await ctx.db.get(contractLane.customerCompanyId);
    const customerName = customer && 'name' in customer ? customer.name : "Unknown";

    // Update load to CONTRACT or SPOT
    await ctx.db.patch(loadId, {
      loadType: isWildcard ? "SPOT" : "CONTRACT",
      customerId: contractLane.customerCompanyId,
      customerName,
      requiresManualReview: isWildcard, // SPOT loads need manual review
      updatedAt: Date.now(),
    });

    // ✅ Update load stats (UNMAPPED doesn't have a status count, but we track load types separately)
    
    // Update invoice from MISSING_DATA to DRAFT
    const invoice = await ctx.db
      .query("loadInvoices")
      .withIndex("by_load", (q) => q.eq("loadId", loadId))
      .first();

    if (invoice && invoice.status === "MISSING_DATA") {
      // Calculate billing amounts
      const stopCount = load.stopCount || 2;
      const includedStops = contractLane.includedStops || 2;
      const extraStops = Math.max(0, stopCount - includedStops);
      const effectiveMiles = contractLane.miles ?? load.contractMiles;

      let baseRate = 0;
      if (contractLane.rateType === "Per Mile" && effectiveMiles) {
        baseRate = contractLane.rate * effectiveMiles;
      } else if (contractLane.rateType === "Flat Rate") {
        baseRate = contractLane.rate;
      } else if (contractLane.rateType === "Per Stop") {
        baseRate = contractLane.rate * stopCount;
      }

      let fuelSurcharge = 0;
      if (contractLane.fuelSurchargeType === "PERCENTAGE" && contractLane.fuelSurchargeValue) {
        fuelSurcharge = baseRate * (contractLane.fuelSurchargeValue / 100);
      } else if (contractLane.fuelSurchargeType === "FLAT" && contractLane.fuelSurchargeValue) {
        fuelSurcharge = contractLane.fuelSurchargeValue;
      }

      const stopOffCharges = extraStops * (contractLane.stopOffRate || 0);
      const subtotal = baseRate;
      const totalAmount = subtotal + fuelSurcharge + stopOffCharges;

      await ctx.db.patch(invoice._id, {
        status: "DRAFT",
        customerId: contractLane.customerCompanyId,
        contractLaneId: contractLane._id,
        subtotal,
        fuelSurcharge: fuelSurcharge > 0 ? fuelSurcharge : undefined,
        accessorialsTotal: stopOffCharges > 0 ? stopOffCharges : undefined,
        totalAmount,
        missingDataReason: undefined, // Clear error
        updatedAt: Date.now(),
      });

      // ✅ Update organization stats (MISSING_DATA → DRAFT)
      await updateInvoiceCount(ctx, load.workosOrgId, "MISSING_DATA", "DRAFT");
    }

    // Stamp the contract lane with import match metadata
    const freshLane = await ctx.db.get(contractLane._id);
    if (freshLane) {
      await ctx.db.patch(freshLane._id, {
        lastImportMatchAt: Date.now(),
        importMatchCount: (freshLane.importMatchCount ?? 0) + 1,
      });
    }

    console.log(`[promoteUnmappedLoad] Promoted load ${loadId} from UNMAPPED to ${isWildcard ? "SPOT" : "CONTRACT"}`);
    return { promoted: true, newType: isWildcard ? "SPOT" : "CONTRACT" };
  },
});
