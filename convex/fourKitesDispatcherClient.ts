'use node';

// ============================================
// FOURKITES DISPATCHER UPDATE API — outbound HTTP client
// Spec: POST {base}/load/update/dispatcher-api/async
// Auth: apikey: <key> header (per FourKites docs)
// Rate limit: 60 req/min per API key
// Response: 202 with requestId on accept
// Docs URL (internal): https://docs.fourkites.com/api-reference/dispatcher-update-asynchronous-all-key-value
// ============================================

// ============================================
// PAYLOAD TYPES (subset — V1 scope is locationUpdate only)
// Keeping the shape additive so adding eventUpdate/stopUpdate/etc. later
// is a no-touch extension.
// ============================================

export interface DispatcherIdentifierKey {
  identifier: string;
  rawIdentifier?: string;
  identifierType: string; // FK-standard: loadNumber | proNumber | loadReferenceNumber | loadTrackingNumber | carrierReferenceNumber
}

export interface DispatcherLocationUpdate {
  latitude: string;  // FourKites takes lat/lng as STRINGS (per their docs)
  longitude: string;
  locatedAt: string; // RFC 3339 UTC, e.g. "2026-05-18T12:34:56Z"
  city?: string;
  state?: string;
  deliveredAt?: string;
}

export interface DispatcherLoadUpdateEntry {
  locationUpdate?: DispatcherLocationUpdate;
  // V2 hooks (intentionally typed but unused in V1):
  // etaUpdate, temperatureUpdate, loadInfoUpdate, eventUpdate, additionalData
}

export interface DispatcherUpdate {
  timeZone?: string; // default UTC per docs
  identifierKeys: DispatcherIdentifierKey[];
  loadUpdate?: DispatcherLoadUpdateEntry[];
  // V2 hooks: assignmentUpdate, stopUpdate
}

export interface DispatcherRequestBody {
  updates: DispatcherUpdate[];
}

export interface DispatcherSuccessBody {
  requestId: string;
  status: string; // "202"
  message: string;
  timestamp: string;
}

export type DispatcherPushResult =
  | { kind: 'ok'; requestId: string; raw: DispatcherSuccessBody }
  // API key invalid / revoked. Caller should disable the push or surface
  // to ops; do NOT retry on the next tick with the same key.
  | { kind: 'auth_failed'; status: number; message: string }
  // FourKites rejected the payload (bad identifier, missing required
  // field, etc.). Don't retry — re-pushing the same payload will fail
  // again. Caller logs and moves on.
  | { kind: 'validation_failed'; status: number; message: string }
  // Hit the 60 req/min ceiling. Honor Retry-After if present; otherwise
  // back off until next cron tick.
  | { kind: 'rate_limited'; retryAfterSec: number; responseBody?: string }
  // 5xx / network. Retry next cron tick naturally — no state change.
  | { kind: 'transient_error'; status?: number; message: string; responseBody?: string };

const DISPATCHER_PATH = '/load/update/dispatcher-api/async';

/**
 * POST a batch of Dispatcher Update entries.
 * The caller is responsible for batch sizing (FourKites doesn't publish a
 * hard limit on `updates[]` length; we cap at 100 per call for safety).
 */
export async function postDispatcherUpdates(args: {
  apiKey: string;
  baseUrl: string; // e.g. 'https://api.fourkites.com' or 'https://api-staging.fourkites.com'
  updates: DispatcherUpdate[];
}): Promise<DispatcherPushResult> {
  const url = `${stripTrailingSlash(args.baseUrl)}${DISPATCHER_PATH}`;
  const body: DispatcherRequestBody = { updates: args.updates };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // FourKites uses a custom 'apikey' header (not Authorization).
        apikey: args.apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      kind: 'transient_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (response.status === 401 || response.status === 403) {
    const message = await safeReadError(response);
    return { kind: 'auth_failed', status: response.status, message };
  }
  if (response.status === 429) {
    const header = response.headers.get('Retry-After');
    const sec = header ? parseInt(header, 10) : 60;
    const body = await safeReadError(response);
    return {
      kind: 'rate_limited',
      retryAfterSec: Number.isFinite(sec) ? sec : 60,
      responseBody: body,
    };
  }
  if (response.status >= 400 && response.status < 500) {
    const message = await safeReadError(response);
    return { kind: 'validation_failed', status: response.status, message };
  }
  if (response.status >= 500) {
    const message = await safeReadError(response);
    return {
      kind: 'transient_error',
      status: response.status,
      message,
      responseBody: message,
    };
  }

  // 2xx — FourKites returns 202 on accept.
  let parsed: DispatcherSuccessBody;
  try {
    parsed = (await response.json()) as DispatcherSuccessBody;
  } catch (err) {
    return {
      kind: 'transient_error',
      status: response.status,
      message: `Failed to parse Dispatcher success body: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (!parsed || typeof parsed.requestId !== 'string') {
    return {
      kind: 'transient_error',
      status: response.status,
      message: 'Malformed Dispatcher success body (missing requestId)',
      responseBody: JSON.stringify(parsed).slice(0, 500),
    };
  }

  return { kind: 'ok', requestId: parsed.requestId, raw: parsed };
}

// ============================================
// PAYLOAD BUILDERS
// Exported separately so they can be unit-tested without the HTTP layer.
// ============================================

// Per FourKites docs the only identifierTypes that get matching priority
// are: loadNumber, proNumber, loadReferenceNumber, loadTrackingNumber,
// carrierReferenceNumber. Anything outside that set is treated as
// informational and silently degrades to the no-billToCode default
// (match against FK Load Number across the carrier's whole network).
// We default to 'loadNumber' because that aligns with what we receive
// during inbound sync (shipment.loadNumber → load.orderNumber).
const IDENTIFIER_TYPE_DEFAULT = 'loadNumber';

/**
 * Build a single DispatcherUpdate for a load's latest GPS ping.
 *
 * Lat/lng are sent as strings per the FourKites spec (their docs example
 * shows quoted decimals: "42.42", "-87.622003"). Convert from Otoqa's
 * float-degree storage at the boundary.
 *
 * locatedAt is RFC 3339 UTC with no fractional seconds — matches the
 * FourKites doc example "YYYY-MM-DDTHH:MM:SSZ".
 */
export function buildLocationUpdate(args: {
  externalLoadId: string;
  rawIdentifier?: string;
  identifierType?: string;
  latitude: number;
  longitude: number;
  recordedAtMs: number;
  city?: string;
  state?: string;
}): DispatcherUpdate {
  return {
    timeZone: 'UTC',
    identifierKeys: [
      {
        identifier: args.externalLoadId,
        rawIdentifier: args.rawIdentifier,
        identifierType: args.identifierType ?? IDENTIFIER_TYPE_DEFAULT,
      },
    ],
    loadUpdate: [
      {
        locationUpdate: {
          latitude: formatCoordinate(args.latitude),
          longitude: formatCoordinate(args.longitude),
          locatedAt: toRfc3339Utc(args.recordedAtMs),
          city: args.city,
          state: args.state,
        },
      },
    ],
  };
}

function formatCoordinate(deg: number): string {
  // Match FourKites doc precision (6 decimals).
  return deg.toFixed(6);
}

function toRfc3339Utc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function safeReadError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return `<unreadable body, status=${response.status}>`;
  }
}
