import { describe, it, expect } from 'vitest';
import type { Id } from './_generated/dataModel';
import {
  buildStopRecord,
  buildStopSyncPatch,
  composeStopAddress,
  laneAddressesByPosition,
  type FourKitesStopShape,
} from './fourKitesUtils';

const LOAD_ID = 'load123' as Id<'loadInformation'>;

function record(stop: FourKitesStopShape, fallbackAddress?: string) {
  return buildStopRecord({
    workosOrgId: 'org_1',
    loadId: LOAD_ID,
    internalId: 'FK-1',
    stop,
    fallbackAddress,
  });
}

describe('composeStopAddress', () => {
  it('joins facility name and street', () => {
    expect(
      composeStopAddress({ stopName: 'Yreka Post Office', address: '401 S Broadway' }),
    ).toBe('Yreka Post Office, 401 S Broadway');
  });

  it('returns street alone when no name', () => {
    expect(composeStopAddress({ address: '401 S Broadway' })).toBe('401 S Broadway');
  });

  it('returns name alone when no street', () => {
    expect(composeStopAddress({ stopName: 'Yreka Post Office' })).toBe('Yreka Post Office');
  });

  it('falls back to the `name` field when stopName is absent', () => {
    expect(composeStopAddress({ name: 'Weed PO' })).toBe('Weed PO');
  });

  it('does not duplicate identical name and street', () => {
    expect(
      composeStopAddress({ stopName: '401 S Broadway', address: '401 s broadway' }),
    ).toBe('401 s broadway');
  });

  it('returns undefined when nothing usable is present', () => {
    expect(composeStopAddress({})).toBeUndefined();
    expect(composeStopAddress({ stopName: '  ', address: '' })).toBeUndefined();
  });
});

describe('buildStopRecord address', () => {
  it('uses FourKites address text when present', () => {
    expect(record({ address: '401 S Broadway', city: 'Yreka' }).address).toBe('401 S Broadway');
  });

  it('inherits the lane fallback when FK sent nothing', () => {
    expect(record({ city: 'Yreka' }, '401 S Broadway').address).toBe('401 S Broadway');
  });

  it('prefers FK text over the lane fallback', () => {
    expect(record({ address: 'FK St' }, 'Lane St').address).toBe('FK St');
  });

  it('defaults to empty string with neither', () => {
    expect(record({ city: 'Yreka' }).address).toBe('');
  });
});

describe('laneAddressesByPosition', () => {
  const laneStops = [
    { stopOrder: 1, address: '100 A St', city: 'Redding' },
    { stopOrder: 2, address: '200 B St', city: 'Weed' },
  ];
  const shipmentStops: FourKitesStopShape[] = [
    { sequence: 1, city: 'Redding' },
    { sequence: 2, city: 'Weed' },
  ];

  it('aligns lane addresses to shipment stops by position', () => {
    expect(laneAddressesByPosition(laneStops, shipmentStops)).toEqual(['100 A St', '200 B St']);
  });

  it('respects stopOrder over array order', () => {
    const shuffled = [laneStops[1], laneStops[0]];
    expect(laneAddressesByPosition(shuffled, shipmentStops)).toEqual(['100 A St', '200 B St']);
  });

  it('aligns by sequence when shipment stops arrive out of order', () => {
    const reversed = [shipmentStops[1], shipmentStops[0]];
    expect(laneAddressesByPosition(laneStops, reversed)).toEqual(['200 B St', '100 A St']);
  });

  it('inherits nothing when counts differ', () => {
    expect(laneAddressesByPosition(laneStops, [shipmentStops[0]])).toEqual([undefined]);
  });

  it('inherits nothing when any position city disagrees', () => {
    const wrongCity: FourKitesStopShape[] = [
      { sequence: 1, city: 'Redding' },
      { sequence: 2, city: 'Yreka' },
    ];
    expect(laneAddressesByPosition(laneStops, wrongCity)).toEqual([undefined, undefined]);
  });

  it('tolerates a missing city on one side (no veto without both)', () => {
    const noCity: FourKitesStopShape[] = [{ sequence: 1 }, { sequence: 2, city: 'weed' }];
    expect(laneAddressesByPosition(laneStops, noCity)).toEqual(['100 A St', '200 B St']);
  });

  it('handles non-array lane stops', () => {
    expect(laneAddressesByPosition(undefined, shipmentStops)).toEqual([undefined, undefined]);
  });
});

describe('buildStopSyncPatch', () => {
  const dbStop = {
    address: '',
    windowBeginTime: 'old-begin',
    windowEndTime: 'old-end',
    windowBeginDate: 'old-bdate',
    windowEndDate: 'old-edate',
  };

  it('never emits undefined coordinate/city/timezone keys for sparse payloads', () => {
    const patch = buildStopSyncPatch({}, dbStop);
    expect('latitude' in patch).toBe(false);
    expect('longitude' in patch).toBe(false);
    expect('city' in patch).toBe(false);
    expect('timeZone' in patch).toBe(false);
  });

  it('includes coordinates only when both are finite numbers', () => {
    expect('latitude' in buildStopSyncPatch({ latitude: 40.1 }, dbStop)).toBe(false);
    expect('latitude' in buildStopSyncPatch({ latitude: NaN, longitude: -122 }, dbStop)).toBe(
      false,
    );
    const patch = buildStopSyncPatch({ latitude: 40.1, longitude: -122.3 }, dbStop);
    expect(patch.latitude).toBe(40.1);
    expect(patch.longitude).toBe(-122.3);
  });

  it('updates city and timezone when present', () => {
    const patch = buildStopSyncPatch({ city: 'Weed', timeZone: 'America/Los_Angeles' }, dbStop);
    expect(patch.city).toBe('Weed');
    expect(patch.timeZone).toBe('America/Los_Angeles');
  });

  it('keeps existing window values when FK sends no appointment', () => {
    const patch = buildStopSyncPatch({}, dbStop);
    expect(patch.windowBeginTime).toBe('old-begin');
    expect(patch.windowEndTime).toBe('old-end');
    expect(patch.windowBeginDate).toBe('old-bdate');
    expect(patch.windowEndDate).toBe('old-edate');
  });

  it('updates window values from a new appointment', () => {
    const patch = buildStopSyncPatch(
      { schedule: { appointmentTime: '2026-07-25T03:45:00-07:00' } },
      dbStop,
    );
    expect(patch.windowBeginTime).toBe('2026-07-25T03:45:00-07:00');
    expect(patch.windowBeginDate).toBe('2026-07-25');
  });

  it('fills an empty address but never overwrites existing text', () => {
    expect(buildStopSyncPatch({ address: '401 S Broadway' }, dbStop).address).toBe(
      '401 S Broadway',
    );
    const withAddress = { ...dbStop, address: 'Dispatch-corrected St' };
    expect('address' in buildStopSyncPatch({ address: '401 S Broadway' }, withAddress)).toBe(
      false,
    );
  });

  it('never moves coordinates or city on a facility-linked stop', () => {
    const linked = { ...dbStop, facilityId: 'fac_1' };
    const patch = buildStopSyncPatch(
      { city: 'Elsewhere', latitude: 40.1, longitude: -122.3, timeZone: 'America/Los_Angeles' },
      linked,
    );
    expect('latitude' in patch).toBe(false);
    expect('longitude' in patch).toBe(false);
    expect('city' in patch).toBe(false);
    // Timezone is not facility-owned — still updates.
    expect(patch.timeZone).toBe('America/Los_Angeles');
  });
});
