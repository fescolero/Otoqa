'use node';

// ============================================
// SAMSARA API CLIENT
// Outbound HTTP for the Vehicle Stats GPS feed. Plain TS module — no Convex
// function wrappers here. Called from samsaraIngest's "use node" action.
//
// Endpoint: GET /fleet/vehicles/stats/feed?types=gps&after={cursor}
// Docs: https://developers.samsara.com/openapi/samsara-api.json
// Rate limit (per their docs page): 50 req/sec per org on this endpoint.
// We poll at 0.1 req/sec per integration so headroom is enormous.
// ============================================

export type SamsaraEnvironment = 'sandbox' | 'production';

// Samsara has separate base URLs per region. V1 supports US only; EU/etc.
// can be added by extending this map (each org keeps its own region pinned
// on the integration row when we add the field).
const BASE_URL: Record<SamsaraEnvironment, string> = {
  production: 'https://api.samsara.com',
  // Samsara doesn't publish a public sandbox; "sandbox" here means a
  // dedicated test org on the production API. Same hostname.
  sandbox: 'https://api.samsara.com',
};

export interface SamsaraGpsPoint {
  latitude: number;
  longitude: number;
  headingDegrees?: number;
  speedMilesPerHour?: number;
  time: string; // RFC 3339
}

export interface SamsaraVehicleEntry {
  id: string; // Samsara vehicle ID
  name: string;
  gps?: SamsaraGpsPoint[];
}

export interface SamsaraFeedResponse {
  data: SamsaraVehicleEntry[];
  pagination: {
    endCursor: string;
    hasNextPage: boolean;
  };
}

export type FetchVehicleStatsResult =
  | { kind: 'ok'; body: SamsaraFeedResponse }
  // Token rejected. Caller should disable the integration and surface to ops.
  | { kind: 'auth_failed'; status: number; message: string }
  // Cursor is stale/invalid. Caller should clear the cursor and resume from
  // current state on the next tick. Small data gap, no crash.
  | { kind: 'cursor_invalid'; status: number; message: string }
  // Samsara rate-limited us. Caller honors Retry-After and skips this tick.
  | { kind: 'rate_limited'; retryAfterSec: number }
  // 5xx or network error. Transient — next tick will retry naturally.
  | { kind: 'transient_error'; status?: number; message: string };

/**
 * Fetch the next batch from Samsara's Vehicle Stats GPS feed.
 * Single-call only — caller is responsible for the hasNextPage drain loop.
 */
export async function fetchVehicleStatsFeed(args: {
  apiToken: string;
  environment: SamsaraEnvironment;
  cursor?: string;
  // Optional comma-separated vehicleId filter (caps payload when we only
  // care about trucks mapped in this org). Undefined = all vehicles in
  // the org's Samsara fleet.
  vehicleIds?: string[];
}): Promise<FetchVehicleStatsResult> {
  const url = new URL(`${BASE_URL[args.environment]}/fleet/vehicles/stats/feed`);
  url.searchParams.set('types', 'gps');
  if (args.cursor) url.searchParams.set('after', args.cursor);
  if (args.vehicleIds && args.vehicleIds.length > 0) {
    url.searchParams.set('vehicleIds', args.vehicleIds.join(','));
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${args.apiToken}`,
        Accept: 'application/json',
      },
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
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 60;
    return {
      kind: 'rate_limited',
      retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : 60,
    };
  }

  // Samsara returns 400 on a stale cursor (per their cursor-pagination
  // conventions). Treat any 4xx with a cursor present as cursor_invalid so
  // the caller can recover by dropping it.
  if (response.status >= 400 && response.status < 500) {
    const message = await safeReadError(response);
    if (args.cursor) {
      return { kind: 'cursor_invalid', status: response.status, message };
    }
    return { kind: 'transient_error', status: response.status, message };
  }

  if (response.status >= 500) {
    const message = await safeReadError(response);
    return { kind: 'transient_error', status: response.status, message };
  }

  let body: SamsaraFeedResponse;
  try {
    body = (await response.json()) as SamsaraFeedResponse;
  } catch (err) {
    return {
      kind: 'transient_error',
      status: response.status,
      message: `Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!body || !Array.isArray(body.data) || !body.pagination) {
    return {
      kind: 'transient_error',
      status: response.status,
      message: 'Malformed Samsara response (missing data[] or pagination)',
    };
  }

  return { kind: 'ok', body };
}

async function safeReadError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return `<unreadable body, status=${response.status}>`;
  }
}

// ============================================
// FLEET ROSTER — for VIN-based truck mapping
// ============================================

export interface SamsaraVehicleSummary {
  id: string; // Samsara vehicle ID
  name: string;
  vehicleVin?: string; // Returned by Samsara when available
}

interface SamsaraListVehiclesPage {
  data: SamsaraVehicleSummary[];
  pagination: {
    endCursor: string;
    hasNextPage: boolean;
  };
}

export type FetchAllVehiclesResult =
  | { kind: 'ok'; vehicles: SamsaraVehicleSummary[] }
  | { kind: 'auth_failed'; status: number; message: string }
  | { kind: 'rate_limited'; retryAfterSec: number }
  | { kind: 'transient_error'; status?: number; message: string };

const MAX_VEHICLE_PAGES = 50; // 512/page (Samsara max) × 50 = 25,600 vehicles ceiling.

/**
 * Fetch every vehicle in the org's Samsara fleet via GET /fleet/vehicles.
 * Drains cursor pagination internally — caller gets the whole list.
 * Used by the VIN-based truck-mapping action.
 */
export async function fetchAllVehicles(args: {
  apiToken: string;
  environment: SamsaraEnvironment;
}): Promise<FetchAllVehiclesResult> {
  const all: SamsaraVehicleSummary[] = [];
  let cursor: string | undefined;

  for (let i = 0; i < MAX_VEHICLE_PAGES; i++) {
    const url = new URL(`${BASE_URL[args.environment]}/fleet/vehicles`);
    url.searchParams.set('limit', '512');
    if (cursor) url.searchParams.set('after', cursor);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${args.apiToken}`,
          Accept: 'application/json',
        },
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
      return {
        kind: 'rate_limited',
        retryAfterSec: Number.isFinite(sec) ? sec : 60,
      };
    }
    if (response.status >= 400) {
      const message = await safeReadError(response);
      return { kind: 'transient_error', status: response.status, message };
    }

    let page: SamsaraListVehiclesPage;
    try {
      page = (await response.json()) as SamsaraListVehiclesPage;
    } catch (err) {
      return {
        kind: 'transient_error',
        status: response.status,
        message: `Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!page || !Array.isArray(page.data) || !page.pagination) {
      return {
        kind: 'transient_error',
        status: response.status,
        message: 'Malformed Samsara response (missing data[] or pagination)',
      };
    }

    for (const v of page.data) {
      if (v.id) all.push({ id: v.id, name: v.name, vehicleVin: v.vehicleVin });
    }

    if (!page.pagination.hasNextPage) break;
    cursor = page.pagination.endCursor;
    if (!cursor) break; // defensive — shouldn't happen if hasNextPage was true
  }

  return { kind: 'ok', vehicles: all };
}
