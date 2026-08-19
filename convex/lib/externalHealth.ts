import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import type { ActionCtx } from '../_generated/server';

/**
 * All the helper needs is the ability to run a mutation. Asking for the whole
 * ActionCtx would shut out call sites that were handed a narrowed context,
 * and those are exactly the deep helper functions worth instrumenting.
 */
type Recorder = Pick<ActionCtx, 'runMutation'>;
import { internal } from '../_generated/api';

/**
 * Health for the third-party services the platform calls out to.
 *
 * The console could already see the integrations a CUSTOMER configures
 * (orgIntegrations: FourKites, Samsara) but nothing about the services WE
 * depend on — Maps, Stripe, Clerk, an LLM, object storage. Those failing is
 * just as much a platform outage, and until now the only evidence was a stack
 * trace in the Convex logs.
 *
 * Usage is a one-token change at a call site:
 *
 *   const res = await fetch(url, init);
 *   const res = await trackedFetch(ctx, 'google_maps', url, init);
 *
 * `trackedFetch` never changes what the caller sees: it returns the same
 * Response and rethrows the same error. A dependency-health board that can
 * break the thing it watches is not worth having.
 */

/**
 * The declared inventory.
 *
 * `env` names the variable that configures a service, and `envOptional` marks
 * the ones that work without it — Socrata answers unauthenticated and the
 * token merely lifts its rate limit. Getting that wrong reports a working
 * dependency as broken, so the flag follows what the call site actually does
 * with the value, not whether a variable exists for it.
 *
 * Every outbound dependency is listed here whether or not it has ever been
 * called, because "we depend on this and have never seen it work" is exactly
 * the finding a health board exists to surface. A service missing from this
 * list is invisible; a service listed but never called says so.
 */
export const EXTERNAL_SERVICES = [
  {
    key: 'stripe',
    label: 'Stripe',
    purpose: 'Invoice push and payment reconciliation',
    env: 'STRIPE_SECRET_KEY',
  },
  {
    key: 'slack',
    label: 'Slack alerting',
    purpose: 'Delivering platform alerts to a human',
    env: 'SLACK_ALERT_WEBHOOK_URL',
  },
  {
    key: 'clerk',
    label: 'Clerk',
    purpose: 'Driver identity — mobile sign-in accounts',
    env: 'CLERK_SECRET_KEY',
  },
  {
    key: 'google_maps',
    label: 'Google Maps',
    purpose: 'Distance, geocoding and facility radius',
    env: 'GOOGLE_MAPS_API_KEY',
  },
  {
    key: 'google_roads',
    label: 'Google Roads',
    purpose: 'Snapping GPS traces to roads',
    env: 'GOOGLE_MAPS_API_KEY',
  },
  {
    key: 'mapbox',
    label: 'Mapbox',
    purpose: 'Map tiles and the road-snapping fallback',
    env: 'MAPBOX_ACCESS_TOKEN',
  },
  {
    key: 'fcm',
    label: 'Firebase Cloud Messaging',
    purpose: 'Waking the driver app — silent push',
    env: 'FCM_SERVICE_ACCOUNT_JSON',
  },
  {
    key: 'expo_push',
    label: 'Expo push',
    purpose: 'Driver app notifications',
    env: null, // no key: Expo push is unauthenticated for our use
  },
  {
    key: 'llm',
    label: 'LLM (OpenAI / Anthropic)',
    purpose: 'Schedule import, fuel receipts, voice parsing',
    env: 'OPENAI_API_KEY',
  },
  {
    key: 'deepgram',
    label: 'Deepgram',
    purpose: 'Speech-to-text for voice dispatch',
    env: 'DEEPGRAM_API_KEY',
  },
  {
    key: 'tollguru',
    label: 'TollGuru',
    purpose: 'Toll costs in the lane analyzer',
    env: 'TOLLGURU_API_KEY',
  },
  {
    key: 'eia',
    label: 'EIA',
    purpose: 'Diesel price index for fuel surcharge',
    env: 'EIA_API_KEY',
  },
  {
    key: 'fmcsa',
    label: 'FMCSA',
    purpose: 'Carrier authority and safety verification',
    env: 'FMCSA_WEBKEY',
  },
  {
    key: 'socrata',
    label: 'Socrata',
    purpose: 'FMCSA open-data lookups',
    // OPTIONAL. The open-data API answers unauthenticated; the token only
    // lifts the rate limit, so an absent one is not a broken dependency.
    env: 'SOCRATA_APP_TOKEN',
    envOptional: true,
  },
  {
    key: 'nhtsa',
    label: 'NHTSA vPIC',
    purpose: 'VIN decoding for the fleet',
    env: null, // public API, no key
  },
  {
    key: 'solver',
    label: 'Lane solver',
    purpose: 'Lane optimisation service',
    env: 'SOLVER_API_URL',
  },
  {
    key: 's3',
    label: 'Object storage (S3 / R2)',
    purpose: 'GPS and audit-log archives, uploads',
    env: 'S3_BUCKET',
  },
] as const;

export type ExternalService = (typeof EXTERNAL_SERVICES)[number]['key'];

/**
 * Successful calls write at most this often per service. Failures always
 * write — they are rare and they are the point.
 */
const OK_WRITE_THROTTLE_MS = 60_000;
const MAX_ERROR_LEN = 300;

export const recordExternalCall = internalMutation({
  args: {
    service: v.string(),
    ok: v.boolean(),
    durationMs: v.number(),
    statusCode: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query('externalServiceHealth')
      .withIndex('by_service', (q) => q.eq('service', args.service))
      .unique();

    if (args.ok) {
      // Throttle: one success write a minute is enough to answer "is it
      // working", and a hot dependency must not turn telemetry into
      // write contention on a single row.
      if (existing && existing.consecutiveFailures === 0) {
        if (now - (existing.lastOkAt ?? 0) < OK_WRITE_THROTTLE_MS) return null;
      }
      const patch = {
        lastOkAt: now,
        lastDurationMs: args.durationMs,
        lastStatusCode: args.statusCode,
        consecutiveFailures: 0,
        updatedAt: now,
      };
      if (existing) await ctx.db.patch(existing._id, patch);
      else await ctx.db.insert('externalServiceHealth', { service: args.service, ...patch });
      return null;
    }

    const patch = {
      lastErrorAt: now,
      lastErrorMessage: args.errorMessage?.slice(0, MAX_ERROR_LEN),
      lastStatusCode: args.statusCode,
      lastDurationMs: args.durationMs,
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert('externalServiceHealth', { service: args.service, ...patch });
    return null;
  },
});

/**
 * `fetch`, with the outcome recorded against a service.
 *
 * Transparent by construction: same Response out, same error rethrown, and the
 * recording itself is swallowed. A 5xx counts as a failure — a dependency that
 * answers with an error is not working, however well the socket behaved.
 */
export async function trackedFetch(
  ctx: Recorder,
  service: ExternalService,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const startedAt = Date.now();
  try {
    const response = await fetch(input, init);
    await report(ctx, service, {
      ok: response.ok,
      durationMs: Date.now() - startedAt,
      statusCode: response.status,
      errorMessage: response.ok ? undefined : `HTTP ${response.status} ${response.statusText}`,
    });
    return response;
  } catch (error) {
    // A thrown fetch is DNS, TLS or a timeout — the hardest failure there is.
    await report(ctx, service, {
      ok: false,
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * For a dependency reached through a vendor SDK rather than `fetch` — object
 * storage, mainly. Same contract: the result passes through untouched.
 */
export async function trackExternal<T>(
  ctx: Recorder,
  service: ExternalService,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    await report(ctx, service, { ok: true, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    await report(ctx, service, {
      ok: false,
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function report(
  ctx: Recorder,
  service: string,
  args: { ok: boolean; durationMs: number; statusCode?: number; errorMessage?: string },
) {
  try {
    await ctx.runMutation(internal.lib.externalHealth.recordExternalCall, { service, ...args });
  } catch {
    // Recording health must never be the reason a call fails. If the mutation
    // is unavailable the board goes stale, which is a far smaller problem
    // than a dispatch action throwing because telemetry could not be written.
  }
}
