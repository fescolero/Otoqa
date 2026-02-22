import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';

// ============================================
// EXTERNAL TRACKING API - HTTP ROUTER
// Versioned endpoints at /v1/tracking/*
// httpAction runs in V8 runtime (no Node.js)
// Uses Web Crypto for SHA-256, calls "use node" actions for other crypto
// ============================================

const http = httpRouter();

// ============================================
// HELPERS
// ============================================

function jsonResponse(data: any, status: number = 200, headers?: Record<string, string>): Response {
  const responseHeaders = new Headers({
    'Content-Type': 'application/json',
    ...headers,
  });
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  requestId: string,
  rateLimitHeaders?: Record<string, string>
): Response {
  return jsonResponse(
    { error: { code, message, requestId } },
    status,
    rateLimitHeaders
  );
}

function generateRequestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `req_${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * SHA-256 hash using Web Crypto API (available in V8 runtime)
 */
async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Rate limit tier to requests/min mapping
const RATE_LIMITS: Record<string, number> = {
  low: 60,
  medium: 300,
  high: 1000,
};

interface AuthContext {
  keyId: string;
  workosOrgId: string;
  partnerName: string;
  permissions: string[];
  allowedLoadSources?: string[];
  environment: 'sandbox' | 'production';
  rateLimitPerMin: number;
}

// ============================================
// AUTH MIDDLEWARE (runs in httpAction context)
// ============================================

async function authenticateRequest(
  ctx: any,
  request: Request,
  requestId: string
): Promise<AuthContext | Response> {
  // Extract bearer token
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return errorResponse('UNAUTHORIZED', 'Missing or invalid Authorization header', 401, requestId);
  }

  const rawKey = authHeader.substring(7).trim();
  if (!rawKey) {
    return errorResponse('UNAUTHORIZED', 'Empty API key', 401, requestId);
  }

  // Hash the key using Web Crypto
  const keyHash = await sha256(rawKey);

  // Look up key
  const keyData = await ctx.runQuery(internal.externalTrackingAuth.validateKeyByHash, { keyHash });
  if (!keyData) {
    return errorResponse('UNAUTHORIZED', 'Invalid or expired API key', 401, requestId);
  }

  // Check environment matches key prefix
  const expectedPrefix = keyData.environment === 'sandbox' ? 'otq_test_' : 'otq_live_';
  if (!rawKey.startsWith(expectedPrefix)) {
    return errorResponse('UNAUTHORIZED', 'Key environment mismatch', 401, requestId);
  }

  // IP allowlist check
  // WARNING: Not enforced — Convex httpAction does not expose client IP via
  // forwarded headers. The ipAllowlist field is stored for future enforcement.
  if (keyData.ipAllowlist && keyData.ipAllowlist.length > 0) {
    console.warn(
      `[Security] IP allowlist configured for key ${keyData.keyId} but cannot be enforced in current runtime`
    );
  }

  // Determine rate limit
  const rateLimitPerMin = keyData.rateLimitTier === 'custom'
    ? (keyData.customRateLimit ?? 300)
    : (RATE_LIMITS[keyData.rateLimitTier] ?? 300);

  // Rate limit enforcement using sliding window via audit log count
  // Check recent request count for this key within the last minute
  const oneMinuteAgo = Date.now() - 60_000;
  const recentRequestCount = await ctx.runQuery(
    internal.externalTrackingAuth.countRecentRequests,
    { keyId: keyData.keyId, since: oneMinuteAgo }
  );

  if (recentRequestCount >= rateLimitPerMin) {
    const retryAfter = '60';
    return errorResponse(
      'RATE_LIMITED',
      `Rate limit exceeded. Limit: ${rateLimitPerMin} requests/min`,
      429,
      requestId,
      {
        'Retry-After': retryAfter,
        'X-RateLimit-Limit': rateLimitPerMin.toString(),
        'X-RateLimit-Remaining': '0',
      }
    );
  }

  // Touch lastUsedAt (debounced - fire and forget)
  ctx.runMutation(internal.externalTrackingAuth.touchKeyLastUsed, { keyId: keyData.keyId }).catch(() => {});

  return {
    keyId: keyData.keyId,
    workosOrgId: keyData.workosOrgId,
    partnerName: keyData.partnerName,
    permissions: keyData.permissions,
    allowedLoadSources: keyData.allowedLoadSources ?? undefined,
    environment: keyData.environment as 'sandbox' | 'production',
    rateLimitPerMin,
  };
}

function hasPermission(auth: AuthContext, permission: string): boolean {
  return auth.permissions.includes(permission);
}

// ============================================
// HEALTH CHECK
// ============================================

http.route({
  path: '/v1/health',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const requestId = request.headers.get('X-Request-Id') || generateRequestId();
    const auth = await authenticateRequest(ctx, request, requestId);
    if (auth instanceof Response) return auth;

    return jsonResponse({
      status: 'ok',
      environment: auth.environment,
      partner: auth.partnerName,
      permissions: auth.permissions,
      rateLimit: {
        tier: auth.rateLimitPerMin <= 60 ? 'low' : auth.rateLimitPerMin <= 300 ? 'medium' : 'high',
        limit: auth.rateLimitPerMin,
      },
    }, 200, { 'X-Request-Id': requestId });
  }),
});

// ============================================
// LIST TRACKED LOADS
// ============================================

http.route({
  path: '/v1/tracking/loads',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const requestId = request.headers.get('X-Request-Id') || generateRequestId();
    const startTime = Date.now();
    const auth = await authenticateRequest(ctx, request, requestId);
    if (auth instanceof Response) return auth;

    if (!hasPermission(auth, 'tracking:read')) {
      return errorResponse('FORBIDDEN', 'Missing tracking:read permission', 403, requestId);
    }

    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'active';
    const validStatuses = ['active', 'completed', 'all'];
    if (!validStatuses.includes(status)) {
      return errorResponse('INVALID_PARAMETER', `Invalid status filter: '${status}'. Valid values: ${validStatuses.join(', ')}`, 400, requestId);
    }
    const parsedLimit = parseInt(url.searchParams.get('limit') || '50');
    if (isNaN(parsedLimit) || parsedLimit < 1) {
      return errorResponse('INVALID_PARAMETER', 'limit must be a positive integer', 400, requestId);
    }
    const limit = Math.min(parsedLimit, 100);

    const result = await ctx.runQuery(internal.externalTracking.listTrackedLoads, {
      workosOrgId: auth.workosOrgId,
      environment: auth.environment,
      trackingStatusFilter: status,
      limit,
    });

    // Audit log (fire and forget)
    ctx.runMutation(internal.externalTrackingAuth.writeAuditLog, {
      workosOrgId: auth.workosOrgId,
      partnerKeyId: auth.keyId as any,
      requestId,
      endpoint: '/v1/tracking/loads',
      method: 'GET',
      statusCode: 200,
      ipAddress: undefined,
      userAgent: request.headers.get('User-Agent') || undefined,
      responseTimeMs: Date.now() - startTime,
    }).catch(() => {});

    return jsonResponse({
      loads: result.loads,
      pagination: { hasMore: result.hasMore },
    }, 200, { 'X-Request-Id': requestId });
  }),
});

// ============================================
// LOAD POSITIONS (with path prefix for :ref)
// ============================================

http.route({
  pathPrefix: '/v1/tracking/loads/',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const requestId = request.headers.get('X-Request-Id') || generateRequestId();
    const startTime = Date.now();
    const auth = await authenticateRequest(ctx, request, requestId);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const pathParts = url.pathname.replace('/v1/tracking/loads/', '').split('/');
    const ref = decodeURIComponent(pathParts[0]);
    const subResource = pathParts[1]; // "positions", "latest", "stops", "events"

    if (!ref) {
      return errorResponse('INVALID_PARAMETER', 'Load reference is required', 400, requestId);
    }

    // Resolve the load (BOLA check happens inside)
    const refType = url.searchParams.get('refType') as 'external' | 'internal' | 'order' | null;
    const load = await ctx.runQuery(internal.externalTracking.resolveLoad, {
      ref,
      refType: refType || undefined,
      workosOrgId: auth.workosOrgId,
      environment: auth.environment,
    });

    if (!load) {
      // Sanitize ref to prevent reflected content in error responses
      const sanitizedRef = ref.replace(/[^\w\-.:]/g, '').substring(0, 100);
      const resp = errorResponse('LOAD_NOT_FOUND', `No load found with reference '${sanitizedRef}'`, 404, requestId);
      ctx.runMutation(internal.externalTrackingAuth.writeAuditLog, {
        workosOrgId: auth.workosOrgId,
        partnerKeyId: auth.keyId as any,
        requestId,
        endpoint: `/v1/tracking/loads/${ref}/${subResource || ''}`,
        method: 'GET',
        statusCode: 404,
        ipAddress: undefined,
        userAgent: request.headers.get('User-Agent') || undefined,
        responseTimeMs: Date.now() - startTime,
      }).catch(() => {});
      return resp;
    }

    let responseData: any;
    let statusCode = 200;
    let requiredPermission = 'tracking:read';

    if (!subResource || subResource === 'positions') {
      // GET /v1/tracking/loads/:ref/positions
      if (!hasPermission(auth, 'tracking:read')) {
        return errorResponse('FORBIDDEN', 'Missing tracking:read permission', 403, requestId);
      }

      const since = url.searchParams.get('since');
      const until = url.searchParams.get('until');
      const limit = url.searchParams.get('limit');

      // Validate date parameters
      const sinceTs = since ? new Date(since).getTime() : undefined;
      const untilTs = until ? new Date(until).getTime() : undefined;
      if (since && (sinceTs === undefined || isNaN(sinceTs))) {
        return errorResponse('INVALID_PARAMETER', 'since must be a valid ISO date string', 400, requestId);
      }
      if (until && (untilTs === undefined || isNaN(untilTs))) {
        return errorResponse('INVALID_PARAMETER', 'until must be a valid ISO date string', 400, requestId);
      }
      // Validate limit
      const parsedPosLimit = limit ? parseInt(limit) : undefined;
      if (limit && (parsedPosLimit === undefined || isNaN(parsedPosLimit) || parsedPosLimit < 1)) {
        return errorResponse('INVALID_PARAMETER', 'limit must be a positive integer', 400, requestId);
      }

      const result = await ctx.runQuery(internal.externalTracking.getPositions, {
        loadId: load.loadId,
        isSandbox: load.isSandbox,
        since: sinceTs,
        until: untilTs,
        limit: parsedPosLimit ? Math.min(parsedPosLimit, 1000) : undefined,
      });

      // ETag based on latest recordedAt
      if (result.latestRecordedAt) {
        const etag = `"${result.latestRecordedAt}"`;
        const ifNoneMatch = request.headers.get('If-None-Match');
        if (ifNoneMatch === etag) {
          return new Response(null, {
            status: 304,
            headers: { 'X-Request-Id': requestId, 'ETag': etag },
          });
        }
      }

      responseData = {
        loadRef: load.internalId,
        externalLoadId: load.externalLoadId,
        trackingStatus: load.trackingStatus,
        positions: result.positions,
        pagination: {
          hasMore: result.hasMore,
          cursor: result.cursor,
        },
      };
    } else if (subResource === 'latest') {
      // GET /v1/tracking/loads/:ref/latest
      if (!hasPermission(auth, 'tracking:read')) {
        return errorResponse('FORBIDDEN', 'Missing tracking:read permission', 403, requestId);
      }

      const position = await ctx.runQuery(internal.externalTracking.getLatestPosition, {
        loadId: load.loadId,
        isSandbox: load.isSandbox,
      });

      responseData = {
        loadRef: load.internalId,
        trackingStatus: load.trackingStatus,
        position,
      };
    } else if (subResource === 'stops') {
      // GET /v1/tracking/loads/:ref/stops
      if (!hasPermission(auth, 'tracking:read')) {
        return errorResponse('FORBIDDEN', 'Missing tracking:read permission', 403, requestId);
      }

      const stops = await ctx.runQuery(internal.externalTracking.getStops, {
        loadId: load.loadId,
        isSandbox: load.isSandbox,
        workosOrgId: auth.workosOrgId,
      });

      responseData = {
        loadRef: load.internalId,
        stops,
      };
    } else if (subResource === 'events') {
      // GET /v1/tracking/loads/:ref/events
      if (!hasPermission(auth, 'tracking:events')) {
        return errorResponse('FORBIDDEN', 'Missing tracking:events permission', 403, requestId);
      }
      requiredPermission = 'tracking:events';

      const events = await ctx.runQuery(internal.externalTracking.getStatusEvents, {
        loadId: load.loadId,
        isSandbox: load.isSandbox,
        workosOrgId: auth.workosOrgId,
      });

      responseData = {
        loadRef: load.internalId,
        events,
      };
    } else {
      return errorResponse('INVALID_PARAMETER', `Unknown sub-resource: ${subResource}`, 400, requestId);
    }

    // Audit log (fire and forget)
    ctx.runMutation(internal.externalTrackingAuth.writeAuditLog, {
      workosOrgId: auth.workosOrgId,
      partnerKeyId: auth.keyId as any,
      requestId,
      endpoint: `/v1/tracking/loads/${ref}/${subResource || 'positions'}`,
      method: 'GET',
      statusCode,
      ipAddress: undefined,
      userAgent: request.headers.get('User-Agent') || undefined,
      responseTimeMs: Date.now() - startTime,
    }).catch(() => {});

    const headers: Record<string, string> = { 'X-Request-Id': requestId };
    if (responseData?.positions?.length > 0) {
      const latestPos = responseData.positions[responseData.positions.length - 1];
      if (latestPos?.recordedAt) {
        headers['ETag'] = `"${latestPos.recordedAt}"`;
      }
    }

    return jsonResponse(responseData, statusCode, headers);
  }),
});

export default http;
