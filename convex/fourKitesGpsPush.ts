import { v } from 'convex/values';
import { internalAction, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { Id } from './_generated/dataModel';

// ============================================
// FOURKITES GPS PUSH ADAPTER (SCAFFOLD)
// DEFERRED: Not wired to cron until FK push API access is confirmed.
// This module defines the types, interfaces, and carrier resolver
// so it can be enabled quickly once credentials are available.
// ============================================

// ============================================
// FOURKITES PAYLOAD TYPES
// Based on FourKites TMS Locations API / Project44 reference
// ============================================

interface FourKitesShipmentIdentifier {
  type: 'BILL_OF_LADING' | 'ORDER';
  value: string;
}

interface FourKitesCarrierIdentifier {
  type: 'SCAC' | 'DOT_NUMBER' | 'MC_NUMBER';
  value: string;
}

interface FourKitesPositionUpdate {
  shipmentIdentifiers: FourKitesShipmentIdentifier[];
  latitude: number;
  longitude: number;
  utcTimestamp: string; // yyyy-mm-ddTHH:mm:ss format
  customerId: string;  // Provided by FourKites during onboarding
  eventType?: 'POSITION' | 'ARRIVED' | 'DEPARTED' | 'DELIVERED' | 'IN_TRANSIT' | 'COMPLETED';
  eventStopNumber?: number;
  carrierIdentifier?: FourKitesCarrierIdentifier;
  latestTemperature?: number;
  latestTemperatureUnit?: 'F' | 'C';
}

// ============================================
// CARRIER MC# RESOLVER
// Useful for both FourKites and generic API
// ============================================

/**
 * Resolve the carrier MC number for a load.
 * Follows: loadCarrierAssignments -> carrierPartnerships.mcNumber
 */
export const resolveCarrierForLoad = internalQuery({
  args: { loadId: v.id('loadInformation') },
  returns: v.union(
    v.object({
      mcNumber: v.optional(v.string()),
      carrierName: v.optional(v.string()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    // Find the active/awarded carrier assignment for this load
    const assignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    // Find the awarded or in-progress assignment
    const activeAssignment = assignments.find(
      (a) => a.status === 'AWARDED' || a.status === 'IN_PROGRESS' || a.status === 'COMPLETED'
    );

    if (!activeAssignment) return null;

    // If we have a partnership ID, get the MC number
    if (activeAssignment.partnershipId) {
      const partnership = await ctx.db.get(activeAssignment.partnershipId);
      if (partnership) {
        return {
          mcNumber: partnership.mcNumber,
          carrierName: partnership.carrierName,
        };
      }
    }

    // Fall back to cached carrier MC number
    return {
      mcNumber: activeAssignment.carrierMcNumber,
      carrierName: activeAssignment.carrierName,
    };
  },
});

// ============================================
// FIELD MAPPER (scaffold - not called yet)
// ============================================

/**
 * Map Otoqa tracking data to FourKites position update format.
 * NOT ACTIVE - will be enabled when FK push API access is confirmed.
 */
function mapToFourKitesPayload(params: {
  orderNumber: string;
  externalLoadId?: string;
  latitude: number;
  longitude: number;
  recordedAt: number;
  customerId: string;
  eventType?: string;
  eventStopNumber?: number;
  carrierMcNumber?: string;
  temperature?: number;
}): FourKitesPositionUpdate {
  const shipmentIdentifiers: FourKitesShipmentIdentifier[] = [];

  // Use externalLoadId (FK shipment ID) if available, otherwise orderNumber
  if (params.externalLoadId) {
    shipmentIdentifiers.push({
      type: 'BILL_OF_LADING',
      value: params.externalLoadId,
    });
  } else {
    shipmentIdentifiers.push({
      type: 'ORDER',
      value: params.orderNumber,
    });
  }

  // Format timestamp to FourKites format: yyyy-mm-ddTHH:mm:ss
  const date = new Date(params.recordedAt);
  const utcTimestamp = date.toISOString().replace(/\.\d{3}Z$/, '');

  const payload: FourKitesPositionUpdate = {
    shipmentIdentifiers,
    latitude: params.latitude,
    longitude: params.longitude,
    utcTimestamp,
    customerId: params.customerId,
  };

  // Add event type if provided
  if (params.eventType) {
    payload.eventType = params.eventType as any;
  }

  if (params.eventStopNumber !== undefined) {
    payload.eventStopNumber = params.eventStopNumber;
  }

  // Add carrier identifier if available
  if (params.carrierMcNumber) {
    payload.carrierIdentifier = {
      type: 'MC_NUMBER',
      value: params.carrierMcNumber,
    };
  }

  // Add temperature for reefer loads
  if (params.temperature !== undefined) {
    payload.latestTemperature = params.temperature;
    payload.latestTemperatureUnit = 'F';
  }

  return payload;
}

// ============================================
// PUSH ACTION (scaffold - returns early)
// ============================================

/**
 * Push GPS updates to FourKites.
 * DEFERRED: Returns early until FK push API access is confirmed.
 * When ready, wire this into the cron job.
 */
export const pushGpsUpdates = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // DEFERRED: FourKites push API access not yet confirmed.
    // When ready:
    // 1. Query orgIntegrations for orgs with gpsTrackingEnabled = true
    // 2. For each org, get actively tracking loads
    // 3. Get new GPS points since last push
    // 4. Map to FourKites payload format
    // 5. POST to FourKites API endpoint
    // 6. Track push state per load

    console.log('[FourKitesGpsPush] Adapter is scaffolded but not activated. Awaiting FK push API credentials.');
    return null;
  },
});
