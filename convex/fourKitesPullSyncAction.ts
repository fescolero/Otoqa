import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { fetchShipments, type FourKitesAuthCredentials } from "./fourKitesApiClient";

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

function resolveAuthCredentials(credentials: unknown): FourKitesAuthCredentials | null {
  if (!credentials) {
    return null;
  }

  let parsedCredentials: unknown = credentials;
  if (typeof credentials === "string") {
    try {
      parsedCredentials = JSON.parse(credentials);
    } catch {
      const rawValue = credentials.trim();
      return rawValue ? { apiKey: rawValue } : null;
    }
  }

  if (!parsedCredentials || typeof parsedCredentials !== "object" || Array.isArray(parsedCredentials)) {
    return null;
  }

  const source = parsedCredentials as Record<string, unknown>;
  const result: FourKitesAuthCredentials = {};

  if (typeof source.apiKey === "string" && source.apiKey.trim()) {
    result.apiKey = source.apiKey.trim();
  }
  if (typeof source.username === "string" && source.username.trim()) {
    result.username = source.username.trim();
  }
  if (typeof source.password === "string" && source.password.trim()) {
    result.password = source.password.trim();
  }
  if (typeof source.clientSecret === "string" && source.clientSecret.trim()) {
    result.clientSecret = source.clientSecret.trim();
  }
  if (typeof source.accessToken === "string" && source.accessToken.trim()) {
    result.accessToken = source.accessToken.trim();
  }

  return Object.keys(result).length > 0 ? result : null;
}

function buildSuggestedActions(topReason: string | undefined): string[] {
  const actions = new Set<string>();
  const normalized = topReason?.toLowerCase() || "";
  const isAuthIssue =
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("401") ||
    normalized.includes("403");

  if (isAuthIssue) {
    actions.add("Verify FourKites credentials in Configure (API key, username/password, or OAuth fields).");
    actions.add("Confirm key/environment alignment (staging key with staging URL, prod key with prod URL).");
    actions.add("Confirm the shipments endpoint is enabled for your FourKites subscription.");
    actions.add("If OAuth2 is enabled for your tenant, configure client secret or a valid access token.");
    actions.add("Retry sync after updating credentials.");
    return Array.from(actions);
  }

  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    actions.add("Reduce lookback window (for example 24-72 hours) and retry the sync.");
  }

  if (normalized.includes("customer not found")) {
    actions.add("Confirm all referenced customers exist and are active in your organization.");
  }

  actions.add("Review affected shipment IDs below and verify HCR/Trip lane mappings.");
  actions.add("Retry sync after updating configuration or mappings.");

  return Array.from(actions).slice(0, 4);
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
    const authCredentials = resolveAuthCredentials(credentials);
    
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

      if (!authCredentials) {
        throw new Error("Missing FourKites credentials in integration settings");
      }

      // Fetch shipments from FourKites API (this can happen in an action)
      const shipments = await fetchShipments(authCredentials, startTime);

      console.log(`FourKites: Fetched ${shipments.length} shipments for org ${orgId}`);

      for (const shipment of shipments) {
        try {
          if (!shipment.hcr || !shipment.trip) {
            console.log(`Skipping shipment ${shipment.id}: missing HCR or Trip`);
            skipped++;
            continue;
          }
          
          // STEP 1: Gate 1 - Try Exact Match (HCR + Trip) via compound index query
          let laneMatch = await ctx.runQuery(internal.fourKitesSyncHelpers.findContractLane, {
            workosOrgId: orgId,
            hcr: shipment.hcr,
            tripNumber: shipment.trip,
          });

          let isWildcard = false;

          // STEP 2: Gate 2 - Try Wildcard Match (HCR + *)
          if (!laneMatch) {
            laneMatch = await ctx.runQuery(internal.fourKitesSyncHelpers.findContractLane, {
              workosOrgId: orgId,
              hcr: shipment.hcr,
              tripNumber: "*",
            });
            
            if (laneMatch) {
              isWildcard = true;
              console.log(`Wildcard match for HCR=${shipment.hcr}, Trip=${shipment.trip}`);
            }
          }

          // Single load lookup -- reused across all branches below
          const existingLoad = await ctx.runQuery(internal.fourKitesSyncHelpers.findLoadByExternalId, {
            externalLoadId: shipment.id,
          });

          // STEP 3: Gate 3 - No match? Create or update UNMAPPED load
          if (!laneMatch) {
            if (!existingLoad) {
              await ctx.runMutation(internal.fourKitesSyncHelpers.importUnmappedLoad, {
                workosOrgId: orgId,
                shipment,
                createdBy: "FourKites Integration",
              });
              quarantined++;
            }
            continue;
          }

          // STEP 3.5: If lane NOW exists but load was UNMAPPED, promote it
          // (promoteUnmappedLoad stamps the lane internally, no separate stamp needed)
          if (existingLoad && existingLoad.loadType === "UNMAPPED") {
            await ctx.runMutation(internal.fourKitesSyncHelpers.promoteUnmappedLoad, {
              loadId: existingLoad._id,
              contractLane: laneMatch,
              isWildcard,
            });
            promoted++;
            continue;
          }

          // STEP 4: Skip if unchanged (change detection)
          if (existingLoad && existingLoad.lastExternalUpdatedAt === shipment.updated_at) {
            skipped++;
            continue;
          }

          // Stamp the matched lane with import metadata (only for actual creates/updates)
          await ctx.runMutation(internal.fourKitesSyncHelpers.stampLaneMatch, {
            laneId: laneMatch._id,
          });

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
            loadId = await ctx.runMutation(internal.fourKitesSyncHelpers.updateLoad, {
              loadId: existingLoad._id,
              data: loadData,
            });

            if (shipment.status === 'CANCELED' || shipment.status === 'WITHDRAWN') {
              await ctx.runMutation(internal.fourKitesSyncHelpers.updateLoad, {
                loadId: existingLoad._id,
                data: { status: 'Canceled' },
              });
            }
          } else {
            loadId = await ctx.runMutation(internal.fourKitesSyncHelpers.importLoadFromShipment, {
              workosOrgId: orgId,
              shipment,
              contractLane: laneMatch,
              createdBy: "FourKites Integration",
              isWildcard,
            });
          }

          // STEP 6: Sync stops (UPDATE case only, CREATE handled by import helper)
          if (existingLoad) {
            const existingStops = await ctx.runQuery(internal.fourKitesSyncHelpers.getLoadStops, {
              loadId,
            });

            for (const stop of shipment.stops || []) {
              try {
                const stopId = stop.fourKitesStopID || stop.id;
                const appointmentTime = stop.schedule?.appointmentTime;
                
                const dbStop = existingStops.find((s: { externalStopId?: string; _id: any; windowBeginTime?: string; windowEndTime?: string; windowBeginDate?: string; windowEndDate?: string }) => s.externalStopId === String(stopId));

                if (dbStop) {
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
