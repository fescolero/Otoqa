import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { fetchShipments } from "./fourKitesApiClient";

// ------------------------------------------------------------------
// HELPER: STATUS MAPPING
// ------------------------------------------------------------------
function mapTrackingStatus(fkStatus: string): "Pending" | "In Transit" | "Completed" | "Delayed" | "Canceled" {
  const map: Record<string, "Pending" | "In Transit" | "Completed" | "Delayed" | "Canceled"> = {
    "PLANNED": "Pending",
    "IN_TRANSIT": "In Transit",
    "ARRIVED": "In Transit",
    "DELIVERED": "Completed",
    "COMPLETED": "Completed",
    "CANCELLED": "Canceled",
    "CANCELED": "Canceled"
  };
  return map[fkStatus] || "Pending";
}

// ------------------------------------------------------------------
// THE WORKER ACTION
// ------------------------------------------------------------------
export const processOrg = internalAction({
  args: {
    orgId: v.string(),
    integrationId: v.id("orgIntegrations"),
    credentials: v.any(),
    lookbackHours: v.number(),
  },
  handler: async (ctx, args) => {
    const { orgId, credentials, lookbackHours } = args;
    
    let processed = 0;
    let errors = 0;
    let quarantined = 0;
    let skipped = 0;
    let promoted = 0; // ✅ Track UNMAPPED → CONTRACT promotions during sync

    try {
      const startTime = new Date(Date.now() - (lookbackHours * 60 * 60 * 1000)).toISOString();

      // Fetch shipments from FourKites API (this can happen in an action)
      const shipments = await fetchShipments(credentials.apiKey, startTime);

      console.log(`FourKites: Fetched ${shipments.length} shipments for org ${orgId}`);

      for (const shipment of shipments) {
        try {
          // Skip shipments without HCR or Trip (can't match)
          if (!shipment.hcr || !shipment.trip) {
            console.log(`Skipping shipment ${shipment.id}: missing HCR or Trip`);
            skipped++;
            continue;
          }
          
          // STEP 1: Gate 1 - Try Exact Match (HCR + Trip)
          let laneMatch = await ctx.runMutation(internal.fourKitesSyncHelpers.findContractLane, {
            workosOrgId: orgId,
            hcr: shipment.hcr,
            tripNumber: shipment.trip,
          });

          let isWildcard = false;

          // STEP 2: Gate 2 - Try Wildcard Match (HCR + *)
          if (!laneMatch) {
            laneMatch = await ctx.runMutation(internal.fourKitesSyncHelpers.findContractLane, {
              workosOrgId: orgId,
              hcr: shipment.hcr,
              tripNumber: "*", // Wildcard for known customer
            });
            
            if (laneMatch) {
              isWildcard = true;
              console.log(`Wildcard match for HCR=${shipment.hcr}, Trip=${shipment.trip}`);
            }
          }

          // STEP 3: Gate 3 - No match? Create or update UNMAPPED load
          if (!laneMatch) {
            // Check if load already exists
            const existingLoad = await ctx.runMutation(internal.fourKitesSyncHelpers.findLoadByExternalId, {
              externalLoadId: shipment.id,
            });

            if (!existingLoad) {
              // Create UNMAPPED load with GPS tracking enabled + MISSING_DATA invoice
              await ctx.runMutation(internal.fourKitesSyncHelpers.importUnmappedLoad, {
                workosOrgId: orgId,
                shipment,
                createdBy: "FourKites Integration",
              });
              
              quarantined++; // Keep counter for reporting
            }
            // Note: If load exists as UNMAPPED, it will be promoted when:
            // 1. A lane is created via createLaneAndBackfill (immediately)
            // 2. The load is accessed via checkAndPromoteLoad (on-demand)
            continue;
          }

          // ✅ STEP 3.5: If lane NOW exists but load was UNMAPPED, promote it!
          // This handles the case where a lane is created AFTER the load was imported
          const unmappedLoad = await ctx.runMutation(internal.fourKitesSyncHelpers.findLoadByExternalId, {
            externalLoadId: shipment.id,
          });
          
          if (unmappedLoad && unmappedLoad.loadType === "UNMAPPED") {
            // Lane now exists! Promote this load
            await ctx.runMutation(internal.fourKitesSyncHelpers.promoteUnmappedLoad, {
              loadId: unmappedLoad._id,
              contractLane: laneMatch,
              isWildcard,
            });
            promoted++;
            continue;
          }

          // STEP 3: Find existing load
          const existingLoad = await ctx.runMutation(internal.fourKitesSyncHelpers.findLoadByExternalId, {
            externalLoadId: shipment.id,
          });

          // STEP 4: Skip if unchanged (✅ Change Detection Pattern)
          // Only patch if data actually changed - prevents unnecessary reactive query triggers
          if (existingLoad && existingLoad.lastExternalUpdatedAt === shipment.updated_at) {
            skipped++;
            continue;
          }

          // STEP 5: Prepare data
          const loadData = {
            lastExternalUpdatedAt: shipment.updated_at,
            updatedAt: Date.now(),
            weight: shipment.weight,
            commodityDescription: shipment.commodity,
            trackingStatus: mapTrackingStatus(shipment.status),
          };

          let loadId;

          if (existingLoad) {
            // UPDATE (only if data changed - verified by check above)
            loadId = await ctx.runMutation(internal.fourKitesSyncHelpers.updateLoad, {
              loadId: existingLoad._id,
              data: loadData,
            });

            // Handle cancellation
            if (shipment.status === 'CANCELED' || shipment.status === 'WITHDRAWN') {
              await ctx.runMutation(internal.fourKitesSyncHelpers.updateLoad, {
                loadId: existingLoad._id,
                data: { status: 'Canceled' },
              });
            }
          } else {
            // CREATE - Use shared import helper (creates load + DRAFT invoice)
            loadId = await ctx.runMutation(internal.fourKitesSyncHelpers.importLoadFromShipment, {
              workosOrgId: orgId,
              shipment,
              contractLane: laneMatch,
              createdBy: "FourKites Integration",
              isWildcard: isWildcard, // Pass wildcard flag for load classification
            });
          }

          // STEP 6: Sync stops (for UPDATE case only, CREATE handled by import helper)
          if (existingLoad) {
            const existingStops = await ctx.runMutation(internal.fourKitesSyncHelpers.getLoadStops, {
              loadId,
            });

            for (const stop of shipment.stops || []) {
              try {
                const stopId = stop.fourKitesStopID || stop.id;
                const appointmentTime = stop.schedule?.appointmentTime;
                
                const dbStop = existingStops.find(s => s.externalStopId === String(stopId));

                if (dbStop) {
                  // Update existing stop
                  await ctx.runMutation(internal.fourKitesSyncHelpers.updateStop, {
                    stopId: dbStop._id,
                    data: {
                      windowBeginTime: appointmentTime || dbStop.windowBeginTime,
                      windowEndTime: appointmentTime || dbStop.windowEndTime,
                      windowBeginDate: appointmentTime?.split('T')[0] || dbStop.windowBeginDate,
                      windowEndDate: appointmentTime?.split('T')[0] || dbStop.windowEndDate,
                      city: stop.city,
                      latitude: stop.latitude,
                      longitude: stop.longitude,
                      timeZone: stop.timeZone,
                    },
                  });
                }
              } catch (stopErr) {
                console.error(`Failed to update stop for shipment ${shipment.id}:`, stopErr);
              }
            }

            // Sync firstStopDate after stop updates (in case first stop's date changed)
            await ctx.runMutation(internal.loads.syncFirstStopDateMutation, { loadId });
          }

          processed++;
        } catch (innerErr) {
          console.error(`Failed shipment ${shipment?.id}:`, innerErr);
          errors++;
        }
      }
    } catch (err) {
      console.error("Sync Failure:", err);
      errors++;
    }

    // STEP 7: Update stats
    await ctx.runMutation(internal.fourKitesSyncHelpers.updateIntegrationStats, {
      integrationId: args.integrationId,
      stats: {
        lastSyncTime: Date.now(),
        lastSyncStatus: errors > 0 ? "partial" : "success",
        recordsProcessed: processed,
        errorMessage: errors > 0 ? `${errors} shipments failed to process` : undefined,
      },
    });

    console.log(`Sync Complete: ${processed} Processed, ${quarantined} Quarantined, ${promoted} Promoted, ${skipped} Skipped.`);

    // ✅ Promotion is now event-driven:
    // - During sync: UNMAPPED loads with matching lanes are promoted immediately
    // - When lanes are created: createLaneAndBackfill promotes matching loads
    // - When loads are accessed: checkAndPromoteLoad promotes if lane exists
  },
});
