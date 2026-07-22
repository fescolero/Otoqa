import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Run the FourKites Dispatcher every 15 minutes
crons.interval('fourkites-sync-dispatch', { minutes: 15 }, internal.fourKitesScheduledSync.dispatch, {});

// ✅ Recalculate organization stats daily (drift protection)
// Industry standard: Stripe, Shopify do this to catch any drift from bugs
crons.interval(
  'recalculate-org-stats',
  { hours: 24 }, // Run once per day
  internal.stats.recalculateAllOrgs,
  {},
);

// ✅ Recalculate accounting period stats daily (drift protection)
// Revenue-side metrics (totalInvoiced, totalCollected) recalculated from source invoices
crons.interval(
  'recalculate-accounting-stats',
  { hours: 24 },
  internal.accountingStats.recalculateAllOrgsAccounting,
  {},
);

// ✅ Verify carrier authority nightly against FMCSA (Settings → General
// badges). Off-peak, staggered per org inside the action.
crons.cron(
  'verify-carrier-authority',
  '15 5 * * *',
  internal.fmcsaVerification.verifyAllOrgs,
  {},
);

// ✅ Recalculate platform usage metering daily (undercount correction)
// Loads-written-per-cycle counts raised from source loads; the first run
// doubles as the historical backfill. Powers Settings → Billing & usage.
// Fixed off-peak time (like the other heavy scans below) so its full
// loadInformation pass doesn't stack on the interval-based recalc burst.
crons.cron(
  'recalculate-platform-usage',
  '30 4 * * *',
  internal.platformUsage.recalculateAllOrgsPlatformUsage,
  {},
);

// ✅ Reconcile firstStopDate denormalized field daily
// Ensures the cached firstStopDate on loads matches the actual first stop data
// Self-healing mechanism for any edge cases or bugs that cause drift
crons.interval(
  'reconcile-first-stop-date',
  { hours: 24 }, // Run once per day (staggered from org stats)
  internal.maintenance.runFirstStopDateReconciliation,
  {},
);

// ✅ Archive old driver location data daily
// Moves location data older than 30 days to S3 cold storage as gzipped
// JSONL, groups by (orgId, date, hour). See convex/gpsArchive.ts for
// the orchestrator and convex/driverLocations.ts for the DB helpers.
crons.cron(
  'archive-old-locations',
  '0 3 * * *', // Run daily at 3 AM UTC
  internal.gpsArchive.archiveOldLocations,
  {},
);

// ✅ Prune stale driverLatestLocation cache rows daily
// Removes denormalized cache rows for drivers who haven't pinged in 30+
// days. ingestBatch will re-insert on the next ping if a stale driver
// returns. Keeps the cache table bounded against driver churn.
crons.cron(
  'prune-stale-driver-latest-location',
  '30 3 * * *', // Daily at 3:30 AM UTC (after archive-old-locations)
  internal.driverLocations.pruneStaleDriverLatestLocation,
  {},
);

// ✅ Archive old audit log entries monthly
// Moves auditLog rows older than 12 months to S3 cold storage as JSONL,
// grouped by calendar month, then deletes them. Self-reschedules within a
// run if the backlog exceeds the per-tick batch cap.
// See convex/auditLogArchive.ts for the orchestrator and DB helpers.
crons.cron(
  'archive-old-audit-logs',
  '45 3 1 * *', // Monthly on the 1st at 3:45 AM UTC (staggered after the daily location jobs)
  internal.auditLogArchive.archiveOldAuditLogs,
  {},
);

// ==========================================
// AUTO-ASSIGNMENT & RECURRING LOADS
// ==========================================

// ✅ Recurring Load Generation
// Runs hourly to honor per-template generationTime and advanceDays
crons.interval('recurring-load-generation', { hours: 1 }, internal.recurringLoadsCron.generateDailyLoads, {});

// ✅ Scheduled Auto-Assignment (hourly)
// Runs every hour to pick up any loads that need auto-assignment
// Supplements the on-create trigger for any missed loads
crons.interval('scheduled-auto-assignment', { hours: 1 }, internal.autoAssignmentCron.runScheduledAutoAssignment, {});

// ==========================================
// DRIVER SETTLEMENTS
// ==========================================

// ✅ Driver settlement generation (hourly)
// Pay plans define the cadence; this keeps the current period's DRAFT
// statements existing and accruing as work lands (create-if-missing +
// additive top-up via generateOrRefreshForDriver). Never touches manual
// adjustments or statements past DRAFT. See convex/settlementsCron.ts.
crons.interval('driver-settlement-generation', { hours: 1 }, internal.settlementsCron.tick, {});

// ✅ Pay-engine (new-ledger) settlement generation — SHADOW (hourly)
// Mirrors the legacy periods into the new settlements/payItems ledger so the
// read adapter stays current behind the `settlements_read_ledger` flag.
// Additive/shadow-only — writes new-ledger settlements, never touches legacy or
// the dashboard until the flag is flipped. See convex/payEngine/generationCron.ts.
crons.interval('pay-engine-settlement-generation', { hours: 1 }, internal.payEngine.generationCron.tick, {});

// ✅ Session pay backstop (daily at 1 AM UTC)
// Catches completed shifts from the last 7 days whose SESSION_DURATION
// payable was never created (missed hook / transient failure). paySession
// is idempotent, so broad re-scheduling is safe. See convex/sessionPay.ts.
crons.cron('session-pay-backstop', '0 1 * * *', internal.sessionPay.backstopSweep, {});

// ==========================================
// EXTERNAL TRACKING API
// ==========================================

// ✅ Webhook delivery processing (every 5 minutes)
// Finds active webhook subscriptions, enqueues deliveries for tracked loads,
// and processes the delivery queue with retry/dead-letter logic
crons.interval(
  'external-tracking-webhook-delivery',
  { minutes: 5 },
  internal.externalTrackingWebhooks.processWebhookDeliveries,
  {},
);

// ✅ Audit log pruning (daily at 2 AM UTC)
// Removes audit log entries older than 30 days
crons.cron('external-tracking-audit-log-prune', '0 2 * * *', internal.externalTrackingAuth.pruneAuditLogs, {});

// ✅ Webhook delivery queue cleanup (daily at 2:30 AM UTC)
// Removes DELIVERED items > 7 days, DEAD_LETTER items > 30 days
crons.cron(
  'external-tracking-webhook-queue-cleanup',
  '30 2 * * *',
  internal.externalTrackingAuth.pruneWebhookDeliveryQueue,
  {},
);

// ✅ Sandbox data refresh (daily at 4 AM UTC)
// Regenerates synthetic GPS/load data for all orgs with sandbox API keys
crons.cron('external-tracking-sandbox-refresh', '0 4 * * *', internal.sandboxData.refreshAllSandboxData, {});

// ==========================================
// LOAD EXPIRATION
// ==========================================

// ✅ Auto-expire stale loads (hourly)
// Phase 1: Marks Open/Assigned loads as Expired when the pickup date has arrived
//          (firstStopDate <= today) AND the load has been idle for 6+ hours with
//          trackingStatus still 'Pending'.
// Phase 2: Marks In Transit loads as Expired after 12+ hours of no activity.
// Hourly cadence keeps the 6h/12h windows honored within ~1h instead of the
// previous up-to-24h lag from a once-daily run.
crons.cron('auto-expire-stale-loads', '0 * * * *', internal.loads.autoExpireStaleLoads, {});

// ==========================================
// DRIVER SESSION SYSTEM
// ==========================================

// ✅ Auto-timeout stale driver sessions (every 6 hours)
// Safety net for drivers who forgot End Shift, lost their phone, or whose
// app crashed. Sessions older than 18 hours are ended with reason 'auto_timeout'.
// Soft-cap banners (10h amber, 14h red) appear in the mobile UI before this
// fires, so reaching the threshold is genuinely abnormal.
crons.interval(
  'auto-timeout-driver-sessions',
  { hours: 6 },
  internal.driverSessions.sweepStaleSessionsForAutoTimeout,
  {},
);

// ✅ FCM wake-up sweep (every 1 minute) — Phase 1b
// Scans active driverSessions whose lastPingAt is older than 2 minutes
// and fans out sendWake actions to revive killed FGS. Gated per-org on
// the fcm_wake_enabled feature flag (default off). Cooldown + backoff
// are enforced atomically inside sendWake, not here — concurrent sweeps
// are expected to be rare but the atomic check makes them safe.
// See convex/fcmWake.ts and mobile/docs/gps-tracking-architecture.md § Phase 1.
crons.interval(
  'fcm-wake-sweep',
  { minutes: 1 },
  internal.fcmWake.sweep,
  {},
);

// ==========================================
// FOURKITES DISPATCHER PUSH
// ==========================================

// ✅ Push GPS updates to FourKites Dispatcher Update API (every 60 seconds)
// One outbound POST per org per tick (batched, up to 100 loads per request).
// FourKites's rate limit is 60 req/min per key — at most a couple req/min
// per org under realistic load. Mirror of the cron model used by Samsara
// ingest, but outbound. See convex/fourKitesDispatcherPush.ts.
crons.interval(
  'fourkites-dispatcher-push',
  { seconds: 60 },
  internal.fourKitesDispatcherPush.pushFourKitesUpdates,
  {},
);

// ✅ AUDIT-ONLY: prune fourKitesPushAuditLog rows older than 14 days.
// Tied to the AUDIT-ONLY feature for FK integration verification. Remove
// this cron when the audit log table is removed.
// Runs every 30 min and deletes a bounded batch (200 rows/run) so a
// single tick can't time out even if a large backlog accumulates.
crons.interval(
  'fourkites-audit-log-prune',
  { minutes: 30 },
  internal.fourKitesDispatcherPushMutations.pruneFourKitesPushAuditLog,
  {},
);

// ==========================================
// SAMSARA GPS BACKUP INGEST
// ==========================================

// ✅ Poll Samsara Vehicle Stats GPS feed (every 10 seconds)
// Backup GPS source for trucks whose mobile app has gone silent mid-shift.
// Cursor-paginated per integration; sequential per tick. Samsara's
// endpoint rate limit is 50 req/sec per org — at 10s × <100 integrations
// we use ~0.1 req/sec per org, two orders of magnitude of headroom.
// See convex/samsaraIngest.ts for the orchestration.
crons.interval(
  'samsara-gps-poll',
  { seconds: 10 },
  internal.samsaraIngest.pollAllIntegrations,
  {},
);

// ==========================================
// FACET SYSTEM MAINTENANCE
// ==========================================

// ✅ Prune orphaned facetValues (daily at 5 AM UTC)
// facetValues is a presence-only cache with no refcount — load deletions
// and tag value changes leave orphan rows behind. This cron reconciles
// the drift so the filter dropdown only shows values that still have
// at least one matching loadTag.
crons.cron(
  'prune-orphaned-facet-values',
  '0 5 * * *',
  internal.facetMaintenance.pruneOrphanedFacetValues,
  {},
);

// ✅ Eventually-exact load status counts — change-gated rebuild (every 1 min)
// Powers the Dispatch Planner badges (loads.countLoadsByStatusFiltered) without
// the per-query facet/date scan that hit the 4096 read limit. The tick is cheap:
// it only schedules a rebuild for orgs whose loads actually changed since the
// last build (organizationStats.updatedAt moved), plus a ≤30-min safety-net.
// Idle orgs cost ~2 reads/min. See convex/loadStatusCounts.ts + the design doc.
crons.interval(
  'load-status-counts-rebuild-gate',
  { minutes: 1 },
  internal.loadStatusCounts.tickRebuildGate,
  {},
);

// ✅ Load status count cross-check (every 30 min)
// Asserts the cache's all-time totals equal organizationStats (an independent
// oracle). A full rebuild can't drift, so a mismatch flags a bug in either
// mechanism. Doubles as the dark-launch confidence gate before flipping the
// per-org loadStatusCounts.readFromCache flag.
crons.interval(
  'load-status-counts-verify',
  { minutes: 30 },
  internal.loadStatusCounts.verifyAllOrgs,
  {},
);

// ✅ Expire create-form drafts older than 30 days (daily at 4 AM UTC)
// Backs Phase 4 of the create-form rollout. Drafts that haven't been
// touched in 30 days are presumed abandoned. Batched 500 per run; a
// single nightly run easily handles the working set for a normal-size
// org. See convex/createDrafts.ts for the implementation + the
// docs/schema-evolution.md playbook for when this matters.
crons.cron(
  'expire-create-drafts',
  '0 4 * * *',
  internal.createDrafts.expireOld,
  {},
);

export default crons;
