'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { buildLocationUpdate } from './fourKitesDispatcherClient';

// ============================================
// FOURKITES INBOUND DIAGNOSTIC
//
// Run from the Convex dashboard to dump the FULL untouched JSON response
// FourKites returns for a single shipment. The regular sync code strips
// the payload down to a typed FourKitesShipment, so fields like
// billToCode / shipperId / identifierType are invisible if they exist
// upstream.
//
// Strategy: try GET /shipments/{id} first (cheap, direct). If FK doesn't
// expose a singular endpoint and returns 404 with valid auth, fall back
// to paginating through /shipments and matching by id.
//
// Returns:
//   url            — the URL we hit (final attempt)
//   status         — HTTP status code (or null on network error)
//   bodyJson       — full response body as a string (unaltered). Paste this
//                    back so we can see every field FK actually sends.
//   pagesScanned   — how many list pages we walked if we fell back
//   foundOnPage    — which page the match landed on (fallback path)
//   note           — extra context, e.g. "direct fetch", "fallback paginated"
// ============================================

const FOURKITES_BASE = (
  process.env.FOURKITES_API_URL || 'https://api.fourkites.com/shipments'
).replace(/\/+$/, '');

export const dumpRawShipment = internalAction({
  args: {
    workosOrgId: v.string(),
    externalLoadId: v.string(),
    maxPages: v.optional(v.number()),
  },
  returns: v.object({
    url: v.string(),
    status: v.union(v.number(), v.null()),
    bodyJson: v.string(),
    pagesScanned: v.number(),
    foundOnPage: v.union(v.number(), v.null()),
    note: v.string(),
    // When the target shipment isn't found, the first raw shipment from
    // page 1 is returned here instead — Phase 0's real question is "what
    // fields does FK send?", and any current shipment answers it.
    sampleJson: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    url: string;
    status: number | null;
    bodyJson: string;
    pagesScanned: number;
    foundOnPage: number | null;
    note: string;
    sampleJson?: string;
  }> => {
    const pushContext: { apiKey: string } | null = await ctx.runQuery(
      internal.fourKitesDispatcherPushMutations.getFourKitesPushContext,
      { workosOrgId: args.workosOrgId },
    );
    if (!pushContext) {
      return {
        url: '',
        status: null,
        bodyJson: '',
        pagesScanned: 0,
        foundOnPage: null,
        note: 'No active FourKites integration for this org (or syncSettings.isEnabled=false, or no apiKey).',
      };
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.fourkites.v1+json',
      'Content-Type': 'application/json',
      apikey: pushContext.apiKey,
    };

    // ─── Attempt 1: direct GET /shipments/{id} ─────────────────────────
    const directUrl = `${FOURKITES_BASE}/${encodeURIComponent(args.externalLoadId)}`;
    try {
      const resp = await fetch(directUrl, { method: 'GET', headers });
      const text = await resp.text();
      if (resp.ok) {
        return {
          url: directUrl,
          status: resp.status,
          bodyJson: text,
          pagesScanned: 0,
          foundOnPage: null,
          note: 'direct fetch',
        };
      }
      if (resp.status !== 404) {
        return {
          url: directUrl,
          status: resp.status,
          bodyJson: text,
          pagesScanned: 0,
          foundOnPage: null,
          note: `direct fetch returned non-404 error; falling back NOT attempted`,
        };
      }
      // fall through to pagination
    } catch (err) {
      return {
        url: directUrl,
        status: null,
        bodyJson: '',
        pagesScanned: 0,
        foundOnPage: null,
        note: `direct fetch network error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // ─── Attempt 2: paginate /shipments and match by id OR loadNumber ──
    // loadNumber matching matters in practice: the value humans have is
    // the Order # (imported from FK's loadNumber), not the shipment id.
    const maxPages = args.maxPages ?? 50;
    const perPage = 100;
    let sampleJson: string | undefined;
    for (let page = 1; page <= maxPages; page++) {
      const listUrl = `${FOURKITES_BASE}?page=${page}&perPage=${perPage}`;
      const resp = await fetch(listUrl, { method: 'GET', headers });
      if (!resp.ok) {
        const text = await resp.text();
        return {
          url: listUrl,
          status: resp.status,
          bodyJson: text,
          pagesScanned: page,
          foundOnPage: null,
          note: `paginated fallback failed on page ${page}`,
        };
      }
      const data: any = await resp.json();
      const shipments: any[] = Array.isArray(data?.data?.shipments)
        ? data.data.shipments
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.shipments)
            ? data.shipments
            : Array.isArray(data)
              ? data
              : [];
      if (shipments.length === 0) {
        return {
          url: listUrl,
          status: resp.status,
          bodyJson: '',
          pagesScanned: page,
          foundOnPage: null,
          note: `paginated fallback exhausted at page ${page}; shipment not found${sampleJson ? ' — sampleJson carries the first shipment from page 1 for field inspection' : ''}`,
          sampleJson,
        };
      }
      if (page === 1 && !sampleJson) {
        sampleJson = JSON.stringify(shipments[0], null, 2);
      }
      const match = shipments.find(
        (s) =>
          s?.fourKitesShipmentID === args.externalLoadId ||
          s?.id === args.externalLoadId ||
          String(s?.fourKitesShipmentID ?? '') === args.externalLoadId ||
          String(s?.id ?? '') === args.externalLoadId ||
          String(s?.loadNumber ?? '') === args.externalLoadId,
      );
      if (match) {
        return {
          url: listUrl,
          status: resp.status,
          bodyJson: JSON.stringify(match, null, 2),
          pagesScanned: page,
          foundOnPage: page,
          note: 'fallback paginated — matched by id or loadNumber within list response',
        };
      }
    }

    return {
      url: `${FOURKITES_BASE}?page=1..${maxPages}`,
      status: null,
      bodyJson: '',
      pagesScanned: maxPages,
      foundOnPage: null,
      note: `paginated fallback ran ${maxPages} pages without finding externalLoadId=${args.externalLoadId}${sampleJson ? ' — sampleJson carries the first shipment from page 1 for field inspection' : ''}`,
      sampleJson,
    };
  },
});

// ============================================
// FOURKITES OUTBOUND PAYLOAD PREVIEW
//
// Constructs the EXACT request we'd send to FK's Dispatcher Update API
// for a given load right now. Same code path as the cron — calls the
// real `buildLocationUpdate` and surfaces the URL, headers (with the
// apikey redacted), and JSON body.
//
// Use to share with the customer / FK support for verification:
//   "This is the shape of what we POST every push tick. Confirm the
//   structure matches what your tenant expects."
//
// Does NOT actually POST. Read-only.
// ============================================

const DISPATCHER_PUSH_BASE =
  process.env.FOURKITES_DISPATCHER_URL ?? 'https://api.fourkites.com';
const DISPATCHER_PATH = '/load/update/dispatcher-api/async';

export const previewPushPayload = internalAction({
  args: {
    workosOrgId: v.string(),
    loadRef: v.string(),
  },
  returns: v.object({
    found: v.boolean(),
    note: v.string(),
    // Only populated when found===true and a position is available.
    method: v.optional(v.string()),
    url: v.optional(v.string()),
    // Raw HTTP header block (Convex validators disallow hyphenated keys
    // like 'Content-Type', so we render the headers as a copyable string
    // instead of a structured object). Apikey is always rendered as
    // "<REDACTED>" so the output is safe to share externally.
    headersRaw: v.optional(v.string()),
    body: v.optional(v.string()), // pretty-printed JSON string
    bodyParsed: v.optional(v.any()),
    // Source breakdown — what feeds the identifier the body shows
    identifierExplanation: v.optional(v.object({
      identifier: v.string(),
      identifierSource: v.string(), // 'orderNumber (FK loadNumber)' or 'externalLoadId (FK shipment ID, fallback)'
      rawIdentifier: v.string(),
      identifierType: v.string(),
    })),
    // The recordedAt of the GPS ping we'd send.
    pingRecordedAtIso: v.optional(v.string()),
    // Where that ping came from on our side (for traceability).
    pingSource: v.optional(v.string()), // 'load-tagged' | 'session-route via approach window'
    trackingStatus: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<any> => {
    const inputs: {
      loadId: any;
      internalId: string;
      externalLoadId: string;
      orderNumber: string;
      trackingStatus: string;
    } | null = await ctx.runQuery(
      internal.fourKitesDispatcherPushMutations.getPushPayloadInputsForLoad,
      { workosOrgId: args.workosOrgId, loadRef: args.loadRef },
    );

    if (!inputs) {
      return {
        found: false,
        note: `No FK-sourced load found for loadRef="${args.loadRef}" in org ${args.workosOrgId}. Try the internalId (e.g. "FK-109664457") or the bare externalLoadId.`,
      };
    }

    const position: {
      latitude: number;
      longitude: number;
      recordedAt: string;
    } | null = await ctx.runQuery(
      internal.externalTracking.getLatestPosition,
      { loadId: inputs.loadId as any, isSandbox: false },
    );

    if (!position) {
      return {
        found: true,
        note:
          `Load ${inputs.internalId} (${inputs.trackingStatus}) is FK-sourced ` +
          `but has no eligible GPS ping right now (getLatestPosition returned ` +
          `null — likely outside the 30-min approach window, or no session pings ` +
          `exist yet). The cron would skip this load on its next tick.`,
        trackingStatus: inputs.trackingStatus,
      };
    }

    // Mirror the exact identifier choice the cron makes in
    // fourKitesDispatcherPush.ts: orderNumber wins, externalLoadId as fallback.
    const identifierIsOrderNumber =
      inputs.orderNumber && inputs.orderNumber.length > 0;
    const identifier = identifierIsOrderNumber
      ? inputs.orderNumber
      : inputs.externalLoadId;
    const rawIdentifier = inputs.externalLoadId;

    const recordedAtMs = Date.parse(position.recordedAt);
    const update = buildLocationUpdate({
      externalLoadId: identifier,
      rawIdentifier,
      latitude: position.latitude,
      longitude: position.longitude,
      recordedAtMs,
    });

    const body = { updates: [update] };
    const url = `${DISPATCHER_PUSH_BASE.replace(/\/+$/, '')}${DISPATCHER_PATH}`;

    return {
      found: true,
      note:
        `Preview of what the cron WOULD POST for ${inputs.internalId} on its ` +
        `next tick (assuming no newer ping arrives). Read-only — nothing was sent.`,
      method: 'POST',
      url,
      headersRaw: 'Content-Type: application/json\napikey: <REDACTED>',
      body: JSON.stringify(body, null, 2),
      bodyParsed: body,
      identifierExplanation: {
        identifier,
        identifierSource: identifierIsOrderNumber
          ? 'orderNumber (FK loadNumber from inbound sync)'
          : 'externalLoadId (FK shipment ID, fallback — orderNumber was empty)',
        rawIdentifier,
        identifierType: 'loadNumber',
      },
      pingRecordedAtIso: position.recordedAt,
      pingSource:
        'getLatestPosition (max of load-tagged latest + session-route latest within 30-min approach window)',
      trackingStatus: inputs.trackingStatus,
    };
  },
});

// ============================================
// PUSH-HISTORY RECONSTRUCTION
//
// Replays the cron's push logic against the historical driverLocations
// data for a load. Produces an ordered timeline of "what we would have
// sent at each cron tick" — useful when we want to give FK support a
// log to grep against their processing receipts, but we only stored
// the latest payload (lastRequestBody).
//
// The reconstruction is APPROXIMATE:
//   - We don't have the original FK requestIds for each push.
//   - We assume a perfect 60s cron cadence with no missed ticks.
//   - We use the SAME dedup logic the real cron uses (only push if
//     the latest available ping is newer than the previous push's
//     recordedAt).
//
// AUDIT-ONLY: paired with lastRequestBody. Drop both when verified.
// ============================================

const CRON_INTERVAL_MS = 60 * 1000;

export const reconstructPushHistoryForLoad = internalAction({
  args: {
    workosOrgId: v.string(),
    loadRef: v.string(),
  },
  returns: v.object({
    found: v.boolean(),
    note: v.string(),
    loadRef: v.optional(v.string()),
    externalLoadId: v.optional(v.string()),
    orderNumber: v.optional(v.string()),
    trackingStatus: v.optional(v.string()),
    reconstructionStartIso: v.optional(v.string()),
    reconstructionEndIso: v.optional(v.string()),
    totalReconstructedPushes: v.optional(v.number()),
    payloads: v.optional(
      v.array(
        v.object({
          tickIso: v.string(),
          recordedAtIso: v.string(),
          latitude: v.number(),
          longitude: v.number(),
          pingOrigin: v.string(),
          pingSource: v.optional(v.string()),
          body: v.string(),
        }),
      ),
    ),
  }),
  handler: async (ctx, args): Promise<any> => {
    const inputs: any = await ctx.runQuery(
      internal.fourKitesDispatcherPushMutations.getPushHistoryReconstructionInputs,
      { workosOrgId: args.workosOrgId, loadRef: args.loadRef },
    );

    if (!inputs) {
      return {
        found: false,
        note:
          `No FK-sourced load found for loadRef="${args.loadRef}" in org ` +
          `${args.workosOrgId}, OR the load has no dispatchLegs / external id. ` +
          `Try the FK-prefixed internalId (e.g. "FK-109752730").`,
      };
    }

    if (inputs.pings.length === 0) {
      return {
        found: true,
        note: `Load ${inputs.internalId} has no pings in the reconstruction window — no payloads to replay.`,
        loadRef: inputs.internalId,
        externalLoadId: inputs.externalLoadId,
        orderNumber: inputs.orderNumber,
        trackingStatus: inputs.trackingStatus,
        totalReconstructedPushes: 0,
        payloads: [],
      };
    }

    // Reconstruction window: from the earliest approach floor to the
    // latest legEnd / now.
    const earliestApproachFloor = Math.min(
      ...inputs.legs.map((l: any) => l.approachFloorMs),
    );
    const reconStartMs = earliestApproachFloor;
    const reconEndMs = inputs.reconstructionEndMs;

    // Identifier (same logic as the real cron).
    const identifierIsOrderNumber =
      inputs.orderNumber && inputs.orderNumber.length > 0;
    const identifier = identifierIsOrderNumber
      ? inputs.orderNumber
      : inputs.externalLoadId;
    const rawIdentifier = inputs.externalLoadId;

    // Walk ticks at 60s intervals. At each tick, find the latest ping
    // with recordedAt <= tickTime. If that ping's recordedAt is greater
    // than the previous pushed recordedAt, simulate a push.
    const pings = inputs.pings as Array<{
      recordedAt: number;
      latitude: number;
      longitude: number;
      source?: string;
      origin: string;
    }>;

    const payloads: Array<{
      tickIso: string;
      recordedAtIso: string;
      latitude: number;
      longitude: number;
      pingOrigin: string;
      pingSource?: string;
      body: string;
    }> = [];

    let lastPushedRecordedAt = -Infinity;
    let pingCursor = 0;

    for (let tickMs = reconStartMs; tickMs <= reconEndMs; tickMs += CRON_INTERVAL_MS) {
      // Advance cursor to the latest ping with recordedAt <= tickMs.
      while (pingCursor < pings.length && pings[pingCursor].recordedAt <= tickMs) {
        pingCursor++;
      }
      const latestIdx = pingCursor - 1;
      if (latestIdx < 0) continue;
      const latest = pings[latestIdx];
      if (latest.recordedAt <= lastPushedRecordedAt) continue;

      const update = buildLocationUpdate({
        externalLoadId: identifier,
        rawIdentifier,
        latitude: latest.latitude,
        longitude: latest.longitude,
        recordedAtMs: latest.recordedAt,
      });
      const body = JSON.stringify(update);

      payloads.push({
        tickIso: new Date(tickMs).toISOString(),
        recordedAtIso: new Date(latest.recordedAt).toISOString(),
        latitude: latest.latitude,
        longitude: latest.longitude,
        pingOrigin: latest.origin,
        pingSource: latest.source,
        body,
      });

      lastPushedRecordedAt = latest.recordedAt;
    }

    return {
      found: true,
      note:
        `APPROXIMATE reconstruction of the cron's push history for ` +
        `${inputs.internalId}. Assumes perfect 60s tick cadence and the ` +
        `current cron's dedup logic. Does NOT include the original FK ` +
        `requestIds for each push (those are unrecoverable). FK support ` +
        `can match against their processing log by recordedAt / lat / lng.`,
      loadRef: inputs.internalId,
      externalLoadId: inputs.externalLoadId,
      orderNumber: inputs.orderNumber,
      trackingStatus: inputs.trackingStatus,
      reconstructionStartIso: new Date(reconStartMs).toISOString(),
      reconstructionEndIso: new Date(reconEndMs).toISOString(),
      totalReconstructedPushes: payloads.length,
      payloads,
    };
  },
});
