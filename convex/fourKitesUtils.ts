/**
 * Shared, side-effect-free helpers for the FourKites integration surface.
 *
 * Lives next to fourKitesApiClient.ts / fourKitesSyncHelpers.ts /
 * fourKitesPullSyncAction.ts to keep mapping + parsing semantics defined
 * once. No Convex `query/mutation/action` exports live here — only pure
 * utility functions and types — so this file is safe to import from any
 * Convex runtime (v8 or node) and from the unit-test harness.
 */
import type { Id } from "./_generated/dataModel";

// ---------------------------------------------------------------------
// TRACKING STATUS MAP
// Single source of truth for FourKites shipment.status -> Otoqa
// trackingStatus translation. Previously two diverging copies lived in
// fourKitesPullSyncAction.ts and fourKitesSyncHelpers.ts.
// ---------------------------------------------------------------------
export type OtoqaTrackingStatus =
  | "Pending"
  | "In Transit"
  | "Completed"
  | "Delayed"
  | "Canceled";

const TRACKING_STATUS_MAP: Record<string, OtoqaTrackingStatus> = {
  PLANNED: "Pending",
  IN_TRANSIT: "In Transit",
  ARRIVED: "In Transit",
  DELIVERED: "Completed",
  COMPLETED: "Completed",
  DELAYED: "Delayed",
  CANCELED: "Canceled",
  CANCELLED: "Canceled",
  WITHDRAWN: "Canceled",
};

export function mapTrackingStatus(fkStatus: unknown): OtoqaTrackingStatus {
  if (typeof fkStatus !== "string") return "Pending";
  return TRACKING_STATUS_MAP[fkStatus.trim().toUpperCase()] ?? "Pending";
}

const CANCELLED_STATUSES = new Set(["CANCELED", "CANCELLED", "WITHDRAWN"]);
export function isCancelledStatus(fkStatus: unknown): boolean {
  return typeof fkStatus === "string" && CANCELLED_STATUSES.has(fkStatus.trim().toUpperCase());
}

// ---------------------------------------------------------------------
// DISTANCE
// FourKites ships totalDistanceInMeters; we persist miles rounded to 2dp.
// ---------------------------------------------------------------------
const METERS_PER_MILE_INV = 0.000621371;

export function metersToMiles(meters: unknown): number | undefined {
  if (typeof meters !== "number" || !Number.isFinite(meters) || meters < 0) {
    return undefined;
  }
  return Math.round(meters * METERS_PER_MILE_INV * 100) / 100;
}

// ---------------------------------------------------------------------
// API RESPONSE PARSING
// FourKites returns multiple shapes depending on tenant / endpoint:
//   { data: { shipments: [...], totalCount, ... } }   (standard)
//   { data: [...] }                                   (legacy)
//   { shipments: [...] }                              (older fixtures)
//   [...]                                             (raw array)
// Parse once, here.
// ---------------------------------------------------------------------
export interface ParsedShipmentsResponse {
  shipments: any[];
  totalCount: number;
}

export function parseShipmentsResponse(data: unknown): ParsedShipmentsResponse {
  if (Array.isArray(data)) {
    return { shipments: data, totalCount: 0 };
  }
  if (!data || typeof data !== "object") {
    return { shipments: [], totalCount: 0 };
  }
  const obj = data as Record<string, any>;
  if (obj.data && Array.isArray(obj.data.shipments)) {
    return {
      shipments: obj.data.shipments,
      totalCount: typeof obj.data.totalCount === "number" ? obj.data.totalCount : 0,
    };
  }
  if (Array.isArray(obj.data)) {
    return { shipments: obj.data, totalCount: 0 };
  }
  if (Array.isArray(obj.shipments)) {
    return { shipments: obj.shipments, totalCount: 0 };
  }
  return { shipments: [], totalCount: 0 };
}

// ---------------------------------------------------------------------
// SHIPMENT -> LOAD/STOP SHAPING
// Both importLoadFromShipment and importUnmappedLoad in
// fourKitesSyncHelpers.ts produced near-identical loadStops payloads.
// Centralizing the shape here keeps them aligned.
// ---------------------------------------------------------------------

export interface FourKitesStopShape {
  fourKitesStopID?: string;
  id?: string;
  sequence?: number;
  stopType?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  timeZone?: string;
  schedule?: { appointmentTime?: string };
  pallets?: Array<{ parts?: Array<{ quantity?: string }> }>;
}

export function buildLoadInternalId(shipment: { loadNumber?: string; id: string }): string {
  return `FK-${shipment.loadNumber || shipment.id}`;
}

/**
 * Produce the loadStops insert payload from a FourKites stop. Both the
 * UNMAPPED and CONTRACT/SPOT import paths use this.
 */
export function buildStopRecord(params: {
  workosOrgId: string;
  loadId: Id<"loadInformation">;
  internalId: string;
  stop: FourKitesStopShape;
  commodityDescription?: string;
}): Record<string, unknown> {
  const { workosOrgId, loadId, internalId, stop, commodityDescription } = params;
  const stopId = stop.fourKitesStopID || stop.id;
  const appointmentTime = stop.schedule?.appointmentTime;
  const day = appointmentTime?.split("T")[0] || "TBD";
  const piecesRaw = stop.pallets?.[0]?.parts?.[0]?.quantity;
  const pieces = piecesRaw ? parseInt(piecesRaw, 10) : 0;
  const now = Date.now();

  return {
    workosOrgId,
    loadId,
    createdBy: "FourKites",
    internalId,
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
    windowBeginDate: day,
    windowBeginTime: appointmentTime || "TBD",
    windowEndDate: day,
    windowEndTime: appointmentTime || "TBD",
    status: "Pending",
    commodityDescription: commodityDescription || "",
    commodityUnits: "Pieces",
    pieces: Number.isFinite(pieces) ? pieces : 0,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------
// BILLING MATH
// importLoadFromShipment and promoteUnmappedLoad both compute baseRate /
// fuelSurcharge / stopOffCharges from a contract lane. Same formula,
// previously hand-copied.
// ---------------------------------------------------------------------

export interface ContractLaneRateShape {
  rate?: number;
  rateType?: string;
  miles?: number;
  includedStops?: number;
  stopOffRate?: number;
  fuelSurchargeType?: string;
  fuelSurchargeValue?: number;
}

export interface BillingComputation {
  baseRate: number;
  fuelSurcharge: number;
  stopOffCharges: number;
  subtotal: number;
  totalAmount: number;
  effectiveMiles: number | undefined;
}

export function computeLaneBilling(params: {
  contractLane: ContractLaneRateShape;
  stopCount: number;
  importedMiles?: number;
  fallbackContractMiles?: number;
}): BillingComputation {
  const { contractLane, stopCount, importedMiles, fallbackContractMiles } = params;
  const effectiveMiles = contractLane.miles ?? importedMiles ?? fallbackContractMiles;
  const rate = contractLane.rate ?? 0;

  let baseRate = 0;
  if (contractLane.rateType === "Per Mile" && effectiveMiles) {
    baseRate = rate * effectiveMiles;
  } else if (contractLane.rateType === "Flat Rate") {
    baseRate = rate;
  } else if (contractLane.rateType === "Per Stop") {
    baseRate = rate * stopCount;
  }

  let fuelSurcharge = 0;
  if (contractLane.fuelSurchargeType === "PERCENTAGE") {
    fuelSurcharge = baseRate * ((contractLane.fuelSurchargeValue ?? 0) / 100);
  } else if (contractLane.fuelSurchargeType === "FLAT") {
    fuelSurcharge = contractLane.fuelSurchargeValue ?? 0;
  }

  const includedStops = contractLane.includedStops ?? 2;
  const extraStops = Math.max(0, stopCount - includedStops);
  const stopOffCharges = extraStops * (contractLane.stopOffRate ?? 0);

  const subtotal = baseRate;
  const totalAmount = subtotal + fuelSurcharge + stopOffCharges;

  return { baseRate, fuelSurcharge, stopOffCharges, subtotal, totalAmount, effectiveMiles };
}

// ---------------------------------------------------------------------
// CREDENTIAL RESOLUTION
// orgIntegrations.credentials is stored as either a JSON string or an
// already-parsed object. Resolve once so the worker doesn't ship its
// own copy of the unwrap-and-trim logic.
// ---------------------------------------------------------------------

import type { FourKitesAuthCredentials } from "./fourKitesApiClient";

export function resolveFourKitesCredentials(
  raw: unknown,
): FourKitesAuthCredentials | null {
  if (!raw) return null;

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      const trimmed = raw.trim();
      return trimmed ? { apiKey: trimmed } : null;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const source = parsed as Record<string, unknown>;
  const result: FourKitesAuthCredentials = {};
  const KEYS = ["apiKey", "username", "password", "clientSecret", "accessToken"] as const;
  for (const key of KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      result[key] = value.trim();
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}
