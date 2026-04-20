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
// Moves location data older than 90 days to cold storage (R2)
// Keeps hot storage costs low while maintaining historical data
crons.cron(
  'archive-old-locations',
  '0 3 * * *', // Run daily at 3 AM UTC
  internal.driverLocations.archiveOldLocations,
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

// ✅ Auto-expire stale loads (daily at 1 AM UTC)
// Phase 1: Marks Open/Assigned loads as Expired when the pickup date has passed
//          and no tracking data was received (trackingStatus still 'Pending')
// Phase 2: Marks In Transit loads as Expired when no activity for 3+ days
crons.cron('auto-expire-stale-loads', '0 1 * * *', internal.loads.autoExpireStaleLoads, {});

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

export default crons;
