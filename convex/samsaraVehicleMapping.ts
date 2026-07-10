'use node';

import { v } from 'convex/values';
import { action, internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { assertCallerOwnsOrg } from './lib/auth';
import {
  fetchAllVehicles,
  type SamsaraVehicleSummary,
  type SamsaraEnvironment,
} from './samsaraApiClient';

// ============================================
// SAMSARA VEHICLE MAPPING — public action
//
// One-click "Map fleet by VIN" from the integrations page. Fetches the
// org's Samsara fleet, matches each Otoqa truck against it by normalized
// VIN, and writes samsaraVehicleId on every truck with an unambiguous
// match. Idempotent — running it twice is safe; existing mappings are
// left alone.
// ============================================

export interface OtoqaTruckSummary {
  truckId: string;
  unitId: string;
  vin: string;
  samsaraVehicleId?: string;
}

export interface VinMatchReport {
  matched: Array<{
    truckId: string;
    unitId: string;
    vin: string;
    samsaraVehicleId: string;
    /** Samsara side — surfaced so the UI can render a verification table. */
    samsaraName: string;
    samsaraVin?: string;
    /**
     * 'VIN'  — matched on normalized VIN (preferred, most specific)
     * 'NAME' — matched on Samsara vehicle name ↔ Otoqa unitId fallback,
     *          used when Samsara hasn't populated VINs (very common in
     *          fleets that identify vehicles by unit number).
     */
    strategy: 'VIN' | 'NAME';
  }>;
  alreadyMapped: Array<{
    truckId: string;
    unitId: string;
    vin: string;
    samsaraVehicleId: string;
  }>;
  ambiguous: Array<{
    /** The normalized identifier — VIN or unitId/name — that hit a clash. */
    key: string;
    /** What kind of identifier — for the UI label. */
    keyKind: 'VIN' | 'NAME';
    samsaraVehicleIds: string[];
    otoqaTruckIds: string[];
  }>;
  unmatched: Array<{
    truckId: string;
    unitId: string;
    vin: string;
  }>;
}

/**
 * Pure matching logic. Exported so it can be unit-tested without spinning
 * up the action machinery.
 *
 * Normalization: VINs are 17 chars, case-insensitive in spec but
 * conventionally uppercase. We trim + uppercase before matching.
 *
 * Buckets:
 *   matched         — exactly one Samsara vehicle has this VIN AND exactly
 *                     one Otoqa truck has this VIN, neither side is mapped.
 *   alreadyMapped   — Otoqa truck already has samsaraVehicleId set; left
 *                     alone (idempotent).
 *   ambiguous       — multiple Samsara vehicles or multiple Otoqa trucks
 *                     share a VIN; surfaced for manual resolution.
 *   unmatched       — Otoqa truck has no Samsara counterpart.
 */
/**
 * Aggressive VIN normalization. VINs are 17 chars of `[A-HJ-NPR-Z0-9]`
 * (no I, O, Q). Real-world data often arrives with:
 *   - non-ASCII whitespace (NBSP U+00A0) from copy-paste
 *   - zero-width chars (U+200B, U+FEFF / BOM) from CSV imports
 *   - hyphens or spaces as visual separators
 *   - mixed case
 * NFKC folds compatibility forms; the regex then strips anything that isn't
 * a valid VIN character, uppercased. Two values are equal under this norm
 * iff they have the same VIN-meaningful content, regardless of presentation.
 */
export function normalizeVin(s: string | undefined): string {
  if (!s) return '';
  return s.normalize('NFKC').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function matchByVin(
  samsaraVehicles: SamsaraVehicleSummary[],
  otoqaTrucks: OtoqaTruckSummary[],
): VinMatchReport {
  const norm = (s: string | undefined) => normalizeVin(s);

  // ─── Build indexes for both signals ────────────────────────────────────
  // VIN signal: strict, most specific.
  const samsaraByVin = new Map<string, SamsaraVehicleSummary[]>();
  for (const v of samsaraVehicles) {
    const key = norm(v.vehicleVin);
    if (!key) continue;
    const list = samsaraByVin.get(key) ?? [];
    list.push(v);
    samsaraByVin.set(key, list);
  }

  const otoqaByVin = new Map<string, OtoqaTruckSummary[]>();
  for (const t of otoqaTrucks) {
    const key = norm(t.vin);
    if (!key) continue;
    const list = otoqaByVin.get(key) ?? [];
    list.push(t);
    otoqaByVin.set(key, list);
  }

  // Name signal: Samsara vehicle.name ↔ Otoqa truck.unitId. Used as a
  // fallback when one side doesn't have VIN populated (very common —
  // many Samsara orgs identify vehicles by unit number, not VIN).
  const samsaraByName = new Map<string, SamsaraVehicleSummary[]>();
  for (const v of samsaraVehicles) {
    const key = norm(v.name);
    if (!key) continue;
    const list = samsaraByName.get(key) ?? [];
    list.push(v);
    samsaraByName.set(key, list);
  }

  const otoqaByUnitId = new Map<string, OtoqaTruckSummary[]>();
  for (const t of otoqaTrucks) {
    const key = norm(t.unitId);
    if (!key) continue;
    const list = otoqaByUnitId.get(key) ?? [];
    list.push(t);
    otoqaByUnitId.set(key, list);
  }

  const report: VinMatchReport = {
    matched: [],
    alreadyMapped: [],
    ambiguous: [],
    unmatched: [],
  };

  // De-dupe helper for ambiguous bucket — one entry per (key, keyKind).
  const reportAmbiguous = (
    key: string,
    keyKind: 'VIN' | 'NAME',
    samsaraCands: SamsaraVehicleSummary[],
    otoqaCands: OtoqaTruckSummary[],
  ) => {
    const exists = report.ambiguous.some(
      (a) => a.key === key && a.keyKind === keyKind,
    );
    if (exists) return;
    report.ambiguous.push({
      key,
      keyKind,
      samsaraVehicleIds: samsaraCands.map((s) => s.id),
      otoqaTruckIds: otoqaCands.map((t) => t.truckId),
    });
  };

  // Two-pass algorithm:
  //   Pass 1 — VIN matches only. Consume the matched Samsara IDs so they
  //            can't be re-claimed by a name match in pass 2.
  //   Pass 2 — Name matches (samsara.name ↔ otoqa.unitId) for trucks that
  //            didn't match by VIN. Skip Samsara candidates already
  //            consumed in pass 1.
  // This guarantees VIN always wins when both signals fire on the same
  // Samsara vehicle, and prevents double-claims that would otherwise turn
  // into spurious "skippedCollisions" at write time.

  const consumedSamsaraIds = new Set<string>();
  const trucksNeedingFallback: OtoqaTruckSummary[] = [];

  // Pass 1 — VIN.
  for (const truck of otoqaTrucks) {
    if (truck.samsaraVehicleId) {
      report.alreadyMapped.push({
        truckId: truck.truckId,
        unitId: truck.unitId,
        vin: truck.vin,
        samsaraVehicleId: truck.samsaraVehicleId,
      });
      continue;
    }

    const vinKey = norm(truck.vin);
    if (!vinKey) {
      trucksNeedingFallback.push(truck);
      continue;
    }

    const samsaraCands = samsaraByVin.get(vinKey) ?? [];
    const otoqaCands = otoqaByVin.get(vinKey) ?? [];

    if (samsaraCands.length === 1 && otoqaCands.length === 1) {
      const samsaraVehicle = samsaraCands[0];
      report.matched.push({
        truckId: truck.truckId,
        unitId: truck.unitId,
        vin: truck.vin,
        samsaraVehicleId: samsaraVehicle.id,
        samsaraName: samsaraVehicle.name,
        samsaraVin: samsaraVehicle.vehicleVin,
        strategy: 'VIN',
      });
      consumedSamsaraIds.add(samsaraVehicle.id);
      continue;
    }

    if (samsaraCands.length > 1 || otoqaCands.length > 1) {
      // Ambiguous on VIN side — needs human review. Don't try the name
      // fallback; if VINs collide, the customer's data has bigger issues.
      reportAmbiguous(vinKey, 'VIN', samsaraCands, otoqaCands);
      continue;
    }

    // No Samsara vehicle has this VIN. Try name fallback.
    trucksNeedingFallback.push(truck);
  }

  // Pass 2 — name fallback for trucks that didn't match by VIN.
  for (const truck of trucksNeedingFallback) {
    const nameKey = norm(truck.unitId);
    if (!nameKey) {
      report.unmatched.push({
        truckId: truck.truckId,
        unitId: truck.unitId,
        vin: truck.vin,
      });
      continue;
    }

    // Filter out Samsara candidates already claimed by VIN matches in pass 1.
    const samsaraCands = (samsaraByName.get(nameKey) ?? []).filter(
      (s) => !consumedSamsaraIds.has(s.id),
    );
    const otoqaCands = otoqaByUnitId.get(nameKey) ?? [];

    if (samsaraCands.length === 1 && otoqaCands.length === 1) {
      const samsaraVehicle = samsaraCands[0];
      report.matched.push({
        truckId: truck.truckId,
        unitId: truck.unitId,
        vin: truck.vin,
        samsaraVehicleId: samsaraVehicle.id,
        samsaraName: samsaraVehicle.name,
        samsaraVin: samsaraVehicle.vehicleVin,
        strategy: 'NAME',
      });
      consumedSamsaraIds.add(samsaraVehicle.id);
      continue;
    }

    if (samsaraCands.length > 1 || otoqaCands.length > 1) {
      reportAmbiguous(nameKey, 'NAME', samsaraCands, otoqaCands);
      continue;
    }

    report.unmatched.push({
      truckId: truck.truckId,
      unitId: truck.unitId,
      vin: truck.vin,
    });
  }

  return report;
}

// ============================================
// PUBLIC ACTION
// ============================================

export const autoMapSamsaraTrucksByVin = action({
  args: { workosOrgId: v.string() },
  returns: v.object({
    matched: v.number(),
    matchedByVin: v.number(),
    matchedByName: v.number(),
    alreadyMapped: v.number(),
    ambiguousCount: v.number(),
    unmatchedCount: v.number(),
    skippedCollisions: v.number(),
    // Surface up to N matched + ambiguous + unmatched entries for the UI
    // to display. Caps keep the response payload bounded for huge fleets.
    matchedDetails: v.array(
      v.object({
        truckId: v.string(),
        unitId: v.string(),
        otoqaVin: v.string(),
        samsaraVehicleId: v.string(),
        samsaraName: v.string(),
        samsaraVin: v.optional(v.string()),
        strategy: v.union(v.literal('VIN'), v.literal('NAME')),
      }),
    ),
    ambiguous: v.array(
      v.object({
        key: v.string(),
        keyKind: v.union(v.literal('VIN'), v.literal('NAME')),
        samsaraVehicleIds: v.array(v.string()),
        otoqaTruckIds: v.array(v.string()),
      }),
    ),
    unmatched: v.array(
      v.object({
        truckId: v.string(),
        unitId: v.string(),
        vin: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const integration: {
      encryptedApiToken: string;
      environment: 'sandbox' | 'production';
    } | null = await ctx.runQuery(
      internal.samsaraVehicleMappingMutations.getSamsaraCredsForOrg,
      { workosOrgId: args.workosOrgId },
    );
    if (!integration) {
      throw new Error(
        'No Samsara integration is connected for this organization. ' +
          'Connect Samsara first, then run Map Fleet.',
      );
    }

    const apiToken: string = await ctx.runAction(
      internal.samsaraCrypto.decryptSamsaraToken,
      { encryptedToken: integration.encryptedApiToken },
    );

    const fetchResult = await fetchAllVehicles({
      apiToken,
      environment: integration.environment as SamsaraEnvironment,
    });

    if (fetchResult.kind === 'auth_failed') {
      throw new Error(
        `Samsara rejected the API token (HTTP ${fetchResult.status}). ` +
          'Reconnect with a valid token, then run Map Fleet again.',
      );
    }
    if (fetchResult.kind === 'rate_limited') {
      throw new Error(
        `Samsara rate-limited the request. Retry in ${fetchResult.retryAfterSec} seconds.`,
      );
    }
    if (fetchResult.kind === 'transient_error') {
      throw new Error(
        `Samsara request failed (${fetchResult.status ?? 'network'}). ` +
          `Try again in a minute. Detail: ${fetchResult.message}`,
      );
    }

    const otoqaTrucks: OtoqaTruckSummary[] = (await ctx.runQuery(
      internal.samsaraVehicleMappingMutations.listOtoqaTrucksForMapping,
      { workosOrgId: args.workosOrgId },
    )) as OtoqaTruckSummary[];

    const report = matchByVin(fetchResult.vehicles, otoqaTrucks);

    let skippedCollisions = 0;
    if (report.matched.length > 0) {
      const applyResult: {
        applied: number;
        skippedCollisions: Array<unknown>;
      } = await ctx.runMutation(
        internal.samsaraVehicleMappingMutations.applyVinMappings,
        {
          pairs: report.matched.map((m) => ({
            truckId: m.truckId as any,
            samsaraVehicleId: m.samsaraVehicleId,
          })),
        },
      );
      skippedCollisions = applyResult.skippedCollisions.length;
    }

    // Cap response payload — UI just needs counts and a few examples.
    const MATCHED_CAP = 200;
    const AMBIGUOUS_CAP = 25;
    const UNMATCHED_CAP = 100;

    const matchedByVin = report.matched.filter(
      (m) => m.strategy === 'VIN',
    ).length;
    const matchedByName = report.matched.filter(
      (m) => m.strategy === 'NAME',
    ).length;

    return {
      matched: report.matched.length - skippedCollisions,
      matchedByVin,
      matchedByName,
      alreadyMapped: report.alreadyMapped.length,
      ambiguousCount: report.ambiguous.length,
      unmatchedCount: report.unmatched.length,
      skippedCollisions,
      matchedDetails: report.matched.slice(0, MATCHED_CAP).map((m) => ({
        truckId: m.truckId,
        unitId: m.unitId,
        otoqaVin: m.vin,
        samsaraVehicleId: m.samsaraVehicleId,
        samsaraName: m.samsaraName,
        samsaraVin: m.samsaraVin,
        strategy: m.strategy,
      })),
      ambiguous: report.ambiguous.slice(0, AMBIGUOUS_CAP),
      unmatched: report.unmatched.slice(0, UNMATCHED_CAP),
    };
  },
});

// ============================================
// DIAGNOSTIC ACTION — internal, dashboard-runnable
// When Map Fleet returns 0 matches but the user is sure VINs agree, this
// returns the raw VIN strings from both sides plus character-code dumps so
// hidden whitespace / zero-width / BOM characters become visible. Read-only,
// capped to 50 entries per side. NOT auth-gated — only callable from the
// Convex dashboard (which already requires deployment admin access). Do
// NOT expose to public clients.
// ============================================

export const previewSamsaraVehicleVins = internalAction({
  args: { workosOrgId: v.string() },
  returns: v.object({
    samsara: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        vinRaw: v.optional(v.string()),
        vinNormalized: v.string(),
        vinLength: v.number(),
        vinCharCodes: v.array(v.number()),
      }),
    ),
    otoqa: v.array(
      v.object({
        truckId: v.string(),
        unitId: v.string(),
        vinRaw: v.string(),
        vinNormalized: v.string(),
        vinLength: v.number(),
        vinCharCodes: v.array(v.number()),
      }),
    ),
    samsaraTotalCount: v.number(),
    otoqaTotalCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const integration: {
      encryptedApiToken: string;
      environment: 'sandbox' | 'production';
    } | null = await ctx.runQuery(
      internal.samsaraVehicleMappingMutations.getSamsaraCredsForOrg,
      { workosOrgId: args.workosOrgId },
    );
    if (!integration) {
      throw new Error('No Samsara integration connected for this organization.');
    }

    const apiToken: string = await ctx.runAction(
      internal.samsaraCrypto.decryptSamsaraToken,
      { encryptedToken: integration.encryptedApiToken },
    );

    const fetchResult = await fetchAllVehicles({
      apiToken,
      environment: integration.environment as SamsaraEnvironment,
    });
    if (fetchResult.kind !== 'ok') {
      throw new Error(`Samsara fetch failed: ${fetchResult.kind}`);
    }

    const otoqaTrucks: OtoqaTruckSummary[] = (await ctx.runQuery(
      internal.samsaraVehicleMappingMutations.listOtoqaTrucksForMapping,
      { workosOrgId: args.workosOrgId },
    )) as OtoqaTruckSummary[];

    const PREVIEW_CAP = 50;
    const codePoints = (s: string) => Array.from(s).map((c) => c.codePointAt(0) ?? 0);

    return {
      samsara: fetchResult.vehicles.slice(0, PREVIEW_CAP).map((v) => {
        const raw = v.vehicleVin ?? '';
        return {
          id: v.id,
          name: v.name,
          vinRaw: v.vehicleVin,
          vinNormalized: normalizeVin(v.vehicleVin),
          vinLength: raw.length,
          vinCharCodes: codePoints(raw),
        };
      }),
      otoqa: otoqaTrucks.slice(0, PREVIEW_CAP).map((t) => ({
        truckId: t.truckId,
        unitId: t.unitId,
        vinRaw: t.vin,
        vinNormalized: normalizeVin(t.vin),
        vinLength: t.vin.length,
        vinCharCodes: codePoints(t.vin),
      })),
      samsaraTotalCount: fetchResult.vehicles.length,
      otoqaTotalCount: otoqaTrucks.length,
    };
  },
});
