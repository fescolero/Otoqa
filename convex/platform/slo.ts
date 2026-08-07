import { query } from '../_generated/server';
import { requirePlatformStaff } from '../lib/auth';

/**
 * Platform console — SLI overview (Phase 4). Baseline numbers for the
 * service-level indicators from plan §9; SLO targets get set after a
 * month of watching these. Cheap by construction: bounded index reads
 * over ledgers that already exist. GPS ping-latency percentiles stay in
 * the _devTools/syncLatencyDiag deep-dive (too heavy for a live query).
 */

const SAMPLE = 500;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export const sloOverview = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);

    // Cron success rate — lifetime counters from the run ledger.
    const jobs = await ctx.db.query('cronHealth').collect();
    const totalRuns = jobs.reduce((s, j) => s + j.totalRuns, 0);
    const totalFailures = jobs.reduce((s, j) => s + j.totalFailures, 0);
    const cron = {
      jobs: jobs.length,
      totalRuns,
      totalFailures,
      successRate: totalRuns > 0 ? (totalRuns - totalFailures) / totalRuns : null,
      failingNow: jobs.filter((j) => j.consecutiveFailures > 0).length,
    };

    // Partner API — last SAMPLE requests from apiAuditLog (30-day table).
    const apiRows = await ctx.db.query('apiAuditLog').order('desc').take(SAMPLE);
    const latencies = apiRows
      .map((r) => r.responseTimeMs)
      .filter((n): n is number => typeof n === 'number')
      .sort((a, b) => a - b);
    const serverErrors = apiRows.filter((r) => r.statusCode >= 500).length;
    const partnerApi = {
      sample: apiRows.length,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      errorRate: apiRows.length > 0 ? serverErrors / apiRows.length : null,
      windowStart: apiRows.at(-1)?.timestamp ?? null,
    };

    // Webhook delivery — queue composition (bounded counts).
    const count = async (status: 'PENDING' | 'DELIVERED' | 'DEAD_LETTER') =>
      (
        await ctx.db
          .query('webhookDeliveryQueue')
          .withIndex('by_status_next', (q) => q.eq('status', status))
          .take(SAMPLE)
      ).length;
    const delivered = await count('DELIVERED');
    const deadLetter = await count('DEAD_LETTER');
    const webhooks = {
      pending: await count('PENDING'),
      delivered, // retained 7 days
      deadLetter, // retained 30 days
      successRate: delivered + deadLetter > 0 ? delivered / (delivered + deadLetter) : null,
      sampleCap: SAMPLE,
    };

    return { cron, partnerApi, webhooks, generatedAt: Date.now() };
  },
});
