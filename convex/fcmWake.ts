import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server';
import { internal } from './_generated/api';

// ============================================================================
// FCM WAKE-UP — server-side stale-session wake dispatch
// ============================================================================
//
// Every minute, the fcmWake.sweep cron scans active driverSessions whose
// lastPingAt is older than STALE_THRESHOLD_MS and schedules a per-session
// sendWake action. sendWake wraps a claim-then-send-then-record sequence
// so concurrent sweep invocations can't double-fire:
//
//   sweep (mutation) ──schedules──> sendWake (action)
//                                      │
//                                      ├── claimSendSlot (mutation)
//                                      │       atomic: checks cooldown +
//                                      │       backoff, aborts if blocked,
//                                      │       patches fcmLastPushAt=now
//                                      │
//                                      ├── mintFcmAccessToken()
//                                      │       signs a short-lived JWT
//                                      │       with the service-account
//                                      │       private key, exchanges it
//                                      │       at Google's token endpoint
//                                      │
//                                      ├── POST FCM HTTP v1 /messages:send
//                                      │
//                                      └── recordResult (mutation)
//                                              updates fcmConsecutiveFailures
//                                              + fcmBackoffUntil based on the
//                                              response. On invalid-token
//                                              responses, wipes pushToken
//                                              fields on the session row.
//
// Auth: JWT is RS256-signed via Web Crypto API (V8 runtime — no "use node"
// needed). The service-account JSON lives in the FCM_SERVICE_ACCOUNT_JSON
// Convex env var. See mobile/docs/gps-tracking-architecture.md § Phase 1.
//
// iOS handling: we skip sessions with pushTokenPlatform='ios' in sweep
// today. Phase 4 (iOS parity) will resolve the Option A-vs-B question
// (add Firebase iOS SDK so we get FCM tokens, or switch the server to
// APNs HTTP/2 for iOS). Without that resolution, raw APNs tokens
// cannot be delivered via FCM HTTP v1 — the `message.token` field
// expects an FCM registration token, not an APNs device token.
// ============================================================================

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

// Silence threshold that flags a session as a wake candidate. 2 min matches
// the § 5.3 design — long enough for a single missed sync to not trigger,
// short enough that a genuinely-killed FGS gets revived promptly.
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

// Minimum gap between successful wake dispatches per session. Protects
// against wake-storms on devices that consistently fail to resume (e.g.,
// bricked device, disabled FGS). Cap matches the § 6.2 doc.
const COOLDOWN_MS = 5 * 60 * 1000;

// Sweep batch ceiling. Convex mutations have per-call limits on document
// reads; .take(500) leaves generous headroom for the per-doc filter work.
const MAX_SWEEP_BATCH = 500;

// Exponential backoff after FCM transient errors (QUOTA_EXCEEDED,
// UNAVAILABLE, INTERNAL). 1min << n, capped at 2^6 = 64× (~64 min).
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_SHIFT = 6;

// OAuth2 scope required for FCM HTTP v1 send.
const FCM_OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
// Default if the service account JSON omits token_uri (it always includes
// one in practice; fallback is defensive).
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

type FcmServiceAccount = {
  type: 'service_account';
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
};

type FcmErrorCode =
  | 'UNREGISTERED'
  | 'INVALID_ARGUMENT'
  | 'SENDER_ID_MISMATCH'
  | 'QUOTA_EXCEEDED'
  | 'UNAVAILABLE'
  | 'INTERNAL'
  | 'THIRD_PARTY_AUTH_ERROR'
  | 'UNSPECIFIED_ERROR'
  | (string & {});

type WakeOutcome =
  | { kind: 'success' }
  | { kind: 'invalid_token'; errorCode: FcmErrorCode }
  | { kind: 'transient'; errorCode: FcmErrorCode }
  | { kind: 'config_error'; message: string };

// ---------------------------------------------------------------------------
// FCM AUTH + HTTP HELPERS (V8 runtime, Web Crypto API)
// ---------------------------------------------------------------------------

function loadServiceAccount(): FcmServiceAccount {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      'FCM_SERVICE_ACCOUNT_JSON not set — see mobile/docs/gps-tracking-architecture.md § Pre-work',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  const sa = parsed as Partial<FcmServiceAccount>;
  if (!sa.private_key || !sa.client_email || !sa.project_id) {
    throw new Error(
      'FCM_SERVICE_ACCOUNT_JSON missing required fields (private_key, client_email, project_id)',
    );
  }
  return sa as FcmServiceAccount;
}

function base64urlFromBytes(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlFromString(s: string): string {
  return base64urlFromBytes(new TextEncoder().encode(s));
}

/**
 * Mint a short-lived (1h) Google OAuth2 access token for the FCM
 * messaging scope. Uses the service-account private key to sign a JWT
 * and exchanges it at Google's token endpoint. No caching — at the 1b
 * scope this runs once per sendWake invocation (bounded by the 5-min
 * per-session cooldown). If production volume justifies it, a future
 * PR can cache in a singleton `systemState` row.
 */
async function mintFcmAccessToken(): Promise<string> {
  const sa = loadServiceAccount();
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64urlFromString(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }),
  );
  const claims = base64urlFromString(
    JSON.stringify({
      iss: sa.client_email,
      scope: FCM_OAUTH_SCOPE,
      aud: sa.token_uri ?? GOOGLE_TOKEN_ENDPOINT,
      exp: nowSec + 3600,
      iat: nowSec,
    }),
  );
  const signingInput = `${header}.${claims}`;

  // Parse PEM → PKCS#8 DER, import as RSASSA-PKCS1-v1_5 (= RS256).
  const pemBody = sa.private_key
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${base64urlFromBytes(new Uint8Array(sig))}`;

  const res = await fetch(sa.token_uri ?? GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `FCM token mint failed: HTTP ${res.status} — ${body.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error('FCM token mint returned no access_token');
  }
  return data.access_token;
}

/**
 * Extract the FCM error code (UNREGISTERED, INVALID_ARGUMENT, etc.) from
 * an HTTP v1 error body. Google nests the code inside
 * error.details[].errorCode when the detail has @type
 * "...FcmError". Falls back to error.status (e.g. "INVALID_ARGUMENT")
 * which is often the same value.
 */
function extractFcmErrorCode(body: unknown): FcmErrorCode {
  type ErrShape = {
    error?: {
      status?: string;
      details?: Array<{
        '@type'?: string;
        errorCode?: string;
      }>;
    };
  };
  const err = (body as ErrShape).error;
  if (!err) return 'UNSPECIFIED_ERROR';
  const detail = err.details?.find((d) =>
    (d['@type'] ?? '').endsWith('FcmError'),
  );
  return (detail?.errorCode ?? err.status ?? 'UNSPECIFIED_ERROR') as FcmErrorCode;
}

function classifyOutcome(errorCode: FcmErrorCode): WakeOutcome {
  switch (errorCode) {
    case 'UNREGISTERED':
    case 'INVALID_ARGUMENT':
    case 'SENDER_ID_MISMATCH':
      return { kind: 'invalid_token', errorCode };
    case 'QUOTA_EXCEEDED':
    case 'UNAVAILABLE':
    case 'INTERNAL':
    case 'THIRD_PARTY_AUTH_ERROR':
      return { kind: 'transient', errorCode };
    default:
      return { kind: 'transient', errorCode };
  }
}

// ---------------------------------------------------------------------------
// INTERNAL QUERIES
// ---------------------------------------------------------------------------

/**
 * Find active sessions that are overdue for a wake push. Called from the
 * sweep cron. Filters happen in-query for indexed selectivity; flag/org
 * gating happens in the sweep handler (which can cache per-org lookups
 * across the whole batch).
 */
export const findStaleSessionsForWake = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      sessionId: v.id('driverSessions'),
      driverId: v.id('drivers'),
      organizationId: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const threshold = Date.now() - STALE_THRESHOLD_MS;
    // by_active_lastping is [status, lastPingAt]. We want sessions that
    // have actually pinged AT LEAST ONCE and then gone quiet — a session
    // that has never pinged isn't "stale," it just hasn't started yet
    // (or it has a broken client that never attributes sessionId to
    // pings, which would wake-flood every minute if we included it).
    //
    // Empirical finding: in Convex indexes, `lastPingAt = undefined`
    // sorts before all numbers, and `.lt(threshold)` INCLUDES those
    // undefined entries (verified via a live sweep that returned an
    // undefined-lastPingAt session). An earlier version of this query
    // assumed the opposite and would have wake-flooded every active
    // session system-wide. The explicit `.gt('lastPingAt', 0)` bound
    // here guarantees we skip undefined/zero values regardless of
    // Convex's undefined-sort semantics.
    const rows = await ctx.db
      .query('driverSessions')
      .withIndex('by_active_lastping', (q) =>
        q.eq('status', 'active').gt('lastPingAt', 0).lt('lastPingAt', threshold),
      )
      .take(MAX_SWEEP_BATCH);

    return rows
      .filter(
        (s) =>
          s.pushToken !== undefined &&
          // iOS tokens can't be delivered via FCM HTTP v1 without the
          // Firebase iOS SDK (see file header). Skip until Phase 4
          // resolves the A-vs-B question.
          s.pushTokenPlatform === 'android',
      )
      .map((s) => ({
        sessionId: s._id,
        driverId: s.driverId,
        organizationId: s.organizationId,
      }));
  },
});

/**
 * Check whether fcm_wake_enabled is true for a specific org.
 */
export const isFcmWakeEnabledForOrg = internalQuery({
  args: { orgId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { orgId }) => {
    const row = await ctx.db
      .query('featureFlags')
      .withIndex('by_org_key', (q) =>
        q.eq('workosOrgId', orgId).eq('key', 'fcm_wake_enabled'),
      )
      .first();
    return row?.value === 'true';
  },
});

// ---------------------------------------------------------------------------
// CRON HANDLER — sweep
// ---------------------------------------------------------------------------

/**
 * Fan-out handler for the every-1-min cron. Reads stale candidates, gates
 * on per-org fcm_wake_enabled, schedules a sendWake action per eligible
 * session. Deliberately does NOT check cooldown / backoff here — the
 * atomic check lives in claimSendSlot so concurrent sweep invocations
 * (cron overlap, manual re-runs) don't race each other into duplicate
 * dispatches.
 */
export const sweep = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const candidates = await ctx.runQuery(
      internal.fcmWake.findStaleSessionsForWake,
      {},
    );
    if (candidates.length === 0) return null;

    const orgFlagCache = new Map<string, boolean>();
    const flagEnabled = async (orgId: string): Promise<boolean> => {
      const cached = orgFlagCache.get(orgId);
      if (cached !== undefined) return cached;
      const enabled = await ctx.runQuery(
        internal.fcmWake.isFcmWakeEnabledForOrg,
        { orgId },
      );
      orgFlagCache.set(orgId, enabled);
      return enabled;
    };

    let scheduled = 0;
    let gatedOut = 0;
    for (const c of candidates) {
      if (!(await flagEnabled(c.organizationId))) {
        gatedOut++;
        continue;
      }
      await ctx.scheduler.runAfter(0, internal.fcmWake.sendWake, {
        sessionId: c.sessionId,
      });
      scheduled++;
    }

    console.warn(
      `[fcmWake.sweep] scanned=${candidates.length} scheduled=${scheduled} gatedOut=${gatedOut}`,
    );
    return null;
  },
});

// ---------------------------------------------------------------------------
// ATOMIC COOLDOWN CHECK — claimSendSlot
// ---------------------------------------------------------------------------

type ClaimResult =
  | {
      claimed: true;
      pushToken: string;
      pushTokenPlatform: 'ios' | 'android';
      projectId: string;
    }
  | { claimed: false; reason: string };

/**
 * Atomic cooldown + backoff check. Sole writer of fcmLastPushAt. Called
 * by sendWake before firing the HTTP POST. Returns the token + project
 * metadata on successful claim so the action can complete without a
 * second round-trip to the database.
 */
export const claimSendSlot = internalMutation({
  args: { sessionId: v.id('driverSessions') },
  returns: v.union(
    v.object({
      claimed: v.literal(true),
      pushToken: v.string(),
      pushTokenPlatform: v.union(v.literal('ios'), v.literal('android')),
      projectId: v.string(),
    }),
    v.object({
      claimed: v.literal(false),
      reason: v.string(),
    }),
  ),
  handler: async (ctx, { sessionId }): Promise<ClaimResult> => {
    const session = await ctx.db.get(sessionId);
    if (!session) return { claimed: false, reason: 'no_session' };
    if (session.status !== 'active') {
      return { claimed: false, reason: 'session_ended' };
    }
    const now = Date.now();
    if (session.fcmBackoffUntil !== undefined && session.fcmBackoffUntil > now) {
      return { claimed: false, reason: 'backoff' };
    }
    if (
      session.fcmLastPushAt !== undefined &&
      session.fcmLastPushAt + COOLDOWN_MS > now
    ) {
      return { claimed: false, reason: 'cooldown' };
    }
    if (!session.pushToken || !session.pushTokenPlatform) {
      return { claimed: false, reason: 'no_token' };
    }

    // Read service account to surface the projectId. Checked here (not
    // just in the action) so a misconfigured env rejects the claim
    // before we burn the cooldown slot on a definitely-failing send.
    let projectId: string;
    try {
      projectId = loadServiceAccount().project_id;
    } catch (err) {
      console.warn(
        `[fcmWake.claimSendSlot] service_account_error sessionId=${sessionId} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { claimed: false, reason: 'service_account_error' };
    }

    await ctx.db.patch(sessionId, { fcmLastPushAt: now });
    return {
      claimed: true,
      pushToken: session.pushToken,
      pushTokenPlatform: session.pushTokenPlatform,
      projectId,
    };
  },
});

// ---------------------------------------------------------------------------
// RESULT RECORDER — recordResult
// ---------------------------------------------------------------------------

/**
 * Patches backoff / failure state after the FCM HTTP call lands. Also
 * clears the token on invalid-token outcomes so the next sweep doesn't
 * waste a cooldown slot on a dead token. Emits fcm_dispatched with the
 * outcome bucket for the § 6.5 PostHog dashboard.
 */
export const recordResult = internalMutation({
  args: {
    sessionId: v.id('driverSessions'),
    outcome: v.union(
      v.literal('success'),
      v.literal('invalid_token'),
      v.literal('transient'),
      v.literal('config_error'),
    ),
    errorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, outcome, errorCode }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;

    const now = Date.now();

    if (outcome === 'success') {
      await ctx.db.patch(sessionId, {
        fcmConsecutiveFailures: 0,
        fcmBackoffUntil: undefined,
      });
      console.warn(
        `[fcmWake.sendWake] fcm_dispatched sessionId=${sessionId} outcome=success`,
      );
      return null;
    }

    if (outcome === 'invalid_token') {
      // Clear the dead token so the next sweep skips this session until
      // the mobile side re-registers (on next tracking-start / foreground
      // diff-check). Reset failure counter — the problem is token
      // identity, not delivery capacity.
      await ctx.db.patch(sessionId, {
        pushToken: undefined,
        pushTokenPlatform: undefined,
        pushTokenUpdatedAt: undefined,
        fcmConsecutiveFailures: 0,
        fcmBackoffUntil: undefined,
      });
      console.warn(
        `[fcmWake.sendWake] fcm_dispatched sessionId=${sessionId} outcome=failure error=${errorCode ?? 'invalid_token'}`,
      );
      console.warn(
        `[pushTokens.clearPushToken] cleared sessionId=${sessionId} reason=${errorCode ?? 'invalid_token'}`,
      );
      return null;
    }

    // transient / config_error → apply exponential backoff so we don't
    // hammer a degraded FCM. config_error (missing env, malformed JSON)
    // is treated as transient here — flipping the fcm_wake_enabled flag
    // off is the correct kill-switch, not a per-session block.
    const nextFailures = (session.fcmConsecutiveFailures ?? 0) + 1;
    const shift = Math.min(nextFailures - 1, BACKOFF_MAX_SHIFT);
    const backoffUntil = now + BACKOFF_BASE_MS * Math.pow(2, shift);
    await ctx.db.patch(sessionId, {
      fcmConsecutiveFailures: nextFailures,
      fcmBackoffUntil: backoffUntil,
    });
    console.warn(
      `[fcmWake.sendWake] fcm_dispatched sessionId=${sessionId} outcome=failure error=${errorCode ?? outcome} failures=${nextFailures} backoffMs=${backoffUntil - now}`,
    );
    return null;
  },
});

// ---------------------------------------------------------------------------
// ACTION — sendWake
// ---------------------------------------------------------------------------

/**
 * Dispatch a wake push for a single stale session. Orchestration:
 *   1. Atomic claim (claimSendSlot mutation) — aborts if cooldown /
 *      backoff / token-missing. Also records fcmLastPushAt on success.
 *   2. Mint a Google OAuth2 access token.
 *   3. POST to FCM HTTP v1 /messages:send with the 4KB-safe data-only
 *      payload { type: 'wake_tracking', sessionId }.
 *   4. Record outcome (recordResult mutation).
 *
 * All writes to fcm* session fields flow through claimSendSlot and
 * recordResult — no branch here writes to the DB directly. Keeps the
 * atomic contract in one place for future reviewers.
 */
export const sendWake = internalAction({
  args: { sessionId: v.id('driverSessions') },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const claim: ClaimResult = await ctx.runMutation(
      internal.fcmWake.claimSendSlot,
      { sessionId },
    );
    if (!claim.claimed) {
      console.warn(
        `[fcmWake.sendWake] claim_declined sessionId=${sessionId} reason=${claim.reason}`,
      );
      return null;
    }

    let outcome: WakeOutcome;
    try {
      const accessToken = await mintFcmAccessToken();
      const url = `https://fcm.googleapis.com/v1/projects/${claim.projectId}/messages:send`;
      const body = {
        message: {
          token: claim.pushToken,
          // 4KB FCM payload ceiling. Keep this to the bare identifier —
          // the mobile handler resolves all other context (session
          // validity, leg state, etc.) via getActiveSession before
          // starting FGS.
          data: {
            type: 'wake_tracking',
            sessionId: sessionId,
          },
          android: {
            // HIGH priority is required for the FGS-start exemption in
            // § 4.1 #3. Normal priority wouldn't let us start the
            // foreground service from the FCM handler.
            priority: 'HIGH' as const,
          },
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        outcome = { kind: 'success' };
      } else {
        let errJson: unknown = null;
        try {
          errJson = await res.json();
        } catch {
          // Non-JSON error body — fall through with a generic code.
        }
        const errorCode = extractFcmErrorCode(errJson);
        outcome = classifyOutcome(errorCode);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[fcmWake.sendWake] config_or_network_error sessionId=${sessionId} err=${msg.slice(0, 200)}`,
      );
      outcome = { kind: 'config_error', message: msg };
    }

    if (outcome.kind === 'success') {
      await ctx.runMutation(internal.fcmWake.recordResult, {
        sessionId,
        outcome: 'success',
      });
    } else if (outcome.kind === 'invalid_token') {
      await ctx.runMutation(internal.fcmWake.recordResult, {
        sessionId,
        outcome: 'invalid_token',
        errorCode: outcome.errorCode,
      });
    } else if (outcome.kind === 'transient') {
      await ctx.runMutation(internal.fcmWake.recordResult, {
        sessionId,
        outcome: 'transient',
        errorCode: outcome.errorCode,
      });
    } else {
      await ctx.runMutation(internal.fcmWake.recordResult, {
        sessionId,
        outcome: 'config_error',
        errorCode: outcome.message.slice(0, 80),
      });
    }
    return null;
  },
});
