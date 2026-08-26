/**
 * Tests for the device-side yard fence geometry (apps/driver/lib/
 * yard-fence-math.ts). The rings must agree with the server evaluator
 * (convex/yardGeofence.ts) — same defaults, same hysteresis band — or the
 * phone and the dispatcher timeline will disagree about where a driver is.
 */
import { describe, it, expect } from 'vitest';
import {
  distanceMeters,
  zoneFor,
  findEnclosingFence,
  type YardFence,
} from './yard-fence-math';

const KM = 1 / 111.32; // ~1 km in degrees latitude
const BASE = { lat: 34, lng: -117 };

function fence(overrides: Partial<YardFence> = {}): YardFence {
  return {
    id: 'yard_main',
    name: 'Main Yard',
    latitude: BASE.lat,
    longitude: BASE.lng,
    entryRadiusMeters: 250, // the server's YARD_DEFAULT_RADIUS_METERS
    exitRadiusMeters: 375, // 1.5x — EXIT_RADIUS_RATIO
    ...overrides,
  };
}

/** A point `km` north of the fence centre. */
function at(km: number) {
  return { latitude: BASE.lat + km * KM, longitude: BASE.lng };
}

describe('distanceMeters', () => {
  it('measures a known offset', () => {
    // 1 km north, by construction of KM.
    expect(distanceMeters(BASE.lat, BASE.lng, BASE.lat + KM, BASE.lng)).toBeCloseTo(1000, -1);
  });

  it('is zero at the same point', () => {
    expect(distanceMeters(BASE.lat, BASE.lng, BASE.lat, BASE.lng)).toBe(0);
  });
});

describe('zoneFor', () => {
  it('reports inside past the entry ring', () => {
    const p = at(0.1); // 100 m
    expect(zoneFor(fence(), p.latitude, p.longitude)).toBe('inside');
  });

  it('reports outside past the exit ring', () => {
    const p = at(0.5); // 500 m
    expect(zoneFor(fence(), p.latitude, p.longitude)).toBe('outside');
  });

  it('reports between inside the hysteresis band', () => {
    // 300 m — past the 250 m entry ring but not yet past the 375 m exit
    // ring. This is the band that stops a parked truck's GPS jitter from
    // flapping arrive/depart, so it must be its own answer, not a default
    // to one side.
    const p = at(0.3);
    expect(zoneFor(fence(), p.latitude, p.longitude)).toBe('between');
  });

  it('honors a per-yard radius override', () => {
    const wide = fence({ entryRadiusMeters: 1000, exitRadiusMeters: 1500 });
    expect(zoneFor(wide, at(0.8).latitude, at(0.8).longitude)).toBe('inside');
    expect(zoneFor(wide, at(1.2).latitude, at(1.2).longitude)).toBe('between');
    expect(zoneFor(wide, at(1.8).latitude, at(1.8).longitude)).toBe('outside');
  });
});

describe('findEnclosingFence', () => {
  it('finds the fence a point sits in', () => {
    const p = at(0.1);
    expect(findEnclosingFence([fence()], p.latitude, p.longitude)?.id).toBe('yard_main');
  });

  it('returns null from the hysteresis band — between is not inside', () => {
    const p = at(0.3);
    expect(findEnclosingFence([fence()], p.latitude, p.longitude)).toBeNull();
  });

  it('returns null when no fence contains the point', () => {
    const p = at(10);
    expect(findEnclosingFence([fence()], p.latitude, p.longitude)).toBeNull();
  });

  it('returns null for an org with no yards configured', () => {
    const p = at(0);
    expect(findEnclosingFence([], p.latitude, p.longitude)).toBeNull();
  });

  it('picks the nearest fence when two overlap, whatever the list order', () => {
    // Two big fences over the same ground; the point is 100 m from the
    // second one's centre and 900 m from the first's.
    const far = fence({ id: 'far', entryRadiusMeters: 2000, exitRadiusMeters: 3000 });
    const near = fence({
      id: 'near',
      latitude: BASE.lat + 1 * KM,
      entryRadiusMeters: 2000,
      exitRadiusMeters: 3000,
    });
    const p = at(0.9);
    expect(findEnclosingFence([far, near], p.latitude, p.longitude)?.id).toBe('near');
    expect(findEnclosingFence([near, far], p.latitude, p.longitude)?.id).toBe('near');
  });
});
