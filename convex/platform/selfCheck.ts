import { query } from '../_generated/server';
import { requirePlatformStaff } from '../lib/auth';
import { jobState } from './jobHealth';

/**
 * "Is the console itself working?" — the answer to the failure mode where
 * everything looks calm because nothing is watching.
 *
 * Three things could previously be silently off with no surface anywhere:
 * Slack alerting (no webhook env var → notifySlack returns early), Stripe
 * (every entry point no-ops without a key), and the evaluator itself (its
 * heartbeat only alerts through an Axiom monitor that may not exist). This
 * query answers all of them from inside the console, so silence is never
 * mistaken for health.
 *
 * Deliberately reports only WHETHER a secret is configured, never any part of
 * its value.
 */

const EVALUATOR_JOB = 'platform-alerts-evaluate';
const SNAPSHOT_JOB = 'org-health-snapshots';

export const consoleSelfCheck = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    const now = Date.now();

    const jobByName = async (name: string) =>
      await ctx.db
        .query('cronHealth')
        .withIndex('by_job', (q) => q.eq('jobName', name))
        .unique();

    const evaluator = await jobByName(EVALUATOR_JOB);
    const snapshots = await jobByName(SNAPSHOT_JOB);
    const allJobs = await ctx.db.query('cronHealth').collect();

    // `e` is annotated because the Expo tsconfigs compile this file without
    // Node types, where `process.env.X` widens to `any` and the callback
    // parameter becomes an implicit any under `strict`.
    const staffAllowlistSize = (process.env.STAFF_EMAIL_ALLOWLIST ?? '')
      .split(',')
      .map((e: string) => e.trim())
      .filter(Boolean).length;

    const jobStates = allJobs.map((j) => jobState(j, now));

    return {
      generatedAt: now,
      integrations: [
        {
          key: 'slack_alerts',
          label: 'Slack alerting',
          configured: Boolean(process.env.SLACK_ALERT_WEBHOOK_URL),
          // Severity of NOT having it: alerts are written either way, but
          // nobody is told.
          impact: 'Alerts are recorded but never delivered — nothing pages you.',
        },
        {
          key: 'stripe',
          label: 'Stripe payments',
          configured: Boolean(process.env.STRIPE_SECRET_KEY),
          impact: 'Invoices can still be issued and paid manually.',
        },
        {
          key: 'stripe_webhook',
          label: 'Stripe webhook secret',
          configured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
          impact: 'Stripe payments will not flip invoices to paid automatically.',
        },
        {
          key: 'staff_issuer',
          label: 'Staff issuer',
          configured: Boolean(process.env.STAFF_ISSUER),
          impact: 'The console is disabled without it (you would not see this page).',
        },
      ],
      staffAllowlistSize,
      evaluator: evaluator
        ? {
            lastRunAt: evaluator.lastStartedAt,
            state: jobState(evaluator, now),
            lastOutcome: evaluator.lastOutcome,
          }
        : null,
      snapshots: snapshots
        ? {
            lastRunAt: snapshots.lastStartedAt,
            state: jobState(snapshots, now),
            lastOutcome: snapshots.lastOutcome,
          }
        : null,
      jobs: {
        total: allJobs.length,
        ok: jobStates.filter((s) => s === 'ok').length,
        failing: jobStates.filter((s) => s === 'failing').length,
        stale: jobStates.filter((s) => s === 'stale').length,
        hung: jobStates.filter((s) => s === 'hung').length,
        // Rows that predate cadence declarations: they can't be checked for
        // staleness until they tick once more.
        unknown: jobStates.filter((s) => s === 'unknown').length,
      },
    };
  },
});
