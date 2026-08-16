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
/**
 * Recurrences of the same (code, orgId) inside this window collapse onto the
 * existing row. A stuck condition firing every tick must be ONE entry in the
 * feed — an unclearable wall of duplicates is how an attention feed becomes
 * something operators stop reading.
 */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  const now = Date.now();
  const dedupeKey = `${event.code}:${event.orgId ?? '*'}`;

  const existing = await ctx.db
    .query('systemEvents')
    .withIndex('by_dedupe', (q) => q.eq('dedupeKey', dedupeKey))
    .order('desc')
    .first();

  if (existing && now - (existing.lastSeenAt ?? existing.createdAt) < DEDUPE_WINDOW_MS) {
    // Bump the existing row. `lastSeenAt` moving past `ackedAt` is what makes
    // an acknowledged-but-still-happening problem resurface (see the ack rule
    // in the schema) — an ack silences one occurrence, not the condition.
    await ctx.db.patch(existing._id, {
      lastSeenAt: now,
      occurrences: (existing.occurrences ?? 1) + 1,
      // Keep the latest detail and the highest severity seen in the window.
      message: event.message.slice(0, 1000),
      severity: severityRank(event.severity) > severityRank(existing.severity)
        ? event.severity
        : existing.severity,
      context: event.context ? JSON.stringify(event.context).slice(0, 4000) : existing.context,
    });
    return;
  }

  await ctx.db.insert('systemEvents', {
    severity: event.severity,
    source: event.source,
    code: event.code,
    message: event.message.slice(0, 1000),
    orgId: event.orgId,
    context: event.context ? JSON.stringify(event.context).slice(0, 4000) : undefined,
    dedupeKey,
    occurrences: 1,
    lastSeenAt: now,
    createdAt: now,
  });
}

function severityRank(s: 'info' | 'warn' | 'error' | 'critical'): number {
  return { info: 0, warn: 1, error: 2, critical: 3 }[s];
}
