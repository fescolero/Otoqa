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

export default crons;
