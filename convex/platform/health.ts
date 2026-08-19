import { query } from '../_generated/server';
import { requirePlatformStaff } from '../lib/auth';
import { EXTERNAL_SERVICES } from '../lib/externalHealth';

/**
 * Platform console — integration health board. Staff-only.
 *
 * Driven by `orgIntegrations` rather than by a panel per vendor. That table is
 * the registry: one row per org × provider, carrying the enabled flag, the
 * declared pull cadence and `lastSyncStats`, and BOTH FourKites and Samsara
 * already write to it. Building on it means a new provider (project44 is named
 * in the schema's own comment) shows up here the day it is configured, instead
 * of waiting for someone to remember to add a panel.
 *
 * Provider-specific detail is joined on top where a richer record exists:
 * `samsaraSyncState` for the 10s GPS poll, `fourKitesPushTickHealth` for the
 * 60s Dispatcher Update push. Those tables hold the per-tick funnel counters
 * that `lastSyncStats` cannot express.
 *
 * NOT scoped to client orgs, deliberately — unlike the directory and the
 * Overview KPIs. Those answer "who are our customers"; this answers "is our
 * machinery working". If we run a Samsara poll on someone's behalf and it is
 * failing, staff have to be able to see it and fix it, whoever the org is.
 * Rows carry only the opaque WorkOS org id, never a name.
 */

const QUEUE_COUNT_CAP = 500;

/**
 * Expected cadence when the integration does not declare one.
 *
 * A pull integration states its own `syncSettings.pull.intervalMinutes` and
 * that wins. Push integrations have no configured interval — they ride a cron
 * — so their tick rate is recorded here, from convex/crons.ts.
 */
const DEFAULT_CADENCE_MS: Record<string, number> = {
  samsara: 10_000, // samsara-gps-poll
  fourkites: 60_000, // fourkites-dispatcher-push
};
const FALLBACK_CADENCE_MS = 15 * 60_000;

/**
 * Same staleness policy as the jobs board (platform/jobHealth.ts): late by
 * three expected cycles, with a five-minute floor so a 10s integration does
 * not flap into "stale" over a single slow tick.
 */
const MISSED_CYCLES = 3;
const MIN_STALE_AFTER_MS = 5 * 60_000;

type IntegrationState = 'ok' | 'failing' | 'stale' | 'never_run' | 'disabled';

export const integrationHealth = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    const now = Date.now();

    // Bounded by org × provider — the registry, not a hot table.
    const integrations = await ctx.db.query('orgIntegrations').collect();
    const samsaraStates = await ctx.db.query('samsaraSyncState').collect();
    const pushTicks = await ctx.db.query('fourKitesPushTickHealth').collect();

    const samsaraByIntegration = new Map(samsaraStates.map((s) => [s.integrationId, s]));
    const pushByOrg = new Map(pushTicks.map((t) => [t.workosOrgId, t]));

    const rows = integrations.map((integration) => {
      const samsara = samsaraByIntegration.get(integration._id);
      const push = integration.provider === 'fourkites'
        ? pushByOrg.get(integration.workosOrgId)
        : undefined;

      // Whichever signal this provider actually writes. A provider that only
      // pushes never sets lastSyncTime, and one that only pulls never sets a
      // tick — so take the newest of the three rather than trusting one.
      const lastActivityAt = Math.max(
        integration.lastSyncStats.lastSyncTime ?? 0,
        samsara?.lastPolledAt ?? 0,
        push?.lastTickAt ?? 0,
      ) || null;

      const lastErrorAt =
        Math.max(
          samsara?.lastErrorAt ?? 0,
          push?.lastErrorAt ?? 0,
          // lastSyncStats carries a message but NO timestamp of its own, so a
          // failed sync's error is dated by the sync that produced it.
          integration.lastSyncStats.lastSyncStatus === 'failed'
            ? (integration.lastSyncStats.lastSyncTime ?? 0)
            : 0,
        ) || null;
      const lastError =
        integration.lastSyncStats.errorMessage ??
        samsara?.lastErrorMessage ??
        (push?.lastErrorKind
          ? `${push.lastErrorKind}${push.lastErrorStatus ? ` (${push.lastErrorStatus})` : ''}`
          : undefined) ??
        null;

      const cadenceMs =
        (integration.syncSettings.pull?.loadsEnabled
          ? integration.syncSettings.pull.intervalMinutes * 60_000
          : undefined) ??
        DEFAULT_CADENCE_MS[integration.provider] ??
        FALLBACK_CADENCE_MS;
      const staleAfterMs = Math.max(cadenceMs * MISSED_CYCLES, MIN_STALE_AFTER_MS);

      // An integration whose LAST word was an error is failing, even if it has
      // ticked since — a tick that logs no success is not a recovery.
      const failing =
        integration.lastSyncStats.lastSyncStatus === 'failed' ||
        push?.lastTickKind === 'all_failed' ||
        (lastErrorAt !== null && lastActivityAt !== null && lastErrorAt >= lastActivityAt);

      const state: IntegrationState = !integration.syncSettings.isEnabled
        ? 'disabled'
        : lastActivityAt === null
          ? 'never_run'
          : failing
            ? 'failing'
            : now - lastActivityAt > staleAfterMs
              ? 'stale'
              : 'ok';

      /**
       * What this integration actually does, in its own terms.
       *
       * `pull`/`push` come from the org's sync settings, but Samsara's GPS
       * ingest declares neither — it is a cron-driven poll — and rendering an
       * em dash for it said "we don't know" about something we know exactly.
       */
      const direction =
        [integration.syncSettings.pull?.loadsEnabled ? 'pull' : null,
         (integration.syncSettings.push?.gpsTrackingEnabled ||
          integration.syncSettings.push?.driverAssignmentsEnabled) ? 'push' : null]
          .filter(Boolean)
          .join(' + ') || (samsara ? 'poll' : null);

      return {
        _id: integration._id,
        workosOrgId: integration.workosOrgId,
        provider: integration.provider,
        state,
        direction,
        /**
         * Whether the recorded error IS the current state.
         *
         * Samsara clears neither lastErrorMessage nor lastErrorAt on a
         * successful poll, so the last error outlives the outage it describes.
         * Shown as a live failure it claims an outage that has passed; dropped
         * entirely it hides the intermittent faults that are hardest to catch.
         * So it is kept, and labelled with its age.
         */
        lastErrorIsCurrent: state === 'failing',
        enabled: integration.syncSettings.isEnabled,
        pullEnabled: integration.syncSettings.pull?.loadsEnabled ?? false,
        pushEnabled:
          (integration.syncSettings.push?.gpsTrackingEnabled ?? false) ||
          (integration.syncSettings.push?.driverAssignmentsEnabled ?? false),
        cadenceMs,
        lastActivityAt,
        lastSyncStatus: integration.lastSyncStats.lastSyncStatus ?? null,
        // Samsara counts GPS pings rather than "records", and reports them
        // where its own tick state lives.
        recordsProcessed:
          integration.lastSyncStats.recordsProcessed ?? samsara?.lastTickPingsIngested ?? null,
        lastError,
        lastErrorAt,
        // Provider detail, present only where the richer record exists.
        pushTickKind: push?.lastTickKind ?? null,
        consecutiveTransientTicks: push?.consecutiveTransientTicks ?? null,
        samsaraPingsLastTick: samsara?.lastTickPingsIngested ?? null,
      };
    });

    // Worst first: an operator opens this page because something is wrong.
    const ORDER: Record<IntegrationState, number> = {
      failing: 0,
      stale: 1,
      never_run: 2,
      ok: 3,
      disabled: 4,
    };
    rows.sort(
      (a, b) =>
        ORDER[a.state] - ORDER[b.state] ||
        a.provider.localeCompare(b.provider) ||
        a.workosOrgId.localeCompare(b.workosOrgId),
    );

    const countByStatus = async (status: 'PENDING' | 'DEAD_LETTER') =>
      (
        await ctx.db
          .query('webhookDeliveryQueue')
          .withIndex('by_status_next', (q) => q.eq('status', status))
          .take(QUEUE_COUNT_CAP)
      ).length;

    const byState = (s: IntegrationState) => rows.filter((r) => r.state === s).length;

    return {
      integrations: rows,
      summary: {
        total: rows.length,
        providers: [...new Set(rows.map((r) => r.provider))].sort(),
        failing: byState('failing'),
        stale: byState('stale'),
        neverRun: byState('never_run'),
        ok: byState('ok'),
        disabled: byState('disabled'),
      },
      webhookQueue: {
        pending: await countByStatus('PENDING'),
        deadLetter: await countByStatus('DEAD_LETTER'),
        countCap: QUEUE_COUNT_CAP, // UI shows "500+" at the cap
      },
    };
  },
});


/**
 * The services WE call out to — Maps, Stripe, Clerk, an LLM, object storage.
 *
 * Separate from `integrationHealth` because it answers a different question:
 * that one is "is the customer's integration working", this is "are our own
 * dependencies up". Both are platform health; only one of them is anybody's
 * account.
 *
 * Every declared service is returned whether or not it has ever been called.
 * "We depend on this and have never seen it work" is a finding, and a board
 * that lists only what has reported cannot express it.
 *
 * There is deliberately no `stale` state here. These are called on demand, not
 * on a schedule — a VIN decoder nobody has used this week is not broken, and
 * inventing a cadence for it would manufacture alerts out of quiet.
 */
export const externalServiceHealth = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);

    const recorded = await ctx.db.query('externalServiceHealth').collect();
    const byService = new Map(recorded.map((r) => [r.service, r]));

    const rows = EXTERNAL_SERVICES.map((declared) => {
      const health = byService.get(declared.key);
      // Reports only WHETHER a secret is set, never any part of its value.
      const envSet = declared.env === null ? true : Boolean(process.env[declared.env]);
      // An optional key changes how well a service runs, not whether it runs.
      // Read defensively: `as const` on the registry narrows each entry, so
      // the flag exists only on the ones that declare it — and keeping that
      // narrowing is what gives trackedFetch a literal union of service names
      // instead of bare `string`.
      const envOptional = 'envOptional' in declared && declared.envOptional === true;
      const configured = envSet || envOptional;

      /**
       * What we OBSERVED beats what we inferred, in both directions.
       *
       * A recorded failure outranks a missing key: if it failed we called it,
       * and pointing an operator at an env var while the service sits on a
       * live 401 sends them to the wrong place. A recorded success outranks it
       * just as hard — Socrata shipped reading "not configured" beside "last
       * ok: just now", because the registry called an optional token
       * mandatory. Whatever the declaration says, a call that worked is proof
       * the thing works.
       */
      const state =
        health && health.consecutiveFailures > 0
          ? 'failing'
          : health?.lastOkAt != null
            ? 'ok'
            : !configured
              ? 'not_configured'
              : 'never_called';

      return {
        key: declared.key,
        label: declared.label,
        purpose: declared.purpose,
        // The variable NAME is useful for fixing it; the value never leaves.
        env: declared.env,
        envOptional,
        envSet,
        configured,
        state,
        lastOkAt: health?.lastOkAt ?? null,
        lastErrorAt: health?.lastErrorAt ?? null,
        lastError: health?.lastErrorMessage ?? null,
        lastStatusCode: health?.lastStatusCode ?? null,
        lastDurationMs: health?.lastDurationMs ?? null,
        consecutiveFailures: health?.consecutiveFailures ?? 0,
      };
    });

    const ORDER: Record<string, number> = {
      failing: 0,
      not_configured: 1,
      never_called: 2,
      ok: 3,
    };
    rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.label.localeCompare(b.label));

    return {
      services: rows,
      summary: {
        total: rows.length,
        failing: rows.filter((r) => r.state === 'failing').length,
        notConfigured: rows.filter((r) => r.state === 'not_configured').length,
        neverCalled: rows.filter((r) => r.state === 'never_called').length,
        ok: rows.filter((r) => r.state === 'ok').length,
      },
    };
  },
});
