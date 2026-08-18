import { v, ConvexError } from 'convex/values';
import { query, mutation, internalMutation, internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { requirePlatformStaff } from '../lib/auth';
import { jobState, overdueMs, formatDurationShort } from './jobHealth';
import { trackedFetch } from '../lib/externalHealth';

/**
 * Platform alerting (plan §9): a 5-minute evaluator checks the alerting
 * matrix's conditions, keeps ONE open alert per dedupeKey (the tenant
 * dispatchAlerts pattern), notifies Slack once per incident on open, and
 * auto-resolves when the condition clears.
 *
 * Dead-man's switch: every evaluator run logs the HEARTBEAT line below.
 * Configure an Axiom "absence" monitor on it — if the evaluator (or cron
 * scheduling generally) dies, the silence itself alerts.
 */

const HEARTBEAT = '[heartbeat] platform-alerts-evaluator alive';
const DEAD_LETTER_THRESHOLD = 10;
const CRON_FAILURE_THRESHOLD = 3;
const COUNT_CAP = 200;

type Condition = {
  dedupeKey: string;
  kind: string;
  severity: 'medium' | 'high';
  message: string;
  orgId?: string;
};

export const evaluate = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    console.log(HEARTBEAT);
    const now = Date.now();
    const active: Condition[] = [];

    // 1. Crons failing repeatedly — or, worse, not running at all.
    const jobs = await ctx.db.query('cronHealth').collect();
    for (const job of jobs) {
      const state = jobState(job, now);
      if (state === 'stale') {
        const late = overdueMs(job, now);
        active.push({
          dedupeKey: `cron_stale:${job.jobName}`,
          kind: 'cron_stale',
          severity: 'high',
          message: `Cron ${job.jobName} has not run for ${late ? formatDurationShort(late) : 'longer than expected'} (expected every ${formatDurationShort(job.expectedIntervalMs ?? 0)}). Last outcome was ${job.lastOutcome} — a job that stops firing raises nothing on its own.`,
        });
      } else if (state === 'hung') {
        active.push({
          dedupeKey: `cron_hung:${job.jobName}`,
          kind: 'cron_hung',
          severity: 'high',
          message: `Cron ${job.jobName} started ${formatDurationShort(now - (job.inFlightSince ?? now))} ago and never reported — the run was killed mid-flight.`,
        });
      }
      if (job.consecutiveFailures >= CRON_FAILURE_THRESHOLD) {
        active.push({
          dedupeKey: `cron:${job.jobName}`,
          kind: 'cron_failing',
          severity: 'high',
          message: `Cron ${job.jobName} has failed ${job.consecutiveFailures} consecutive ticks: ${job.lastError ?? 'unknown error'}`,
        });
      }
    }

    // 2. Billing drift on an invoiced period (alert matrix, plan §9). The
    // systemEvent was already written by the recalc; this escalates it so a
    // number moving under a committed invoice reaches a human.
    const driftedInvoices = [
      ...(await ctx.db
        .query('platformInvoices')
        .withIndex('by_status', (q) => q.eq('status', 'issued'))
        .take(COUNT_CAP)),
      ...(await ctx.db
        .query('platformInvoices')
        .withIndex('by_status', (q) => q.eq('status', 'sent'))
        .take(COUNT_CAP)),
      ...(await ctx.db
        .query('platformInvoices')
        .withIndex('by_status', (q) => q.eq('status', 'partially_paid'))
        .take(COUNT_CAP)),
    ].filter((i) => i.driftDetectedAt !== undefined);
    for (const invoice of driftedInvoices) {
      active.push({
        dedupeKey: `billing_drift:${invoice.invoiceNumber}`,
        kind: 'billing_drift',
        severity: 'medium',
        message: `Usage rose after ${invoice.invoiceNumber} (${invoice.periodKey}) was committed — bill the delta next cycle or waive it`,
        orgId: invoice.workosOrgId,
      });
    }

    // 3. Webhook dead-letters piling up.
    const deadLetters = await ctx.db
      .query('webhookDeliveryQueue')
      .withIndex('by_status_next', (q) => q.eq('status', 'DEAD_LETTER'))
      .take(COUNT_CAP);
    if (deadLetters.length > DEAD_LETTER_THRESHOLD) {
      active.push({
        dedupeKey: 'webhooks:dead_letter',
        kind: 'webhook_dead_letters',
        severity: 'medium',
        message: `${deadLetters.length}${deadLetters.length >= COUNT_CAP ? '+' : ''} webhook deliveries in dead-letter`,
      });
    }

    // 4. FourKites push fully failing for an org.
    const fkRows = await ctx.db.query('fourKitesPushTickHealth').collect();
    for (const row of fkRows) {
      if (row.lastTickKind === 'all_failed') {
        active.push({
          dedupeKey: `fourkites:${row.workosOrgId}`,
          kind: 'fourkites_all_failed',
          severity: 'high',
          message: `FourKites push all_failed for org ${row.workosOrgId} (${row.lastErrorKind ?? 'unknown'}${row.lastErrorStatus ? ` ${row.lastErrorStatus}` : ''})`,
          orgId: row.workosOrgId,
        });
      }
    }

    // Upsert active conditions (open OR acked rows both count as "the
    // incident is known" — acking silences the row, it must not re-open).
    const activeKeys = new Set(active.map((c) => c.dedupeKey));
    for (const cond of active) {
      const open =
        (await ctx.db
          .query('platformAlerts')
          .withIndex('by_dedupe', (q) => q.eq('dedupeKey', cond.dedupeKey).eq('status', 'open'))
          .first()) ??
        (await ctx.db
          .query('platformAlerts')
          .withIndex('by_dedupe', (q) => q.eq('dedupeKey', cond.dedupeKey).eq('status', 'acked'))
          .first()) ??
        // A snoozed row counts as "known" even once resolved: without this,
        // resolving a still-broken condition would re-open (and re-Slack) it
        // on the very next tick, which is why snooze exists.
        (
          await ctx.db
            .query('platformAlerts')
            .withIndex('by_dedupe', (q) => q.eq('dedupeKey', cond.dedupeKey).eq('status', 'resolved'))
            .order('desc')
            .take(1)
        ).find((r) => (r.snoozedUntil ?? 0) > now);

      if (open) {
        await ctx.db.patch(open._id, {
          lastSeenAt: now,
          count: open.count + 1,
          message: cond.message,
        });
      } else {
        const id = await ctx.db.insert('platformAlerts', {
          ...cond,
          status: 'open',
          firstSeenAt: now,
          lastSeenAt: now,
          count: 1,
        });
        // Notify once per incident, from an action (fetch is action-only).
        await ctx.scheduler.runAfter(0, internal.platform.alerts.notifySlack, {
          alertId: id,
          severity: cond.severity,
          message: cond.message,
        });
      }
    }

    // Auto-resolve open/acked alerts whose condition cleared.
    const unresolved = [
      ...(await ctx.db
        .query('platformAlerts')
        .withIndex('by_status_time', (q) => q.eq('status', 'open'))
        .take(COUNT_CAP)),
      ...(await ctx.db
        .query('platformAlerts')
        .withIndex('by_status_time', (q) => q.eq('status', 'acked'))
        .take(COUNT_CAP)),
    ];
    for (const alert of unresolved) {
      if (!activeKeys.has(alert.dedupeKey)) {
        await ctx.db.patch(alert._id, { status: 'resolved', resolvedAt: now });
      }
    }
    return null;
  },
});

export const notifySlack = internalAction({
  args: {
    alertId: v.id('platformAlerts'),
    severity: v.union(v.literal('medium'), v.literal('high')),
    message: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const webhookUrl = process.env.SLACK_ALERT_WEBHOOK_URL;
    if (!webhookUrl) return null; // alerting to Slack simply off until configured

    const icon = args.severity === 'high' ? '🔴' : '🟠';
    try {
      const res = await trackedFetch(ctx, 'slack', webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `${icon} [otoqa-platform] ${args.message}` }),
      });
      if (res.ok) {
        await ctx.runMutation(internal.platform.alerts.markNotified, { alertId: args.alertId });
      } else {
        console.error(`[alerts] Slack notify failed: HTTP ${res.status}`);
      }
    } catch (e) {
      // Never let notification failure affect alert state; the row is the
      // record, Slack is best-effort delivery.
      console.error(`[alerts] Slack notify error: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  },
});

export const markNotified = internalMutation({
  args: { alertId: v.id('platformAlerts') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const alert = await ctx.db.get(args.alertId);
    if (alert) await ctx.db.patch(args.alertId, { slackNotifiedAt: Date.now() });
    return null;
  },
});

// ─── Console surface ─────────────────────────────────────────────────────

export const listAlerts = query({
  args: { includeResolved: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const open = await ctx.db
      .query('platformAlerts')
      .withIndex('by_status_time', (q) => q.eq('status', 'open'))
      .order('desc')
      .take(100);
    const acked = await ctx.db
      .query('platformAlerts')
      .withIndex('by_status_time', (q) => q.eq('status', 'acked'))
      .order('desc')
      .take(100);
    const resolved = args.includeResolved
      ? await ctx.db
          .query('platformAlerts')
          .withIndex('by_status_time', (q) => q.eq('status', 'resolved'))
          .order('desc')
          .take(25)
      : [];
    return [...open, ...acked, ...resolved];
  },
});

export const ackAlert = mutation({
  args: { alertId: v.id('platformAlerts') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const alert = await ctx.db.get(args.alertId);
    if (!alert || alert.status !== 'open') return null; // idempotent
    await ctx.db.patch(args.alertId, {
      status: 'acked',
      acknowledgedBy: staff.email,
    });
    return null;
  },
});

/**
 * Close an incident by hand — for conditions the evaluator can't see clearing
 * (an upstream vendor confirming a fix, a one-off we've decided is noise).
 *
 * If the condition is genuinely still true the next tick re-opens it, which is
 * the correct behaviour: resolve means "I believe this is over", not "stop
 * telling me". Use snooze for the latter.
 */
export const resolveAlert = mutation({
  args: { alertId: v.id('platformAlerts'), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const alert = await ctx.db.get(args.alertId);
    if (!alert) throw new ConvexError('Alert not found');
    if (alert.status === 'resolved') return null; // idempotent
    await ctx.db.patch(args.alertId, {
      status: 'resolved',
      resolvedAt: Date.now(),
      resolvedBy: staff.email,
      ...(args.note
        ? { note: args.note.slice(0, 1000), noteBy: staff.email, noteAt: Date.now() }
        : {}),
    });
    return null;
  },
});

/**
 * Suppress a known incident that's already being worked. Resolves the row and
 * holds the dedupe key quiet until the window expires — no new alert, no
 * repeat Slack message. When the window lapses and the condition still holds,
 * it re-opens and pages again, so a snooze can't silently become a forever.
 */
export const snoozeAlert = mutation({
  args: {
    alertId: v.id('platformAlerts'),
    hours: v.number(),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const alert = await ctx.db.get(args.alertId);
    if (!alert) throw new ConvexError('Alert not found');
    if (!(args.hours > 0) || args.hours > 168) {
      throw new ConvexError('Snooze must be between 0 and 168 hours (7 days)');
    }
    const now = Date.now();
    await ctx.db.patch(args.alertId, {
      status: 'resolved',
      resolvedAt: now,
      resolvedBy: staff.email,
      snoozedUntil: now + args.hours * 60 * 60 * 1000,
      snoozedBy: staff.email,
      ...(args.note
        ? { note: args.note.slice(0, 1000), noteBy: staff.email, noteAt: now }
        : {}),
    });
    return null;
  },
});

/** Carry what's being done about an incident alongside it. */
export const annotateAlert = mutation({
  args: { alertId: v.id('platformAlerts'), note: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const alert = await ctx.db.get(args.alertId);
    if (!alert) throw new ConvexError('Alert not found');
    await ctx.db.patch(args.alertId, {
      note: args.note.slice(0, 1000),
      noteBy: staff.email,
      noteAt: Date.now(),
    });
    return null;
  },
});
