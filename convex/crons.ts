import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

/**
 * Every job runs through platform/cronRunner.run, which records a run
 * ledger (cronHealth upserted every tick; cronRuns history per the volume
 * policy) and rethrows failures so Convex logs / Axiom see them unchanged.
 * The `job()` args tell the wrapper what to execute:
 *   fn            — 'module:function' target (the original cron function)
 *   fnType        — how to invoke it (runMutation vs runAction)
 *   recordHistory — false ONLY for sub-5-minute jobs (10s/60s/1m); their
 *                   ok-ticks live in cronHealth alone, failures always
 *                   append history. See docs/platform-admin-console-plan.md §11-6.
 */
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `every` is the DECLARED cadence, and it must match the schedule below it —
 * it's what lets the console say "this job hasn't run since Tuesday" instead
 * of showing a green chip from the last successful tick. For `crons.cron()`
 * entries it's the nominal spacing of the expression (daily = 24h, monthly is
 * declared as 31d so a short month can't trip the stale alarm).
 */
function job(
  jobName: string,
  fn: string,
  fnType: 'mutation' | 'action',
  every: number,
  recordHistory = true,
) {
  return { jobName, fn, fnType, recordHistory, expectedIntervalMs: every };
}

// Run the FourKites Dispatcher every 15 minutes
crons.interval(
  'fourkites-sync-dispatch',
  { minutes: 15 },
  internal.platform.cronRunner.run,
  job('fourkites-sync-dispatch', 'fourKitesScheduledSync:dispatch', 'mutation', 15 * MINUTE),
);

// ✅ Recalculate organization stats daily (drift protection)
// Industry standard: Stripe, Shopify do this to catch any drift from bugs
crons.interval(
  'recalculate-org-stats',
  { hours: 24 },
  internal.platform.cronRunner.run,
  job('recalculate-org-stats', 'stats:recalculateAllOrgs', 'mutation', DAY),
);

// ✅ Recalculate accounting period stats daily (drift protection)
crons.interval(
  'recalculate-accounting-stats',
  { hours: 24 },
  internal.platform.cronRunner.run,
  job('recalculate-accounting-stats', 'accountingStats:recalculateAllOrgsAccounting', 'mutation', DAY),
);

// ✅ Verify carrier authority nightly against FMCSA (Settings → General badges)
crons.cron(
  'verify-carrier-authority',
  '15 5 * * *',
  internal.platform.cronRunner.run,
  job('verify-carrier-authority', 'fmcsaVerification:verifyAllOrgs', 'action', DAY),
);

// ✅ Recalculate platform usage metering daily (undercount correction)
crons.cron(
  'recalculate-platform-usage',
  '30 4 * * *',
  internal.platform.cronRunner.run,
  job('recalculate-platform-usage', 'platformUsage:recalculateAllOrgsPlatformUsage', 'mutation', DAY),
);

// ✅ Reconcile firstStopDate denormalized field daily
crons.interval(
  'reconcile-first-stop-date',
  { hours: 24 },
  internal.platform.cronRunner.run,
  job('reconcile-first-stop-date', 'maintenance:runFirstStopDateReconciliation', 'action', DAY),
);

// ✅ Archive old driver location data daily (S3 cold storage)
crons.cron(
  'archive-old-locations',
  '0 3 * * *',
  internal.platform.cronRunner.run,
  job('archive-old-locations', 'gpsArchive:archiveOldLocations', 'action', DAY),
);

// ✅ Prune stale driverLatestLocation cache rows daily
crons.cron(
  'prune-stale-driver-latest-location',
  '30 3 * * *',
  internal.platform.cronRunner.run,
  job('prune-stale-driver-latest-location', 'driverLocations:pruneStaleDriverLatestLocation', 'action', DAY),
);

// ✅ Archive old audit log entries monthly (S3, self-rescheduling)
crons.cron(
  'archive-old-audit-logs',
  '45 3 1 * *',
  internal.platform.cronRunner.run,
  job('archive-old-audit-logs', 'auditLogArchive:archiveOldAuditLogs', 'action', 31 * DAY),
);

// ==========================================
// AUTO-ASSIGNMENT & RECURRING LOADS
// ==========================================

// ✅ Recurring Load Generation (hourly; per-template generationTime/advanceDays)
crons.interval(
  'recurring-load-generation',
  { hours: 1 },
  internal.platform.cronRunner.run,
  job('recurring-load-generation', 'recurringLoadsCron:generateDailyLoads', 'action', HOUR),
);

// ✅ Scheduled Auto-Assignment (hourly; supplements the on-create trigger)
crons.interval(
  'scheduled-auto-assignment',
  { hours: 1 },
  internal.platform.cronRunner.run,
  job('scheduled-auto-assignment', 'autoAssignmentCron:runScheduledAutoAssignment', 'action', HOUR),
);

// ==========================================
// DRIVER SETTLEMENTS
// ==========================================

// ✅ Driver settlement generation (hourly; additive DRAFT top-ups)
crons.interval(
  'driver-settlement-generation',
  { hours: 1 },
  internal.platform.cronRunner.run,
  job('driver-settlement-generation', 'settlementsCron:tick', 'mutation', HOUR),
);

// ✅ Pay-engine (new-ledger) settlement generation — SHADOW (hourly)
crons.interval(
  'pay-engine-settlement-generation',
  { hours: 1 },
  internal.platform.cronRunner.run,
  job('pay-engine-settlement-generation', 'payEngine/generationCron:tick', 'mutation', HOUR),
);

// ✅ Session pay backstop (daily at 1 AM UTC; paySession is idempotent)
crons.cron(
  'session-pay-backstop',
  '0 1 * * *',
  internal.platform.cronRunner.run,
  job('session-pay-backstop', 'sessionPay:backstopSweep', 'mutation', DAY),
);

// ==========================================
// EXTERNAL TRACKING API
// ==========================================

// ✅ Webhook delivery processing (every 5 minutes; retry/dead-letter)
crons.interval(
  'external-tracking-webhook-delivery',
  { minutes: 5 },
  internal.platform.cronRunner.run,
  job('external-tracking-webhook-delivery', 'externalTrackingWebhooks:processWebhookDeliveries', 'action', 5 * MINUTE),
);

// ✅ Audit log pruning (daily at 2 AM UTC; 30-day retention)
crons.cron(
  'external-tracking-audit-log-prune',
  '0 2 * * *',
  internal.platform.cronRunner.run,
  job('external-tracking-audit-log-prune', 'externalTrackingAuth:pruneAuditLogs', 'mutation', DAY),
);

// ✅ Webhook delivery queue cleanup (daily at 2:30 AM UTC)
crons.cron(
  'external-tracking-webhook-queue-cleanup',
  '30 2 * * *',
  internal.platform.cronRunner.run,
  job('external-tracking-webhook-queue-cleanup', 'externalTrackingAuth:pruneWebhookDeliveryQueue', 'mutation', DAY),
);

// ✅ Sandbox data refresh (daily at 4 AM UTC)
crons.cron(
  'external-tracking-sandbox-refresh',
  '0 4 * * *',
  internal.platform.cronRunner.run,
  job('external-tracking-sandbox-refresh', 'sandboxData:refreshAllSandboxData', 'action', DAY),
);

// ==========================================
// LOAD EXPIRATION
// ==========================================

// ✅ Auto-expire stale loads (hourly; 6h/12h idle windows)
crons.cron(
  'auto-expire-stale-loads',
  '0 * * * *',
  internal.platform.cronRunner.run,
  job('auto-expire-stale-loads', 'loads:autoExpireStaleLoads', 'mutation', HOUR),
);

// ==========================================
// DRIVER SESSION SYSTEM
// ==========================================

// ✅ Auto-timeout stale driver sessions (every 6 hours; 18h threshold)
crons.interval(
  'auto-timeout-driver-sessions',
  { hours: 6 },
  internal.platform.cronRunner.run,
  job('auto-timeout-driver-sessions', 'driverSessions:sweepStaleSessionsForAutoTimeout', 'mutation', 6 * HOUR),
);

// ✅ FCM wake-up sweep (every 1 minute) — Phase 1b; gated on fcm_wake_enabled
crons.interval(
  'fcm-wake-sweep',
  { minutes: 1 },
  internal.platform.cronRunner.run,
  job('fcm-wake-sweep', 'fcmWake:sweep', 'action', MINUTE, false),
);

// ==========================================
// FOURKITES DISPATCHER PUSH
// ==========================================

// ✅ Push GPS updates to FourKites Dispatcher Update API (every 60 seconds)
crons.interval(
  'fourkites-dispatcher-push',
  { seconds: 60 },
  internal.platform.cronRunner.run,
  job('fourkites-dispatcher-push', 'fourKitesDispatcherPush:pushFourKitesUpdates', 'action', 60 * SECOND, false),
);

// ✅ AUDIT-ONLY: prune fourKitesPushAuditLog rows older than 14 days (200/run)
crons.interval(
  'fourkites-audit-log-prune',
  { minutes: 30 },
  internal.platform.cronRunner.run,
  job('fourkites-audit-log-prune', 'fourKitesDispatcherPushMutations:pruneFourKitesPushAuditLog', 'mutation', 30 * MINUTE),
);

// ==========================================
// SAMSARA GPS BACKUP INGEST
// ==========================================

// ✅ Poll Samsara Vehicle Stats GPS feed (every 10 seconds)
crons.interval(
  'samsara-gps-poll',
  { seconds: 10 },
  internal.platform.cronRunner.run,
  job('samsara-gps-poll', 'samsaraIngest:pollAllIntegrations', 'action', 10 * SECOND, false),
);

// ==========================================
// FACET SYSTEM MAINTENANCE
// ==========================================

// ✅ Prune orphaned facetValues (daily at 5 AM UTC)
crons.cron(
  'prune-orphaned-facet-values',
  '0 5 * * *',
  internal.platform.cronRunner.run,
  job('prune-orphaned-facet-values', 'facetMaintenance:pruneOrphanedFacetValues', 'action', DAY),
);

// ✅ Eventually-exact load status counts — change-gated rebuild (every 1 min)
crons.interval(
  'load-status-counts-rebuild-gate',
  { minutes: 1 },
  internal.platform.cronRunner.run,
  job('load-status-counts-rebuild-gate', 'loadStatusCounts:tickRebuildGate', 'mutation', MINUTE, false),
);

// ✅ Load status count cross-check (every 30 min; organizationStats oracle)
crons.interval(
  'load-status-counts-verify',
  { minutes: 30 },
  internal.platform.cronRunner.run,
  job('load-status-counts-verify', 'loadStatusCounts:verifyAllOrgs', 'action', 30 * MINUTE),
);

// ✅ Expire create-form drafts older than 30 days (daily at 4 AM UTC)
crons.cron(
  'expire-create-drafts',
  '0 4 * * *',
  internal.platform.cronRunner.run,
  job('expire-create-drafts', 'createDrafts:expireOld', 'mutation', DAY),
);

// ✅ Dispatch alerts sweep (every 1 minute; dedupe inside raiseAlert)
crons.interval(
  'dispatch-alerts-sweep',
  { minutes: 1 },
  internal.platform.cronRunner.run,
  job('dispatch-alerts-sweep', 'dispatchAlerts:sweep', 'mutation', MINUTE, false),
);

// ==========================================
// PLATFORM CONSOLE
// ==========================================

// ✅ Rebuild org health snapshots (every 15 min; cursor-batched)
// Feeds the console's org directory — the only sanctioned cross-org read.
crons.interval(
  'org-health-snapshots',
  { minutes: 15 },
  internal.platform.cronRunner.run,
  job('org-health-snapshots', 'platform/snapshots:rebuildAllOrgHealthSnapshots', 'mutation', 15 * MINUTE),
);

// ✅ Invoice cycle close (2nd of the month, 03:00 UTC — after the nightly
// usage recalc has settled the closed month). Drafts one invoice per org
// with billable lines; idempotent by (org, period). Staff review drafts on
// the console billing board and issue manually (spec D-B1: manual until
// two clean cycles).
crons.cron(
  'platform-invoice-cycle-close',
  '0 3 2 * *',
  internal.platform.cronRunner.run,
  job('platform-invoice-cycle-close', 'platform/invoices:cycleClose', 'mutation', 31 * DAY),
);

// ✅ Facility geofence radius refinement (daily at 5:20 AM UTC, after the
// facet prune). Re-derives VERIFIED facilities' radii from the p95 spread
// of real check-in/checkout fixes; manual radii never touched; steps
// bounded ±25%/night. See convex/facilityRadius.ts.
crons.cron(
  'facility-radius-refinement',
  '20 5 * * *',
  internal.platform.cronRunner.run,
  job('facility-radius-refinement', 'facilityRadius:refineAllFacilityRadii', 'mutation', DAY),
);

// ✅ Platform alert evaluator (every 5 min): checks the alerting matrix
// (crons failing ≥3×, webhook dead-letters, FourKites all_failed), keeps
// one deduped alert per incident, notifies Slack on open, auto-resolves.
// Also logs the dead-man's-switch heartbeat line for the Axiom absence
// monitor.
crons.interval(
  'platform-alerts-evaluate',
  { minutes: 5 },
  internal.platform.cronRunner.run,
  job('platform-alerts-evaluate', 'platform/alerts:evaluate', 'mutation', 5 * MINUTE),
);

// ✅ Stripe reconciliation (daily at 4:45 AM UTC). Cross-checks pushed
// open invoices against Stripe: applies payments the webhook missed
// (idempotent) and flags void/uncollectible mismatches as systemEvents.
// No-op while STRIPE_SECRET_KEY is unset.
crons.cron(
  'platform-stripe-reconcile',
  '45 4 * * *',
  internal.platform.cronRunner.run,
  job('platform-stripe-reconcile', 'platform/stripe:reconcileStripeInvoices', 'action', DAY),
);

// ✅ Prune platform ledgers (daily at 6:15 AM UTC; 30-day retention for
// cronRuns and systemEvents, bounded batches)
crons.cron(
  'platform-ledger-prune',
  '15 6 * * *',
  internal.platform.cronRunner.run,
  job('platform-ledger-prune', 'platform/cronRunner:pruneLedger', 'mutation', DAY),
);

// ✅ Sweep orphaned entity-document uploads (pending rows older than 1h
// whose finalize never came — closed tab between presign and finalize).
// docs/documents-storage-spec.md §1 "Upload flow (web)" step 4.
crons.interval(
  'sweep-pending-documents',
  { hours: 1 },
  internal.platform.cronRunner.run,
  job('sweep-pending-documents', 'entityDocuments:sweepPending', 'mutation', HOUR),
);

export default crons;
