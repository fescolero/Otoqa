/**
 * Load progress — the ONE place a load's live state is derived.
 *
 * Web, mobile, and the dispatch Schedule all used to compute "how far
 * along is this load" and "what is its status" on their own, from
 * different fields: the web counted check-in taps, the driver app counted
 * check-out taps, the Schedule read the dispatch leg, and the status chip
 * read two columns on the load row. They disagreed whenever a stop was
 * closed by anything other than a driver tap that reached the server on
 * time. This module replaces all of that with a single server-side
 * derivation, so every client renders the same truth — and says HOW that
 * truth was established.
 *
 * Provenance is first-class. The primary record is always the driver's
 * tap (checkedInAt / checkedOutAt, device time). When the tap did not
 * reach the server in time, the geofence fallback stamps autoArrivedAt /
 * autoDepartedAt instead. When both exist the tap arrived AFTER the
 * fallback fired, and the sync bookkeeping (checkedInSync /
 * checkedOutSync, when present) says whether that was a queued replay or
 * a driver who tapped late. Each stop event therefore carries one of:
 *
 *   manual            tap reached the server before the fallback fired
 *   manual_late_sync  tap was made in time but reached the server late
 *                     (offline queue, timeout replay)
 *   manual_late_tap   driver tapped after the fallback had already fired
 *   gps               no tap ever arrived; the geofence closed the event
 *   reported          status set without any timestamped evidence
 *                     (updateStopStatus, dispatcher edits, legacy rows)
 *
 * Pure: no clock, no db. Used by the load / mobile / schedule queries, the
 * completion reconcile, and tests.
 */

import { v } from 'convex/values';

/** Mirrors geofenceEvaluator.TAP_GRACE_MS — kept here so the helper stays
 *  dependency-free; the evaluator imports this constant. */
export const TAP_GRACE_MS = 20 * 60 * 1000;

export type StopEventSource =
  | 'manual'
  | 'manual_late_sync'
  | 'manual_late_tap'
  | 'gps'
  | 'reported';

export type StopPhase = 'pending' | 'arrived' | 'departed' | 'canceled';

export interface StopSyncLike {
  /** Server time the tap was written. */
  receivedAt: number;
  /** True when the tap came through the offline queue replay. */
  replayed?: boolean;
  /** Device time the tap was queued (replayed taps only). */
  queuedAt?: number;
  retryCount?: number;
}

export interface ProgressStopLike {
  _id?: string;
  sequenceNumber: number;
  stopType: 'PICKUP' | 'DELIVERY' | 'DETOUR';
  status?: 'Pending' | 'In Transit' | 'Completed' | 'Delayed' | 'Canceled';
  city?: string;
  state?: string;
  /** ISO 8601 device time of the driver's tap. */
  checkedInAt?: string;
  checkedOutAt?: string;
  /** ms epoch from the geofence fallback (tapGraceCheck). */
  autoArrivedAt?: number;
  autoDepartedAt?: number;
  /** ISO 8601 device time of a free-form status report. */
  statusUpdatedAt?: string;
  checkedInSync?: StopSyncLike;
  checkedOutSync?: StopSyncLike;
}

export interface StopEvent {
  /** The time the event is attributed to (ms). Manual taps win over the
   *  fence: the tap is the driver's own record. */
  at: number;
  source: StopEventSource;
  /** Geofence detection time when one exists alongside a tap (ms). */
  detectedAt: number | null;
  /** receivedAt − tap time when the sync bookkeeping is present. */
  syncLagMs: number | null;
  replayed: boolean;
}

export interface StopProgress {
  stopId: string | null;
  sequenceNumber: number;
  stopType: 'PICKUP' | 'DELIVERY' | 'DETOUR';
  city: string | null;
  state: string | null;
  /** False for detour and canceled stops — they never gate completion. */
  counted: boolean;
  phase: StopPhase;
  arrival: StopEvent | null;
  departure: StopEvent | null;
  /** Human label for the stop's status chip: "Delivered", "Delivered · GPS",
   *  "Delivered · synced late", … */
  label: string;
  /** True when every closed event on this stop is backed by a tap. */
  supported: boolean;
}

export type LoadProgressStatus =
  | 'open'
  | 'assigned'
  | 'in_transit'
  | 'delivered'
  | 'canceled'
  | 'expired';

export type LoadEvidence = 'manual' | 'mixed' | 'gps' | 'reported' | 'none';

export interface LoadProgressLoadLike {
  status: 'Open' | 'Assigned' | 'Canceled' | 'Completed' | 'Expired';
  trackingStatus: 'Pending' | 'In Transit' | 'Completed' | 'Delayed' | 'Canceled';
  completionSource?: LoadCompletionSource;
  deliveredAt?: number;
}

export type LoadCompletionSource =
  | 'driver_checkout'
  | 'geofence'
  | 'session_end'
  | 'dispatcher'
  | 'carrier'
  | 'reconcile';

export interface LoadProgress {
  /** The status every client renders. Derived from the recorded status
   *  and the stops; see deriveLoadProgress for the rules. */
  status: LoadProgressStatus;
  /** What the load row itself says — exposed so a client can show "recorded
   *  as Assigned" next to a derived "delivered" while a backfill runs. */
  recordedStatus: LoadProgressLoadLike['status'];
  delayed: boolean;
  label: string;
  /** 0–100, closed counted stops over counted stops. */
  percent: number;
  stopsTotal: number;
  stopsArrived: number;
  stopsClosed: number;
  /** All counted stops are closed — the completion reconcile fires on this. */
  allStopsClosed: boolean;
  evidence: LoadEvidence;
  evidenceLabel: string;
  closedBy: Record<StopEventSource, number>;
  completionSource: LoadCompletionSource | null;
  /** Latest attributed event across all stops, for "Departed stop 2 · 7:10". */
  lastEvent: { sequenceNumber: number; kind: 'arrival' | 'departure'; event: StopEvent } | null;
  stops: StopProgress[];
}

const parseIso = (s: string | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

function classifyTap(tapMs: number, detectedAt: number | null): StopEventSource {
  if (detectedAt === null) return 'manual';
  // The fallback fires TAP_GRACE_MS after detection. A tap made before
  // that moment was on time but arrived late; one made after it is a
  // driver who tapped late. (A replayed tap made after the grace is still
  // a late tap — the replay flag stays on the event for the audit trail.)
  return tapMs < detectedAt + TAP_GRACE_MS ? 'manual_late_sync' : 'manual_late_tap';
}

function buildEvent(
  tapIso: string | undefined,
  detectedAt: number | undefined,
  sync: StopSyncLike | undefined,
  reportedIso: string | undefined,
): StopEvent | null {
  const tapMs = parseIso(tapIso);
  const detected = typeof detectedAt === 'number' && Number.isFinite(detectedAt) ? detectedAt : null;
  if (tapMs !== null) {
    return {
      at: tapMs,
      source: classifyTap(tapMs, detected),
      detectedAt: detected,
      syncLagMs: sync ? Math.max(0, sync.receivedAt - tapMs) : null,
      replayed: sync?.replayed === true,
    };
  }
  if (detected !== null) {
    return { at: detected, source: 'gps', detectedAt: detected, syncLagMs: null, replayed: false };
  }
  const reportedMs = parseIso(reportedIso);
  if (reportedMs !== null) {
    return { at: reportedMs, source: 'reported', detectedAt: null, syncLagMs: null, replayed: false };
  }
  return null;
}

const SOURCE_SUFFIX: Record<StopEventSource, string> = {
  manual: '',
  manual_late_sync: ' · synced late',
  manual_late_tap: ' · tapped late',
  gps: ' · GPS',
  reported: ' · reported',
};

export function stopEventSourceLabel(source: StopEventSource): string {
  switch (source) {
    case 'manual':
      return 'Driver tap';
    case 'manual_late_sync':
      return 'Driver tap, synced late';
    case 'manual_late_tap':
      return 'Driver tap, after GPS';
    case 'gps':
      return 'GPS only';
    case 'reported':
      return 'Reported, no timestamp';
  }
}

export function deriveStopProgress(stop: ProgressStopLike): StopProgress {
  const canceled = stop.status === 'Canceled';
  const counted = stop.stopType !== 'DETOUR' && !canceled;

  const arrival = buildEvent(
    stop.checkedInAt,
    stop.autoArrivedAt,
    stop.checkedInSync,
    stop.status === 'In Transit' || stop.status === 'Completed' ? stop.statusUpdatedAt : undefined,
  );
  const departure = buildEvent(
    stop.checkedOutAt,
    stop.autoDepartedAt,
    stop.checkedOutSync,
    stop.status === 'Completed' ? stop.statusUpdatedAt : undefined,
  );

  // A status of Completed with no evidence at all still closes the stop
  // (legacy rows, dispatcher edits) — attributed as 'reported' with no
  // time, so the client can show it as unsupported rather than hide it.
  const completedWithoutEvidence = stop.status === 'Completed' && !departure;
  const phase: StopPhase = canceled
    ? 'canceled'
    : departure || completedWithoutEvidence
      ? 'departed'
      : arrival
        ? 'arrived'
        : 'pending';

  const closing = departure ?? (completedWithoutEvidence ? { source: 'reported' as const } : null);
  const base =
    phase === 'canceled'
      ? 'Canceled'
      : phase === 'departed'
        ? stop.stopType === 'PICKUP'
          ? 'Picked up'
          : 'Delivered'
        : phase === 'arrived'
          ? 'At stop'
          : 'Pending';
  const suffixSource = phase === 'departed' ? closing?.source : phase === 'arrived' ? arrival?.source : undefined;
  const label = base + (suffixSource ? SOURCE_SUFFIX[suffixSource] : '');

  const isManual = (e: StopEvent | null) =>
    !e || e.source === 'manual' || e.source === 'manual_late_sync' || e.source === 'manual_late_tap';
  const supported =
    phase === 'pending' || phase === 'canceled'
      ? true
      : isManual(arrival) && isManual(departure) && !completedWithoutEvidence;

  return {
    stopId: stop._id ?? null,
    sequenceNumber: stop.sequenceNumber,
    stopType: stop.stopType,
    city: stop.city ?? null,
    state: stop.state ?? null,
    counted,
    phase,
    arrival,
    departure,
    label,
    supported,
  };
}

const STATUS_LABEL: Record<LoadProgressStatus, string> = {
  open: 'Open · waiting for assignment',
  assigned: 'Assigned · pickup pending',
  in_transit: 'In transit',
  delivered: 'Delivered',
  canceled: 'Cancelled',
  expired: 'Expired',
};

export function deriveLoadProgress(
  load: LoadProgressLoadLike,
  rawStops: readonly ProgressStopLike[],
): LoadProgress {
  const stops = [...rawStops]
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
    .map(deriveStopProgress);

  const counted = stops.filter((s) => s.counted);
  const stopsTotal = counted.length;
  const stopsArrived = counted.filter((s) => s.phase === 'arrived' || s.phase === 'departed').length;
  const stopsClosed = counted.filter((s) => s.phase === 'departed').length;
  const allStopsClosed = stopsTotal > 0 && stopsClosed === stopsTotal;

  const closedBy: Record<StopEventSource, number> = {
    manual: 0,
    manual_late_sync: 0,
    manual_late_tap: 0,
    gps: 0,
    reported: 0,
  };
  for (const s of counted) {
    if (s.phase !== 'departed') continue;
    closedBy[s.departure?.source ?? 'reported']++;
  }
  const manualClosed = closedBy.manual + closedBy.manual_late_sync + closedBy.manual_late_tap;
  const evidence: LoadEvidence =
    stopsClosed === 0
      ? 'none'
      : manualClosed === stopsClosed
        ? 'manual'
        : closedBy.gps === stopsClosed
          ? 'gps'
          : closedBy.reported === stopsClosed
            ? 'reported'
            : 'mixed';

  const delayed = load.trackingStatus === 'Delayed';
  let status: LoadProgressStatus;
  switch (load.status) {
    case 'Canceled':
      status = 'canceled';
      break;
    case 'Expired':
      status = 'expired';
      break;
    case 'Completed':
      status = 'delivered';
      break;
    case 'Open':
      status = 'open';
      break;
    case 'Assigned':
    default:
      // The load row lags reality when the stops closed by a path that
      // never completed the load (GPS fallback, shift end). The reconcile
      // fixes the row; until it runs the derived status says what the
      // stops say, and recordedStatus keeps the discrepancy visible.
      if (allStopsClosed) status = 'delivered';
      else if (stopsArrived > 0 || load.trackingStatus === 'In Transit' || delayed) status = 'in_transit';
      else status = 'assigned';
  }

  const label =
    status === 'assigned' && delayed ? 'Assigned · delayed' : STATUS_LABEL[status];

  const evidenceLabel = (() => {
    switch (evidence) {
      case 'manual':
        return 'Confirmed by driver taps';
      case 'gps':
        return 'GPS only — no driver taps';
      case 'mixed':
        return `${manualClosed} of ${stopsClosed} stops confirmed by driver taps`;
      case 'reported':
        return 'Reported without timestamps';
      case 'none':
        return 'No stop activity yet';
    }
  })();

  let lastEvent: LoadProgress['lastEvent'] = null;
  for (const s of stops) {
    if (s.arrival && (!lastEvent || s.arrival.at >= lastEvent.event.at)) {
      lastEvent = { sequenceNumber: s.sequenceNumber, kind: 'arrival', event: s.arrival };
    }
    if (s.departure && (!lastEvent || s.departure.at >= lastEvent.event.at)) {
      lastEvent = { sequenceNumber: s.sequenceNumber, kind: 'departure', event: s.departure };
    }
  }

  return {
    status,
    recordedStatus: load.status,
    delayed,
    label,
    percent: stopsTotal > 0 ? Math.round((stopsClosed / stopsTotal) * 100) : 0,
    stopsTotal,
    stopsArrived,
    stopsClosed,
    allStopsClosed,
    evidence,
    evidenceLabel,
    closedBy,
    completionSource: load.completionSource ?? null,
    lastEvent,
    stops,
  };
}

// ---------------------------------------------------------------------------
// Convex validators for the derived shape, so queries with declared
// `returns` (the mobile projections) can carry it verbatim.
// ---------------------------------------------------------------------------


export const stopEventSourceValidator = v.union(
  v.literal('manual'),
  v.literal('manual_late_sync'),
  v.literal('manual_late_tap'),
  v.literal('gps'),
  v.literal('reported'),
);

export const loadCompletionSourceValidator = v.union(
  v.literal('driver_checkout'),
  v.literal('geofence'),
  v.literal('session_end'),
  v.literal('dispatcher'),
  v.literal('carrier'),
  v.literal('reconcile'),
);

export const stopSyncValidator = v.object({
  receivedAt: v.number(),
  replayed: v.optional(v.boolean()),
  queuedAt: v.optional(v.number()),
  retryCount: v.optional(v.number()),
});

const stopEventValidator = v.object({
  at: v.number(),
  source: stopEventSourceValidator,
  detectedAt: v.union(v.number(), v.null()),
  syncLagMs: v.union(v.number(), v.null()),
  replayed: v.boolean(),
});

const stopPhaseValidator = v.union(
  v.literal('pending'),
  v.literal('arrived'),
  v.literal('departed'),
  v.literal('canceled'),
);

export const stopProgressValidator = v.object({
  stopId: v.union(v.string(), v.null()),
  sequenceNumber: v.number(),
  stopType: v.union(v.literal('PICKUP'), v.literal('DELIVERY'), v.literal('DETOUR')),
  city: v.union(v.string(), v.null()),
  state: v.union(v.string(), v.null()),
  counted: v.boolean(),
  phase: stopPhaseValidator,
  arrival: v.union(stopEventValidator, v.null()),
  departure: v.union(stopEventValidator, v.null()),
  label: v.string(),
  supported: v.boolean(),
});

export const loadProgressStatusValidator = v.union(
  v.literal('open'),
  v.literal('assigned'),
  v.literal('in_transit'),
  v.literal('delivered'),
  v.literal('canceled'),
  v.literal('expired'),
);

export const loadProgressValidator = v.object({
  status: loadProgressStatusValidator,
  recordedStatus: v.union(
    v.literal('Open'),
    v.literal('Assigned'),
    v.literal('Canceled'),
    v.literal('Completed'),
    v.literal('Expired'),
  ),
  delayed: v.boolean(),
  label: v.string(),
  percent: v.number(),
  stopsTotal: v.number(),
  stopsArrived: v.number(),
  stopsClosed: v.number(),
  allStopsClosed: v.boolean(),
  evidence: v.union(
    v.literal('manual'),
    v.literal('mixed'),
    v.literal('gps'),
    v.literal('reported'),
    v.literal('none'),
  ),
  evidenceLabel: v.string(),
  closedBy: v.object({
    manual: v.number(),
    manual_late_sync: v.number(),
    manual_late_tap: v.number(),
    gps: v.number(),
    reported: v.number(),
  }),
  completionSource: v.union(loadCompletionSourceValidator, v.null()),
  lastEvent: v.union(
    v.object({
      sequenceNumber: v.number(),
      kind: v.union(v.literal('arrival'), v.literal('departure')),
      event: stopEventValidator,
    }),
    v.null(),
  ),
  stops: v.array(stopProgressValidator),
});
