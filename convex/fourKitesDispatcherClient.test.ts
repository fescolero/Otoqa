import { describe, it, expect } from 'vitest';
import { buildLocationUpdate } from './fourKitesDispatcherClient';

/**
 * Pure unit tests for the FourKites Dispatcher Update payload builder.
 * The HTTP layer (postDispatcherUpdates) is exercised via integration
 * tests against the staging endpoint, not here — these only pin the
 * payload shape that goes over the wire.
 */

describe('buildLocationUpdate', () => {
  it('builds a single-update payload with BillOfLading identifier', () => {
    const update = buildLocationUpdate({
      externalLoadId: '664095554',
      rawIdentifier: 'FK-109624134',
      latitude: 40.578507,
      longitude: -122.336725,
      recordedAtMs: Date.parse('2026-05-18T18:49:34.069Z'),
    });

    expect(update.timeZone).toBe('UTC');
    expect(update.identifierKeys).toEqual([
      {
        identifier: '664095554',
        rawIdentifier: 'FK-109624134',
        identifierType: 'BillOfLading',
      },
    ]);
    expect(update.loadUpdate).toHaveLength(1);
    expect(update.loadUpdate?.[0].locationUpdate).toEqual({
      latitude: '40.578507',
      longitude: '-122.336725',
      // FourKites docs example uses no fractional seconds (YYYY-MM-DDTHH:MM:SSZ).
      locatedAt: '2026-05-18T18:49:34Z',
      city: undefined,
      state: undefined,
    });
  });

  it('strips fractional milliseconds from locatedAt', () => {
    const update = buildLocationUpdate({
      externalLoadId: '1',
      latitude: 0,
      longitude: 0,
      recordedAtMs: Date.parse('2026-05-18T12:34:56.789Z'),
    });
    expect(update.loadUpdate?.[0].locationUpdate?.locatedAt).toBe(
      '2026-05-18T12:34:56Z',
    );
  });

  it('formats coordinates as 6-decimal strings (per FourKites doc example)', () => {
    const update = buildLocationUpdate({
      externalLoadId: '1',
      latitude: 42.42,
      longitude: -87.622003,
      recordedAtMs: Date.parse('2026-05-18T12:00:00Z'),
    });
    expect(update.loadUpdate?.[0].locationUpdate?.latitude).toBe('42.420000');
    expect(update.loadUpdate?.[0].locationUpdate?.longitude).toBe('-87.622003');
  });

  it('allows identifierType override (for orgs that need Reference / BillingLoadID)', () => {
    const update = buildLocationUpdate({
      externalLoadId: '1',
      identifierType: 'BillingLoadID',
      latitude: 0,
      longitude: 0,
      recordedAtMs: Date.parse('2026-05-18T12:00:00Z'),
    });
    expect(update.identifierKeys[0].identifierType).toBe('BillingLoadID');
  });

  it('omits rawIdentifier when not provided', () => {
    const update = buildLocationUpdate({
      externalLoadId: '664095554',
      latitude: 0,
      longitude: 0,
      recordedAtMs: Date.parse('2026-05-18T12:00:00Z'),
    });
    expect(update.identifierKeys[0].rawIdentifier).toBeUndefined();
  });

  it('round-trips negative coordinates correctly', () => {
    const update = buildLocationUpdate({
      externalLoadId: '1',
      latitude: -33.8688,
      longitude: 151.2093,
      recordedAtMs: Date.parse('2026-05-18T12:00:00Z'),
    });
    expect(update.loadUpdate?.[0].locationUpdate?.latitude).toBe('-33.868800');
    expect(update.loadUpdate?.[0].locationUpdate?.longitude).toBe('151.209300');
  });
});
