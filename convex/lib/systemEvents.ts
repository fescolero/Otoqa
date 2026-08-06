import type { MutationCtx } from '../_generated/server';

/**
 * The ONE write path into `systemEvents` — the platform console's
 * "needs attention" feed (docs/platform-admin-console-plan.md §7.1).
 *
 * Ground rules:
 *   - This is NOT logging. Axiom (Convex log streaming) is the log store.
 *     Write here only when a human should look: failures, dead-letters,
 *     anomalies, drift.
 *   - Never call unconditionally from high-frequency paths (the 10s/1min
 *     crons) — failure-only or sampled there.
 *   - `code` is a stable machine key ('cron.failed', 'webhook.dead_letter',
 *     'billing.drift', …) so the console can group and alerting can match
 *     without string-parsing messages.
 *
 * Inserts inside the caller's transaction (same rationale as lib/audit.ts).
 * Rows are pruned at 30 days by the platform-ledger-prune cron.
 */
export async function logSystemEvent(
  ctx: MutationCtx,
  event: {
    severity: 'info' | 'warn' | 'error' | 'critical';
    source: string;
    code: string;
    message: string;
    orgId?: string;
    context?: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.db.insert('systemEvents', {
    severity: event.severity,
    source: event.source,
    code: event.code,
    message: event.message.slice(0, 1000),
    orgId: event.orgId,
    context: event.context ? JSON.stringify(event.context).slice(0, 4000) : undefined,
    createdAt: Date.now(),
  });
}
