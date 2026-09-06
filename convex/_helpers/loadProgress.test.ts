/**
 * deriveLoadProgress is the single source every client renders. These tests
 * pin the provenance rules (manual / late sync / late tap / GPS / reported)
 * and the load-level status derivation, including the "row lags the stops"
 * case that stranded load 121536139 at "In transit · 50%".
 */

import { describe, it, expect } from 'vitest';
import {
  deriveLoadProgress,
  deriveStopProgress,
  TAP_GRACE_MS,
  type ProgressStopLike,
} from './loadProgress';

const T0 = Date.UTC(2026, 8, 5, 13, 0, 0); // Sat Sep 5 2026 06:00 PDT
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const stop = (
  sequenceNumber: number,
  stopType: ProgressStopLike['stopType'],
  extra: Partial<ProgressStopLike> = {},
): ProgressStopLike => ({ _id: `s${sequenceNumber}`, sequenceNumber, stopType, city: `C${sequenceNumber}`, ...extra });

const assigned = { status: 'Assigned' as const, trackingStatus: 'In Transit' as const };

describe('deriveStopProgress — provenance', () => {
  it('a tap with no fence record is manual and supported', () => {
    const p = deriveStopProgress(
      stop(1, 'PICKUP', { status: 'Completed', checkedInAt: iso(T0), checkedOutAt: iso(T0 + 10 * MIN) }),
    );
    expect(p.phase).toBe('departed');
    expect(p.arrival?.source).toBe('manual');
    expect(p.departure?.source).toBe('manual');
    expect(p.supported).toBe(true);
    expect(p.label).toBe('Picked up');
  });

  it('a tap made inside the grace window but written after the fence fired is a late sync', () => {
    const detected = T0;
    const tap = T0 + 5 * MIN; // in time
    const received = detected + TAP_GRACE_MS + 12 * MIN; // arrived after the fallback
    const p = deriveStopProgress(
      stop(3, 'DELIVERY', {
        status: 'Completed',
        checkedInAt: iso(tap),
        autoArrivedAt: detected,
        checkedInSync: { receivedAt: received, replayed: true, queuedAt: tap, retryCount: 2 },
        checkedOutAt: iso(tap + 8 * MIN),
        autoDepartedAt: tap + 6 * MIN,
      }),
    );
    expect(p.arrival?.source).toBe('manual_late_sync');
    expect(p.arrival?.at).toBe(tap); // the tap is the record; the fence is context
    expect(p.arrival?.detectedAt).toBe(detected);
    expect(p.arrival?.syncLagMs).toBe(received - tap);
    expect(p.arrival?.replayed).toBe(true);
    expect(p.departure?.source).toBe('manual_late_sync');
    expect(p.supported).toBe(true);
    expect(p.label).toBe('Delivered · synced late');
  });

  it('a tap made after the grace window is a late tap, still manual', () => {
    const detected = T0;
    const tap = detected + TAP_GRACE_MS + MIN;
    const p = deriveStopProgress(
      stop(2, 'DELIVERY', { status: 'Completed', checkedOutAt: iso(tap), autoDepartedAt: detected }),
    );
    expect(p.departure?.source).toBe('manual_late_tap');
    expect(p.supported).toBe(true);
    expect(p.label).toBe('Delivered · tapped late');
  });

  it('fence-only closure is gps and unsupported', () => {
    const p = deriveStopProgress(
      stop(4, 'DELIVERY', { status: 'Completed', autoArrivedAt: T0, autoDepartedAt: T0 + 9 * MIN }),
    );
    expect(p.phase).toBe('departed');
    expect(p.arrival?.source).toBe('gps');
    expect(p.departure?.source).toBe('gps');
    expect(p.departure?.at).toBe(T0 + 9 * MIN);
    expect(p.supported).toBe(false);
    expect(p.label).toBe('Delivered · GPS');
  });

  it('a Completed status with no timestamps at all is reported and unsupported', () => {
    const p = deriveStopProgress(stop(2, 'DELIVERY', { status: 'Completed' }));
    expect(p.phase).toBe('departed');
    expect(p.departure).toBeNull();
    expect(p.supported).toBe(false);
    expect(p.label).toBe('Delivered · reported');
  });

  it('a status report with statusUpdatedAt is reported with that time', () => {
    const p = deriveStopProgress(
      stop(2, 'DELIVERY', { status: 'Completed', statusUpdatedAt: iso(T0 + 3 * MIN) }),
    );
    expect(p.departure?.source).toBe('reported');
    expect(p.departure?.at).toBe(T0 + 3 * MIN);
  });

  it('arrived but not departed is "At stop"', () => {
    const p = deriveStopProgress(stop(2, 'DELIVERY', { status: 'In Transit', checkedInAt: iso(T0) }));
    expect(p.phase).toBe('arrived');
    expect(p.label).toBe('At stop');
    expect(p.supported).toBe(true);
  });

  it('detour and canceled stops are not counted', () => {
    expect(deriveStopProgress(stop(2.01, 'DETOUR')).counted).toBe(false);
    const c = deriveStopProgress(stop(3, 'DELIVERY', { status: 'Canceled', checkedInAt: iso(T0) }));
    expect(c.counted).toBe(false);
    expect(c.phase).toBe('canceled');
  });
});

describe('deriveLoadProgress — the 121536139 case', () => {
  // Driver tapped stops 1 and 2; stops 3 and 4 were closed by the fence;
  // the load row was never completed. Web said 50% / In transit, the stop
  // table said Delivered ×4, the Schedule said Completed.
  const stops = [
    stop(1, 'PICKUP', { status: 'Completed', checkedInAt: iso(T0 + 48 * MIN), checkedOutAt: iso(T0 + 56 * MIN) }),
    stop(2, 'DELIVERY', { status: 'Completed', checkedInAt: iso(T0 + 62 * MIN), checkedOutAt: iso(T0 + 70 * MIN) }),
    stop(3, 'DELIVERY', { status: 'Completed', autoArrivedAt: T0 + 100 * MIN, autoDepartedAt: T0 + 108 * MIN }),
    stop(4, 'DELIVERY', { status: 'Completed', autoArrivedAt: T0 + 150 * MIN, autoDepartedAt: T0 + 158 * MIN }),
  ];

  it('derives delivered from the stops while flagging the recorded row and the evidence', () => {
    const p = deriveLoadProgress(assigned, stops);
    expect(p.status).toBe('delivered');
    expect(p.recordedStatus).toBe('Assigned');
    expect(p.percent).toBe(100);
    expect(p.stopsClosed).toBe(4);
    expect(p.allStopsClosed).toBe(true);
    expect(p.evidence).toBe('mixed');
    expect(p.evidenceLabel).toBe('2 of 4 stops confirmed by driver taps');
    expect(p.closedBy).toEqual({ manual: 2, manual_late_sync: 0, manual_late_tap: 0, gps: 2, reported: 0 });
    expect(p.lastEvent).toMatchObject({ sequenceNumber: 4, kind: 'departure' });
    expect(p.lastEvent?.event.source).toBe('gps');
  });

  it('reports the same percent for every client — closed stops over counted stops', () => {
    const p = deriveLoadProgress(assigned, stops.slice(0, 2).concat(stop(3, 'DELIVERY'), stop(4, 'DELIVERY')));
    expect(p.status).toBe('in_transit');
    expect(p.percent).toBe(50);
    expect(p.stopsArrived).toBe(2);
    expect(p.evidence).toBe('manual');
    expect(p.lastEvent).toMatchObject({ sequenceNumber: 2, kind: 'departure' });
  });
});

describe('deriveLoadProgress — status rules', () => {
  it('Open stays open regardless of stops', () => {
    expect(deriveLoadProgress({ status: 'Open', trackingStatus: 'Pending' }, [stop(1, 'PICKUP')]).status).toBe('open');
  });

  it('Assigned with no activity is assigned; Delayed tracking reads as delayed', () => {
    const a = deriveLoadProgress({ status: 'Assigned', trackingStatus: 'Pending' }, [stop(1, 'PICKUP'), stop(2, 'DELIVERY')]);
    expect(a.status).toBe('assigned');
    expect(a.label).toBe('Assigned · pickup pending');
    const d = deriveLoadProgress({ status: 'Assigned', trackingStatus: 'Delayed' }, [stop(1, 'PICKUP'), stop(2, 'DELIVERY')]);
    expect(d.status).toBe('in_transit');
    expect(d.delayed).toBe(true);
  });

  it('Assigned + In Transit tracking with no stop activity is in transit', () => {
    const p = deriveLoadProgress(assigned, [stop(1, 'PICKUP'), stop(2, 'DELIVERY')]);
    expect(p.status).toBe('in_transit');
    expect(p.percent).toBe(0);
    expect(p.evidence).toBe('none');
  });

  it('Completed row is delivered with its completion source', () => {
    const p = deriveLoadProgress(
      { status: 'Completed', trackingStatus: 'Completed', completionSource: 'geofence' },
      [stop(1, 'PICKUP', { status: 'Completed', autoArrivedAt: T0, autoDepartedAt: T0 + MIN })],
    );
    expect(p.status).toBe('delivered');
    expect(p.completionSource).toBe('geofence');
    expect(p.evidence).toBe('gps');
  });

  it('Canceled and Expired rows win over stop evidence', () => {
    const closed = [stop(1, 'PICKUP', { status: 'Completed', checkedInAt: iso(T0), checkedOutAt: iso(T0 + MIN) })];
    expect(deriveLoadProgress({ status: 'Canceled', trackingStatus: 'Canceled' }, closed).status).toBe('canceled');
    expect(deriveLoadProgress({ status: 'Expired', trackingStatus: 'Canceled' }, closed).status).toBe('expired');
  });

  it('a load whose only counted stops are canceled never reports allStopsClosed', () => {
    const p = deriveLoadProgress(assigned, [stop(1, 'PICKUP', { status: 'Canceled' })]);
    expect(p.stopsTotal).toBe(0);
    expect(p.allStopsClosed).toBe(false);
    expect(p.percent).toBe(0);
  });

  it('returns stops sorted by sequence even when given out of order', () => {
    const p = deriveLoadProgress(assigned, [stop(2, 'DELIVERY'), stop(1, 'PICKUP')]);
    expect(p.stops.map((s) => s.sequenceNumber)).toEqual([1, 2]);
  });
});
