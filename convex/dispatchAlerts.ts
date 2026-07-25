/**
 * Dispatch alerts engine (split-plan §5.2) — operational failures first.
 *
 * Detection paths:
 *   - Cron sweep (1-min cadence, cursor-batched over the by_status index,
 *     the documented Convex continuation pattern): TRACKING_LOST (no ping
 *     for 30 min on an in-progress load), MISSED_APPOINTMENT (stop window
 *     ended with no check-in), POD_MISSING (completed within 7 days, no
 *     POD on the load). The sweep also AUTO-RESOLVES open alerts whose
 *     condition cleared (fresh ping, check-in recorded, POD uploaded).
 *   - Event kinds (LOAD_CANCELED, OFFER_DECLINED) fire in-line from the
 *     guarded loadCarrierAssignments mutations.
 *
 * Dedupe: at most one OPEN alert per {assignmentId, kind} — raiseAlert
 * checks by_dedupe before inserting, so repeated ticks never multiply.
 * Feed queries are dual-path (WorkOS staff + Clerk owner-operators) and
 * fail loud; the same queries serve the web surface (D19).
 */
import { v } from 'convex/values';
import { internalMutation, mutation, query, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { requireCapability } from './lib/auth';
import { resolveOrgForRead } from './dispatchMobile';

const TRACKING_LOST_MS = 30 * 60 * 1000;
const POD_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_PAGE = 100;

type AlertKind = Doc<'dispatchAlerts'>['kind'];

export async function raiseAlert(
  ctx: MutationCtx,
  a: {
    orgExternalId: string;
    kind: AlertKind;
    severity: 'high' | 'med';
    assignmentId: Id<'loadCarrierAssignments'>;
    loadId?: Id<'loadInformation'>;
    driverId?: Id<'drivers'>;
    detail: string;
  },
): Promise<boolean> {
  const dupe = await ctx.db
    .query('dispatchAlerts')
    .withIndex('by_dedupe', (q) =>
      q.eq('assignmentId', a.assignmentId).eq('kind', a.kind).eq('status', 'open'),
    )
    .first();
  if (dupe) return false;
  await ctx.db.insert('dispatchAlerts', { ...a, status: 'open', createdAt: Date.now() });
  return true;
}

async function resolveAlert(
  ctx: MutationCtx,
  assignmentId: Id<'loadCarrierAssignments'>,
  kind: AlertKind,
): Promise<void> {
  const open = await ctx.db
    .query('dispatchAlerts')
    .withIndex('by_dedupe', (q) =>
      q.eq('assignmentId', assignmentId).eq('kind', kind).eq('status', 'open'),
    )
    .first();
  if (open) await ctx.db.patch(open._id, { status: 'resolved', resolvedAt: Date.now() });
}

/** Latest ping for a driver (newest first on the by_driver_time index). */
async function lastPing(ctx: MutationCtx, driverId: Id<'drivers'>) {
  return await ctx.db
    .query('driverLocations')
    .withIndex('by_driver_time', (q) => q.eq('driverId', driverId))
    .order('desc')
    .first();
}

async function evaluateInProgress(ctx: MutationCtx, a: Doc<'loadCarrierAssignments'>) {
  if (!a.carrierOrgId) return;
  const now = Date.now();

  // TRACKING_LOST — assigned driver silent for 30+ min.
  if (a.assignedDriverId) {
    const ping = await lastPing(ctx, a.assignedDriverId);
    const lost = !ping || ping.recordedAt < now - TRACKING_LOST_MS;
    if (lost) {
      const driver = await ctx.db.get(a.assignedDriverId);
      const mins = ping ? Math.round((now - ping.recordedAt) / 60000) : null;
      await raiseAlert(ctx, {
        orgExternalId: a.carrierOrgId,
        kind: 'TRACKING_LOST',
        severity: 'med',
        assignmentId: a._id,
        loadId: a.loadId,
        driverId: a.assignedDriverId,
        detail: `${driver ? `${driver.firstName} ${driver.lastName}` : 'Driver'} — ${
          mins != null ? `no GPS for ${mins} min` : 'no GPS data'
        } on an in-progress load. ETA unverifiable.`,
      });
    } else {
      await resolveAlert(ctx, a._id, 'TRACKING_LOST');
    }
  }

  // MISSED_APPOINTMENT — a stop window ended with no check-in.
  const stops = await ctx.db
    .query('loadStops')
    .withIndex('by_load', (q) => q.eq('loadId', a.loadId))
    .collect();
  const missed = stops.find((s) => {
    if (s.checkedInAt || !s.windowEndTime) return false;
    const end = Date.parse(s.windowEndTime);
    return Number.isFinite(end) && end < now;
  });
  if (missed) {
    await raiseAlert(ctx, {
      orgExternalId: a.carrierOrgId,
      kind: 'MISSED_APPOINTMENT',
      severity: 'high',
      assignmentId: a._id,
      loadId: a.loadId,
      driverId: a.assignedDriverId,
      detail: `${missed.stopType === 'PICKUP' ? 'Pickup' : 'Stop'} window at ${missed.address} ended with no check-in.`,
    });
  } else {
    await resolveAlert(ctx, a._id, 'MISSED_APPOINTMENT');
  }
}

async function evaluateCompleted(ctx: MutationCtx, a: Doc<'loadCarrierAssignments'>) {
  if (!a.carrierOrgId) return;
  if (!a.completedAt || a.completedAt < Date.now() - POD_LOOKBACK_MS) return;
  const load = await ctx.db.get(a.loadId);
  if (!load) return;
  if (!load.podStorageId && !load.hasSignedPod) {
    await raiseAlert(ctx, {
      orgExternalId: a.carrierOrgId,
      kind: 'POD_MISSING',
      severity: 'med',
      assignmentId: a._id,
      loadId: a.loadId,
      driverId: a.assignedDriverId,
      detail: `Load #${load.internalId} delivered with no POD attached. Blocks invoicing.`,
    });
  } else {
    await resolveAlert(ctx, a._id, 'POD_MISSING');
  }
}

/**
 * The sweep — one status segment per invocation chain, cursor-batched;
 * schedules its own continuation while pages remain (Convex cron pattern).
 */
export const sweep = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    segment: v.optional(v.union(v.literal('IN_PROGRESS'), v.literal('COMPLETED'))),
  },
  handler: async (ctx, args) => {
    const segment = args.segment ?? 'IN_PROGRESS';
    const page = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_status', (q) => q.eq('status', segment))
      .paginate({ cursor: args.cursor ?? null, numItems: SWEEP_PAGE });

    for (const a of page.page) {
      if (segment === 'IN_PROGRESS') await evaluateInProgress(ctx, a);
      else await evaluateCompleted(ctx, a);
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.dispatchAlerts.sweep, {
        cursor: page.continueCursor,
        segment,
      });
    } else if (segment === 'IN_PROGRESS') {
      await ctx.scheduler.runAfter(0, internal.dispatchAlerts.sweep, { segment: 'COMPLETED' });
    }
  },
});

/** Open alerts for the caller's org, newest first. Dual-path, fail-loud. */
export const listAlerts = query({
  args: {},
  handler: async (ctx) => {
    const resolved = await resolveOrgForRead(ctx, 'canViewOperations');
    const rows = await ctx.db
      .query('dispatchAlerts')
      .withIndex('by_org_status', (q) =>
        q.eq('orgExternalId', resolved.externalId).eq('status', 'open'),
      )
      .collect();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return Promise.all(
      rows.map(async (r) => {
        const driver = r.driverId ? await ctx.db.get(r.driverId) : null;
        const load = r.loadId ? await ctx.db.get(r.loadId) : null;
        return {
          ...r,
          driver: driver
            ? { _id: driver._id, firstName: driver.firstName, lastName: driver.lastName, phone: driver.phone }
            : null,
          loadInternalId: load?.internalId ?? null,
        };
      }),
    );
  },
});

export const dismissAlert = mutation({
  args: { alertId: v.id('dispatchAlerts') },
  handler: async (ctx, args) => {
    const alert = await ctx.db.get(args.alertId);
    if (!alert) throw new Error('Alert not found');
    await requireCapability(ctx, alert.orgExternalId, 'canDispatch');
    if (alert.status === 'open') await ctx.db.patch(args.alertId, { status: 'dismissed' });
    return { success: true };
  },
});
