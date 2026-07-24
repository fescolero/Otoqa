import { describe, it, expect } from 'vitest';
import {
  matchStopToFacility,
  matchStopToFacilityByAddress,
  resolveFacilityForStop,
  laneBindingsByPosition,
} from './facilityMatch';

// ~111 km per degree of latitude: 0.005° ≈ 556 m, 0.1° ≈ 11.1 km.
const YREKA = { _id: 'fac_yreka', city: 'Yreka', state: 'CA', latitude: 41.7354, longitude: -122.6345 };
const WEED = { _id: 'fac_weed', city: 'Weed', state: 'CA', latitude: 41.4226, longitude: -122.3861 };

describe('matchStopToFacility (proximity)', () => {
  it('matches the nearest facility within range', () => {
    const match = matchStopToFacility(
      { city: 'Yreka', latitude: 41.7404, longitude: -122.6345 }, // ~556m from YREKA
      [YREKA, WEED],
    );
    expect(match?.facility._id).toBe('fac_yreka');
    expect(match!.distanceMeters).toBeGreaterThan(400);
    expect(match!.distanceMeters).toBeLessThan(700);
  });

  it('abstains beyond the max distance', () => {
    const match = matchStopToFacility(
      { latitude: 43.0, longitude: -122.6345 }, // ~140km north
      [YREKA],
    );
    expect(match).toBeNull();
  });

  it('abstains when two facilities are ambiguously close (margin rule)', () => {
    const annex = { ...YREKA, _id: 'fac_annex', latitude: 41.7454 }; // ~1.1km from YREKA
    const match = matchStopToFacility(
      { latitude: 41.7404, longitude: -122.6345 }, // ~556m from both
      [YREKA, annex],
    );
    expect(match).toBeNull();
  });

  it('vetoes a far match with a disagreeing city', () => {
    const stop = { city: 'Montague', latitude: 41.8354, longitude: -122.6345 }; // ~11.1km
    expect(matchStopToFacility(stop, [YREKA])).toBeNull();
    // Same distance, agreeing city → match survives.
    expect(matchStopToFacility({ ...stop, city: 'Yreka' }, [YREKA])?.facility._id).toBe('fac_yreka');
    // Missing city on the stop → no veto.
    expect(matchStopToFacility({ latitude: 41.8354, longitude: -122.6345 }, [YREKA])?.facility._id).toBe('fac_yreka');
  });

  it('returns null without coordinates or facilities', () => {
    expect(matchStopToFacility({ city: 'Yreka' }, [YREKA])).toBeNull();
    expect(matchStopToFacility({ latitude: 41.7, longitude: -122.6 }, [])).toBeNull();
  });
});

describe('matchStopToFacilityByAddress', () => {
  it('matches a unique city/state candidate', () => {
    expect(matchStopToFacilityByAddress({ city: 'yreka', state: 'ca' }, [YREKA, WEED])?._id).toBe('fac_yreka');
  });

  it('requires zip agreement when both sides have one', () => {
    const withZip = { ...YREKA, postalCode: '96097' };
    expect(matchStopToFacilityByAddress({ city: 'Yreka', state: 'CA', postalCode: '96097' }, [withZip])?._id).toBe('fac_yreka');
    expect(matchStopToFacilityByAddress({ city: 'Yreka', state: 'CA', postalCode: '99999' }, [withZip])).toBeNull();
  });

  it('abstains with two candidates in the same town', () => {
    const annex = { ...YREKA, _id: 'fac_annex' };
    expect(matchStopToFacilityByAddress({ city: 'Yreka', state: 'CA' }, [YREKA, annex])).toBeNull();
  });

  it('requires both city and state on the stop', () => {
    expect(matchStopToFacilityByAddress({ city: 'Yreka' }, [YREKA])).toBeNull();
    expect(matchStopToFacilityByAddress({ state: 'CA' }, [YREKA])).toBeNull();
  });
});

describe('resolveFacilityForStop', () => {
  it('uses proximity when the stop has coordinates', () => {
    expect(
      resolveFacilityForStop({ latitude: 41.7404, longitude: -122.6345 }, [YREKA, WEED])?._id,
    ).toBe('fac_yreka');
  });

  it('falls back to address agreement without coordinates', () => {
    expect(resolveFacilityForStop({ city: 'Weed', state: 'CA' }, [YREKA, WEED])?._id).toBe('fac_weed');
  });
});

describe('laneBindingsByPosition', () => {
  const laneStops = [
    { stopOrder: 1, city: 'Redding', facilityId: 'fac_a', nassCode: 'A123' },
    { stopOrder: 2, city: 'Weed', nassCode: 'B456' },
    { stopOrder: 3, city: 'Yreka' },
  ];
  const shipmentStops = [
    { sequence: 1, city: 'Redding' },
    { sequence: 2, city: 'Weed' },
    { sequence: 3, city: 'Yreka' },
  ];

  it('aligns facilityId and nassCode by position', () => {
    expect(laneBindingsByPosition(laneStops, shipmentStops)).toEqual([
      { facilityId: 'fac_a', nassCode: 'A123' },
      { nassCode: 'B456' },
      undefined,
    ]);
  });

  it('yields nothing on count mismatch', () => {
    expect(laneBindingsByPosition(laneStops, shipmentStops.slice(0, 2))).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('yields nothing on a per-position city disagreement', () => {
    const wrong = [shipmentStops[0], { sequence: 2, city: 'Dunsmuir' }, shipmentStops[2]];
    expect(laneBindingsByPosition(laneStops, wrong)).toEqual([undefined, undefined, undefined]);
  });

  it('respects stopOrder and sequence over array order', () => {
    const shuffledLane = [laneStops[2], laneStops[0], laneStops[1]];
    const shuffledShipment = [shipmentStops[1], shipmentStops[2], shipmentStops[0]];
    expect(laneBindingsByPosition(shuffledLane, shuffledShipment)).toEqual([
      { nassCode: 'B456' },
      undefined,
      { facilityId: 'fac_a', nassCode: 'A123' },
    ]);
  });
});
