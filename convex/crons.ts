import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Run the FourKites Dispatcher every 15 minutes
crons.interval(
  "fourkites-sync-dispatch",
  { minutes: 15 }, 
  internal.fourKitesScheduledSync.dispatch,
  {}
);

// ✅ Recalculate organization stats daily (drift protection)
// Industry standard: Stripe, Shopify do this to catch any drift from bugs
crons.interval(
  "recalculate-org-stats",
  { hours: 24 }, // Run once per day
  internal.stats.recalculateAllOrgs,
  {}
);

// ✅ Reconcile firstStopDate denormalized field daily
// Ensures the cached firstStopDate on loads matches the actual first stop data
// Self-healing mechanism for any edge cases or bugs that cause drift
crons.interval(
  "reconcile-first-stop-date",
  { hours: 24 }, // Run once per day (staggered from org stats)
  internal.maintenance.runFirstStopDateReconciliation,
  {}
);

// ✅ Archive old driver location data daily
// Moves location data older than 90 days to cold storage (R2)
// Keeps hot storage costs low while maintaining historical data
crons.cron(
  "archive-old-locations",
  "0 3 * * *", // Run daily at 3 AM UTC
  internal.driverLocations.archiveOldLocations,
  {}
);

// ==========================================
// AUTO-ASSIGNMENT & RECURRING LOADS
// ==========================================

// ✅ Recurring Load Generation
// Runs hourly to honor per-template generationTime and advanceDays
crons.interval(
  "recurring-load-generation",
  { hours: 1 },
  internal.recurringLoadsCron.generateDailyLoads,
  {}
);

// ✅ Scheduled Auto-Assignment (hourly)
// Runs every hour to pick up any loads that need auto-assignment
// Supplements the on-create trigger for any missed loads
crons.interval(
  "scheduled-auto-assignment",
  { hours: 1 },
  internal.autoAssignmentCron.runScheduledAutoAssignment,
  {}
);

// ==========================================
// EXTERNAL TRACKING API
// ==========================================

// ✅ Webhook delivery processing (every 5 minutes)
// Finds active webhook subscriptions, enqueues deliveries for tracked loads,
// and processes the delivery queue with retry/dead-letter logic
crons.interval(
  "external-tracking-webhook-delivery",
  { minutes: 5 },
  internal.externalTrackingWebhooks.processWebhookDeliveries,
  {}
);

// ✅ Audit log pruning (daily at 2 AM UTC)
// Removes audit log entries older than 30 days
crons.cron(
  "external-tracking-audit-log-prune",
  "0 2 * * *",
  internal.externalTrackingAuth.pruneAuditLogs,
  {}
);

// ✅ Webhook delivery queue cleanup (daily at 2:30 AM UTC)
// Removes DELIVERED items > 7 days, DEAD_LETTER items > 30 days
crons.cron(
  "external-tracking-webhook-queue-cleanup",
  "30 2 * * *",
  internal.externalTrackingAuth.pruneWebhookDeliveryQueue,
  {}
);

// ✅ Sandbox data refresh (daily at 4 AM UTC)
// Regenerates synthetic GPS/load data for all orgs with sandbox API keys
crons.cron(
  "external-tracking-sandbox-refresh",
  "0 4 * * *",
  internal.sandboxData.refreshAllSandboxData,
  {}
);

export default crons;
