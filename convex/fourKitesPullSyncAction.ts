import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { fetchShipments } from "./fourKitesApiClient";

type FailureStage = "fetch" | "process";

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

function extractErrorReason(error: unknown): string {
  if (error instanceof Error) {
    const firstLine = error.message.trim().split("\n")[0];
    return firstLine || error.name || "Unknown error";
  }
  if (typeof error === "string") {
    return error.trim().split("\n")[0] || "Unknown error";
  }
  return "Unknown error";
}

function normalizeFailureKey(reason: string): string {
  // Remove long numeric IDs to make bucketing more useful.
  return reason.replace(/\b\d{6,}\b/g, "<id>").slice(0, 160);
}

function resolveApiKey(credentials: unknown): string | null {
  if (!credentials) {
    return null;
  }

  if (typeof credentials === "string") {
    try {
      const parsed = JSON.parse(credentials);
      if (parsed && typeof parsed === "object" && typeof (parsed as { apiKey?: unknown }).apiKey === "string") {
        const apiKeyFromJson = (parsed as { apiKey: string }).apiKey.trim();
        return apiKeyFromJson || null;
      }
    } catch {
      const rawValue = credentials.trim();
      return rawValue || null;
    }
    return null;
  }

  if (typeof credentials === "object" && typeof (credentials as { apiKey?: unknown }).apiKey === "string") {
    const apiKey = (credentials as { apiKey: string }).apiKey.trim();
    return apiKey || null;
  }

  return null;
}

function buildSuggestedActions(topReason: string | undefined): string[] {
  const actions = new Set<string>();
  const normalized = topReason?.toLowerCase() || "";

  if (
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("401") ||
    normalized.includes("403")
  ) {
    actions.add("Verify your FourKites API key and account permissions in Configure.");
  }

  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    actions.add("Reduce lookback window (for example 24-72 hours) and retry the sync.");
  }

  if (normalized.includes("customer not found")) {
    actions.add("Confirm all referenced customers exist and are active in your organization.");
  }

  actions.add("Review affected shipment IDs below and verify HCR/Trip lane mappings.");
  actions.add("Retry sync after updating configuration or mappings.");

  return Array.from(actions).slice(0, 3);
}

function buildDetailedErrorMessage(params: {
  errors: number;
  processed: number;
  skipped: number;
  quarantined: number;
  promoted: number;
  failureCounts: Map<string, number>;
  failureSamples: Array<{ shipmentId?: string; stage: FailureStage; reason: string }>;
}): string {
  const { errors, processed, skipped, quarantined, promoted, failureCounts, failureSamples } = params;
  const topReasons = [...failureCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const suggestedActions = buildSuggestedActions(topReasons[0]?.[0]);

  const sections: string[] = [];
  sections.push(`${errors} shipment${errors === 1 ? "" : "s"} failed to process.`);
  sections.push(
    `Processed: ${processed} | Skipped: ${skipped} | Quarantined: ${quarantined} | Promoted: ${promoted}`
  );

  if (topReasons.length > 0) {
    sections.push(`Top failure reasons:\n${topReasons.map(([reason, count]) => `- ${reason} (${count})`).join("\n")}`);
  }

  if (failureSamples.length > 0) {
    const lines = failureSamples.slice(0, 5).map((sample) => {
      const stageLabel = sample.stage === "fetch" ? "API fetch" : "shipment processing";
      const shipmentLabel = sample.shipmentId ? `Shipment ${sample.shipmentId}` : "Sync job";
      return `- ${shipmentLabel} (${stageLabel}): ${sample.reason}`;
    });
    sections.push(`Sample failures:\n${lines.join("\n")}`);
  }

  if (suggestedActions.length > 0) {
    sections.push(`Recommended actions:\n${suggestedActions.map((action, i) => `${i + 1}. ${action}`).join("\n")}`);
  }

  return sections.join("\n\n");
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
    const apiKey = resolveApiKey(credentials);
    
    let processed = 0;
    let errors = 0;
    let quarantined = 0;
    let skipped = 0;
    let promoted = 0; // ✅ Track UNMAPPED → CONTRACT promotions during sync
    const failureCounts = new Map<string, number>();
    const failureSamples: Array<{ shipmentId?: string; stage: FailureStage; reason: string }> = [];

    const recordFailure = (stage: FailureStage, error: unknown, shipmentId?: string) => {
      const reason = extractErrorReason(error);
      const key = normalizeFailureKey(reason);
      failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
      if (failureSamples.length < 5) {
        failureSamples.push({
          shipmentId,
          stage,
          reason: reason.slice(0, 240),
        });
      }
    };

    try {
      const startTime = new Date(Date.now() - (lookbackHours * 60 * 60 * 1000)).toISOString();

      if (!apiKey) {
        throw new Error("Missing FourKites API key in integration credentials");
      }

      // Fetch shipments from FourKites API (this can happen in an action)
      const shipments = await fetchShipments(apiKey, startTime);

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
                
                const dbStop = existingStops.find((s: { externalStopId?: string; _id: any; windowBeginTime?: string; windowEndTime?: string; windowBeginDate?: string; windowEndDate?: string }) => s.externalStopId === String(stopId));

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
          recordFailure("process", innerErr, shipment?.id ? String(shipment.id) : undefined);
          errors++;
        }
      }
    } catch (err) {
      console.error("Sync Failure:", err);
      recordFailure("fetch", err);
      errors++;
    }

    const detailedErrorMessage =
      errors > 0
        ? buildDetailedErrorMessage({
            errors,
            processed,
            skipped,
            quarantined,
            promoted,
            failureCounts,
            failureSamples,
          })
        : undefined;

    // STEP 7: Update stats
    await ctx.runMutation(internal.fourKitesSyncHelpers.updateIntegrationStats, {
      integrationId: args.integrationId,
      stats: {
        lastSyncTime: Date.now(),
        lastSyncStatus: errors > 0 ? "partial" : "success",
        recordsProcessed: processed,
        errorMessage: detailedErrorMessage,
      },
    });

    console.log(`Sync Complete: ${processed} Processed, ${quarantined} Quarantined, ${promoted} Promoted, ${skipped} Skipped.`);

    // ✅ Promotion is now event-driven:
    // - During sync: UNMAPPED loads with matching lanes are promoted immediately
    // - When lanes are created: createLaneAndBackfill promotes matching loads
    // - When loads are accessed: checkAndPromoteLoad promotes if lane exists
  },
});
