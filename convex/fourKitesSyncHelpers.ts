/**
 * Helper queries and mutations for the FourKites sync worker.
 * Read-only lookups use internalQuery to avoid write-transaction overhead.
 * Only functions that modify data use internalMutation.
 */

import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { updateInvoiceCount, updateLoadCount } from "./stats_helpers";
import { recordLoadWritten } from "./platformUsageHelpers";
import { setLoadTag, getLoadFacets } from "./lib/loadFacets";
import { refreshInvoiceSearchText } from "./invoiceSearchText";
import { syncLegsAffectedByStop } from "./_helpers/timeUtils";
import {
  buildLoadInternalId,
  buildStopRecord,
  computeLaneBilling,
  laneAddressesByPosition,
  mapTrackingStatus,
  metersToMiles,
} from "./fourKitesUtils";
import { laneBindingsByPosition } from "./lib/facilityMatch";
import { getActiveFacilities, resolveStopFacilityLink } from "./lib/facilityLink";

// Read-only lane lookup using the compound index (reads ~1 doc instead of full table scan)
export const findContractLane = internalQuery({
  args: {
    workosOrgId: v.string(),
    hcr: v.string(),
    tripNumber: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("contractLanes")
      .withIndex("by_org_hcr_trip", (q) =>
        q
          .eq("workosOrgId", args.workosOrgId)
          .eq("hcr", args.hcr)
          .eq("tripNumber", args.tripNumber)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("isDeleted"), false),
          q.eq(q.field("isActive"), true)
        )
      )
      .first();
  },
});

// Stamp import match metadata on a lane after a successful match
export const stampLaneMatch = internalMutation({
  args: {
    laneId: v.id("contractLanes"),
  },
  handler: async (ctx, args) => {
    const lane = await ctx.db.get(args.laneId);
    if (lane) {
      await ctx.db.patch(lane._id, {
        lastImportMatchAt: Date.now(),
        importMatchCount: (lane.importMatchCount ?? 0) + 1,
      });
    }
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

    // Seed the search haystack (order # + customer; no number until billed).
    await refreshInvoiceSearchText(ctx, invoiceId);

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

// Read-only load lookup by external ID
export const findLoadByExternalId = internalQuery({
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

    // ✅ Platform billing: every load written into the system is billable.
    // args.data is v.any() — only trust createdAt when it's a real number.
    await recordLoadWritten(
      ctx,
      args.data.workosOrgId,
      typeof args.data.createdAt === "number" ? args.data.createdAt : Date.now(),
    );
    
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

// Read-only stop lookup for a load
export const getLoadStops = internalQuery({
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
    // If the patch touched the window's begin date/time, refresh cached
    // scheduled times on every leg that references this stop.
    const data = args.data as Record<string, unknown> | null | undefined;
    if (
      data &&
      (Object.prototype.hasOwnProperty.call(data, "windowBeginDate") ||
        Object.prototype.hasOwnProperty.call(data, "windowBeginTime"))
    ) {
      await syncLegsAffectedByStop(ctx, args.stopId);
    }
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

// Read-only customer name lookup
export const getCustomerName = internalQuery({
  args: {
    customerId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    const customer = await ctx.db.get(args.customerId);
    return customer?.name || "Unknown Customer";
  },
});

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

    // Miles + billing math (DOE_INDEX would need an external call, skipped).
    const importedMiles = metersToMiles(shipment.totalDistanceInMeters);
    const stopCount = shipment.stops?.length || 0;
    const billing = computeLaneBilling({ contractLane, stopCount, importedMiles });
    const effectiveMiles = billing.effectiveMiles;

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
      // HCR / TRIP are written only as loadTags via setLoadTag below.
      externalReferenceNumbers: shipment.referenceNumbers,
      status: "Open",
      ...loadData,
      internalId: buildLoadInternalId(shipment),
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

    // ✅ Platform billing: every load written into the system is billable
    await recordLoadWritten(ctx, workosOrgId, Date.now());

    const internalId = buildLoadInternalId(shipment);
    // FK stop payloads usually carry no street address; the contract lane's
    // stop plan does (typed by dispatch or extracted from the HCR schedule).
    // Inherit by position when the two lists align (see laneAddressesByPosition).
    const shipmentStops = shipment.stops || [];
    const laneAddresses = laneAddressesByPosition(contractLane.stops, shipmentStops);
    // Facility registry: lane bindings win by position; unbound stops fall
    // back to proximity matching against the customer's facilities. A
    // VERIFIED facility's pin replaces FK's (often centroid) coordinates.
    const facilities = await getActiveFacilities(ctx, contractLane.customerCompanyId);
    const laneBindings = laneBindingsByPosition(contractLane.stops, shipmentStops);
    for (let i = 0; i < shipmentStops.length; i++) {
      const stop = shipmentStops[i];
      try {
        const record = buildStopRecord({
          workosOrgId,
          loadId: loadId as Id<"loadInformation">,
          internalId,
          stop,
          commodityDescription: shipment.commodity,
          fallbackAddress: laneAddresses[i],
        });
        const link = resolveStopFacilityLink(
          {
            city: stop.city,
            state: stop.state,
            postalCode: stop.postalCode,
            latitude: stop.latitude,
            longitude: stop.longitude,
          },
          facilities,
          laneBindings[i],
        );
        if (link) Object.assign(record, link);
        await ctx.db.insert("loadStops", record as any);
      } catch (stopErr) {
        console.error(`Failed to create stop for shipment ${shipment.id}:`, stopErr);
        // Don't throw - continue with other stops
      }
    }

    // Register HCR / TRIP facet tags. firstStopDate is filled in by the
    // subsequent syncFirstStopDateMutation via syncFirstStopDateToTags.
    await setLoadTag(ctx, {
      loadId: loadId as Id<"loadInformation">,
      workosOrgId,
      facetKey: "HCR",
      value: shipment.hcr,
      source: "LOAD_FOURKITES",
    });
    await setLoadTag(ctx, {
      loadId: loadId as Id<"loadInformation">,
      workosOrgId,
      facetKey: "TRIP",
      value: shipment.trip,
      source: "LOAD_FOURKITES",
    });

    // Sync firstStopDate after all stops are created
    await ctx.runMutation(internal.loads.syncFirstStopDateMutation, { loadId });

    // Create invoice with DRAFT status (lane matched)
    // Store contract lane reference - amounts will be calculated dynamically
    const draftInvoiceId = await ctx.db.insert("loadInvoices", {
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

    // Seed the search haystack (order # + customer; no number until billed).
    await refreshInvoiceSearchText(ctx, draftInvoiceId);

    // ✅ Update organization stats for invoice creation
    await updateInvoiceCount(ctx, workosOrgId, undefined, "DRAFT");

    // Note: Line items are no longer created during import
    // They will be calculated dynamically when querying the invoice

    // Trigger auto-assignment for FourKites loads with parsedHcr
    if (shipment.hcr) {
      try {
        await ctx.runMutation(internal.autoAssignment.triggerAutoAssignmentForLoad, {
          loadId: loadId as Id<"loadInformation">,
          workosOrgId,
          userId: "fourkites-sync",
          userName: "FourKites Sync",
        });
      } catch (error) {
        console.error("Auto-assignment failed for FourKites load:", error);
      }
    }

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

    const importedMiles = metersToMiles(shipment.totalDistanceInMeters);
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
      internalId: buildLoadInternalId(shipment),
      orderNumber: shipment.loadNumber || shipment.id,
      status: "Open",
      trackingStatus: mapTrackingStatus(shipment.status),
      
      // HCR / TRIP stored only via setLoadTag (loadTags table).
      externalReferenceNumbers: shipment.referenceNumbers,

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

    // ✅ Platform billing: every load written into the system is billable
    await recordLoadWritten(ctx, workosOrgId, Date.now());

    const internalId = buildLoadInternalId(shipment);
    for (const stop of shipment.stops || []) {
      try {
        await ctx.db.insert(
          "loadStops",
          buildStopRecord({
            workosOrgId,
            loadId: loadId as Id<"loadInformation">,
            internalId,
            stop,
            commodityDescription: shipment.commodity,
          }) as any,
        );
      } catch (stopErr) {
        console.error(`Failed to create stop for unmapped shipment ${shipment.id}:`, stopErr);
      }
    }

    // Register HCR / TRIP facet tags. firstStopDate is filled in by the
    // subsequent syncFirstStopDateMutation via syncFirstStopDateToTags.
    await setLoadTag(ctx, {
      loadId: loadId as Id<"loadInformation">,
      workosOrgId,
      facetKey: "HCR",
      value: shipment.hcr,
      source: "LOAD_FOURKITES",
    });
    await setLoadTag(ctx, {
      loadId: loadId as Id<"loadInformation">,
      workosOrgId,
      facetKey: "TRIP",
      value: shipment.trip,
      source: "LOAD_FOURKITES",
    });

    // Sync firstStopDate after all stops are created
    await ctx.runMutation(internal.loads.syncFirstStopDateMutation, { loadId });

    // Create invoice with MISSING_DATA status (no lane match)
    // No contractLaneId - amounts will be $0 when calculated
    const missingInvoiceId = await ctx.db.insert("loadInvoices", {
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

    // Seed the search haystack (order # + customer; no number until billed).
    await refreshInvoiceSearchText(ctx, missingInvoiceId);

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
      const stopCount = load.stopCount || 2;
      const billing = computeLaneBilling({
        contractLane,
        stopCount,
        fallbackContractMiles: load.contractMiles,
      });

      await ctx.db.patch(invoice._id, {
        status: "DRAFT",
        customerId: contractLane.customerCompanyId,
        contractLaneId: contractLane._id,
        subtotal: billing.subtotal,
        fuelSurcharge: billing.fuelSurcharge > 0 ? billing.fuelSurcharge : undefined,
        accessorialsTotal: billing.stopOffCharges > 0 ? billing.stopOffCharges : undefined,
        totalAmount: billing.totalAmount,
        missingDataReason: undefined, // Clear error
        updatedAt: Date.now(),
      });

      // ✅ Update organization stats (MISSING_DATA → DRAFT)
      await updateInvoiceCount(ctx, load.workosOrgId, "MISSING_DATA", "DRAFT");
    }

    // Facility matching was skipped while the load was UNMAPPED (its
    // placeholder customer has no facilities). Now that the real customer
    // is known, re-run it over stops the driver hasn't reached yet.
    try {
      const promotedStops = await ctx.db
        .query("loadStops")
        .withIndex("by_load", (q) => q.eq("loadId", loadId))
        .collect();
      const facilities = await getActiveFacilities(ctx, contractLane.customerCompanyId);
      const laneBindings = laneBindingsByPosition(
        contractLane.stops,
        promotedStops.map((s) => ({ sequence: s.sequenceNumber, city: s.city })),
      );
      for (let i = 0; i < promotedStops.length; i++) {
        const stop = promotedStops[i];
        if (stop.facilityId || stop.checkedInAt || (stop.status && stop.status !== "Pending")) {
          continue;
        }
        const link = resolveStopFacilityLink(
          {
            city: stop.city,
            state: stop.state,
            postalCode: stop.postalCode,
            latitude: stop.latitude,
            longitude: stop.longitude,
          },
          facilities,
          laneBindings[i],
        );
        if (link) {
          await ctx.db.patch(stop._id, { ...link, updatedAt: Date.now() });
        }
      }
    } catch (facilityErr) {
      // Facility linking is best-effort — never fail a promotion over it.
      console.error(`[promoteUnmappedLoad] Facility re-match failed for ${loadId}:`, facilityErr);
    }

    // Stamp the contract lane with import match metadata
    const laneId = contractLane._id as Id<"contractLanes">;
    const freshLane = await ctx.db.get(laneId);
    if (freshLane) {
      await ctx.db.patch(laneId, {
        lastImportMatchAt: Date.now(),
        importMatchCount: (freshLane.importMatchCount ?? 0) + 1,
      });
    }

    // Trigger auto-assignment after promotion (load now has proper HCR).
    // Read HCR from tags (Phase 5 will drop the column).
    const promotedFacets = await getLoadFacets(ctx, loadId);
    if (promotedFacets.hcr && load.status === "Open" && !load.primaryDriverId && !load.primaryCarrierPartnershipId) {
      try {
        await ctx.runMutation(internal.autoAssignment.triggerAutoAssignmentForLoad, {
          loadId,
          workosOrgId: load.workosOrgId,
          userId: "fourkites-sync",
          userName: "FourKites Sync (Promotion)",
        });
      } catch (error) {
        console.error("Auto-assignment failed for promoted load:", error);
      }
    }

    console.log(`[promoteUnmappedLoad] Promoted load ${loadId} from UNMAPPED to ${isWildcard ? "SPOT" : "CONTRACT"}`);
    return { promoted: true, newType: isWildcard ? "SPOT" : "CONTRACT" };
  },
});
