/**
 * Tests for the pure replay engine behind the geofence backfill tool.
 * The replay must mirror the live evaluator's semantics (rings, exit
 * candidate/confirm debounce, accuracy gate, armedAt guard) — these tests
 * pin that parity on synthetic ping trails.
 */
import { describe, it, expect } from 'vitest';
import { replayLoadEvents, type ReplayEvent } from '../geofenceBackfill';
import type { Id } from '../../_generated/dataModel';

const DRIVER = 'driver1' as Id<'drivers'>;
const SESSION = 'session1' as Id<'driverSessions'>;

const KM = 1 / 111.32; // ~1 km in degrees latitude
const STOP1 = { lat: 40, lng: -75 };
const STOP2 = { lat: 40 + 50 * KM, lng: -75 }; // ~50 km north

const stops = (over: Partial<Parameters<typeof replayLoadEvents>[0][number]>[] = []) => [
  {
    sequenceNumber: 1,
    stopType: 'PICKUP' as const,
    latitude: STOP1.lat,
    longitude: STOP1.lng,
    checkedInAt: 1_000,
    ...over[0],
  },
  {
    sequenceNumber: 2,
    stopType: 'DELIVERY' as const,
    latitude: STOP2.lat,
    longitude: STOP2.lng,
    checkedInAt: 100_000,
    ...over[1],
  },
];

const ping = (latOffsetKm: number, recordedAt: number, accuracy?: number) => ({
  latitude: STOP1.lat + latOffsetKm * KM,
  longitude: STOP1.lng,
  recordedAt,
  accuracy,
  sessionId: SESSION,
  driverId: DRIVER,
});

const types = (events: ReplayEvent[]) =>
  events.map((e) => `${e.eventType}@${e.stopSequenceNumber}`);

describe('replayLoadEvents', () => {
  it('replays a full two-stop run: departure from 1, approach+arrival at 2, departure from 2', () => {
    const trail = [
      ping(0, 2_000), // at stop 1, checked in
      ping(2, 10_000), // 2 km out — exit candidate for stop 1
      ping(5, 20_000), // still out — DEPARTED stop 1 confirmed (t=10000)
      ping(43, 30_000), // 7 km from stop 2 — APPROACHING stop 2
      ping(49.8, 40_000), // ~200 m from stop 2 — ARRIVED stop 2
      // check-in at stop 2 happens at t=100000
      ping(52, 110_000), // 2 km past stop 2 — exit candidate
      ping(55, 120_000), // DEPARTED stop 2 confirmed (t=110000)
    ];
    const events = replayLoadEvents(stops(), trail);
    expect(types(events)).toEqual([
      'DEPARTED@1',
      'APPROACHING@2',
      'ARRIVED@2',
      'DEPARTED@2',
    ]);
    expect(events[0].triggeredAt).toBe(10_000); // candidate ping, not confirming ping
    // Position parity with the live evaluator: the DEPARTED event carries
    // the candidate fix (~2 km out), not the confirming ping (~5 km out).
    expect(events[0].latitude).toBeCloseTo(STOP1.lat + 2 * KM, 6);
    expect(events[0].distanceMeters).toBeGreaterThan(1900);
    expect(events[0].distanceMeters).toBeLessThan(2100);
    expect(events[3].triggeredAt).toBe(110_000);
  });

  it('honors a per-stop facility radius override for arrival and exit', () => {
    // 300 m facility on stop 2: 500 m out must not count as arrived; the
    // stop-1 default rings stay unchanged.
    const overridden = stops([{}, { arrivalRadiusMeters: 300 }]);
    const nearMiss = [
      ping(2, 10_000),
      ping(5, 20_000), // DEPARTED@1 (default exit ring)
      ping(49.55, 30_000), // ~450 m from stop 2 — inside 804 m, outside 300 m
    ];
    const events = replayLoadEvents(overridden, nearMiss);
    expect(types(events)).toContain('DEPARTED@1');
    expect(types(events)).not.toContain('ARRIVED@2');

    const closeEnough = replayLoadEvents(overridden, [...nearMiss, ping(49.8, 40_000)]); // ~200 m
    expect(types(closeEnough)).toContain('ARRIVED@2');
  });

  it('produces nothing when the load was never checked in', () => {
    const events = replayLoadEvents(
      stops([{ checkedInAt: undefined }, { checkedInAt: undefined }]),
      [ping(0, 2_000), ping(10, 10_000)],
    );
    expect(events).toEqual([]);
  });

  it('ignores pings recorded at/before the check-in that armed the watch', () => {
    const trail = [
      ping(10, 500), // pre-check-in en-route ping, far outside — must not count
      ping(12, 900), // second pre-check-in outside ping — must not confirm
      ping(0, 2_000), // at the stop after check-in
    ];
    const events = replayLoadEvents(stops(), trail);
    expect(types(events)).not.toContain('DEPARTED@1');
  });

  it('resets the exit candidate when a newer ping comes back inside', () => {
    const trail = [
      ping(2, 10_000), // out — candidate
      ping(0.5, 20_000), // back inside — reset
      ping(2, 30_000), // out again — new candidate, never confirmed
    ];
    const events = replayLoadEvents(stops(), trail);
    expect(types(events)).not.toContain('DEPARTED@1');
  });

  it('skips low-accuracy pings for exit decisions', () => {
    const trail = [
      ping(2, 10_000, 250), // outside but accuracy 250 m — ignored
      ping(2, 20_000, 250), // ignored again — no candidate, no confirm
    ];
    const events = replayLoadEvents(stops(), trail);
    expect(types(events)).not.toContain('DEPARTED@1');
  });

  it('never targets detour or canceled stops for arrivals', () => {
    const detourStops = [
      ...stops(),
      {
        sequenceNumber: 1.01,
        stopType: 'DETOUR' as const,
        latitude: STOP1.lat + 10 * KM,
        longitude: STOP1.lng,
        checkedInAt: undefined,
      },
    ];
    const trail = [ping(10, 10_000), ping(10.1, 20_000)]; // right on the detour
    const events = replayLoadEvents(detourStops, trail);
    expect(types(events).filter((t) => t.endsWith('@1.01'))).toEqual([]);
  });

  it('emits at most one event per (stop, type) even across re-check-ins', () => {
    const reCheckIn = [
      { ...stops()[0], checkedInAt: 1_000 },
      { ...stops()[0], sequenceNumber: 1, checkedInAt: 50_000 }, // same stop, later tap
      stops()[1],
    ];
    const trail = [
      ping(2, 10_000),
      ping(5, 20_000), // DEPARTED@1 fires
      ping(2, 60_000),
      ping(5, 70_000), // would fire again after the second check-in — deduped
    ];
    const events = replayLoadEvents(reCheckIn, trail);
    expect(types(events).filter((t) => t === 'DEPARTED@1')).toHaveLength(1);
  });
});
