import { describe, expect, it } from 'vitest';
import { formatHcrs, formatRoute, formatTrips, loadIdentity, runIdentity } from './run-identity';

describe('formatTrips', () => {
  it('collapses a contiguous block to a range', () => {
    // An 8-load HCR run is usually trips N..N+7; printing all eight wastes
    // the one line that has to tell it apart from the run below.
    expect(formatTrips(['211', '212', '213', '214'])).toBe('Trips 211–214');
  });

  it('sorts before ranging, since chaining order is by time not number', () => {
    expect(formatTrips(['213', '211', '214', '212'])).toBe('Trips 211–214');
  });

  it('lists and counts when the numbers skip', () => {
    expect(formatTrips(['211', '214', '219', '223'])).toBe('Trips 211, 214, 219 +1');
    expect(formatTrips(['211', '214'])).toBe('Trips 211, 214');
  });

  it('handles a single trip and none at all', () => {
    expect(formatTrips(['211'])).toBe('Trip 211');
    expect(formatTrips([])).toBeNull();
  });

  it('does not pretend non-numeric trips form a range', () => {
    expect(formatTrips(['A1', 'A2', 'A3'])).toBe('Trips A1, A2, A3');
  });
});

describe('formatHcrs', () => {
  it('names one contract and counts several', () => {
    expect(formatHcrs(['925L0'])).toBe('HCR 925L0');
    expect(formatHcrs(['925L0', '945L4'])).toBe('2 HCRs');
    expect(formatHcrs([])).toBeNull();
  });
});

describe('formatRoute', () => {
  it('reads a same-city run as a round trip', () => {
    expect(formatRoute({ from: 'West Sacramento', to: 'West Sacramento' })).toBe(
      'West Sacramento round trip',
    );
  });

  it('falls back gracefully when an endpoint is unknown', () => {
    expect(formatRoute({ from: 'Ontario', to: null })).toBe('Ontario → —');
    expect(formatRoute({})).toBe('Route unavailable');
  });
});

describe('runIdentity', () => {
  it('leads with the contract, qualified by its trips', () => {
    const id = runIdentity({
      hcrs: ['925L0'],
      trips: ['211', '212', '213'],
      from: 'Moreno Valley',
      to: 'Ontario',
    });
    expect(id.primary).toBe('HCR 925L0');
    expect(id.secondary).toBe('Trips 211–213');
    expect(id.fromContract).toBe(true);
  });

  it('shows the route under trips when there is no HCR', () => {
    const id = runIdentity({ trips: ['211'], from: 'Ontario', to: 'Moreno Valley' });
    expect(id.primary).toBe('Trip 211');
    expect(id.secondary).toBe('Ontario → Moreno Valley');
  });

  it('falls back to geography for work with no contract facets', () => {
    // Not every carrier runs HCR work; the route line still has to serve.
    const id = runIdentity({ from: 'Redding', to: 'Modesto' });
    expect(id.primary).toBe('Redding → Modesto');
    expect(id.secondary).toBeNull();
    expect(id.fromContract).toBe(false);
  });

  it('never renders the repeated-city noise the change exists to remove', () => {
    // The reported case: same two cities, eight loads, a "via" list that
    // repeated them four times over.
    const id = runIdentity({
      hcrs: ['925L0'],
      trips: ['211', '212', '213', '214', '215', '216', '217', '218'],
      from: 'Moreno Valley',
      to: 'Ontario',
      via: ['Ontario', 'Moreno Valley', 'Ontario', 'Moreno Valley'],
    });
    expect(id.primary).toBe('HCR 925L0');
    expect(id.secondary).toBe('Trips 211–218');
    expect(`${id.primary}${id.secondary}`).not.toContain('Ontario');
  });
});

describe('loadIdentity', () => {
  it('leads with the contract and trip, the way run cards do', () => {
    expect(loadIdentity({ hcr: '945L4', tripNumber: '27', internalId: 'FK-120065381' })).toBe(
      'HCR 945L4 · Trip 27',
    );
  });

  it('uses whichever facet exists', () => {
    expect(loadIdentity({ hcr: '945L4', internalId: '120065381' })).toBe('HCR 945L4');
    expect(loadIdentity({ tripNumber: '27', internalId: '120065381' })).toBe('Trip 27');
  });

  it('falls back to the load number — the only identity such a load has', () => {
    expect(loadIdentity({ internalId: 'FK-120065381' })).toBe('120065381');
    expect(loadIdentity({})).toBe('—');
  });

  it('strips the FK- import prefix, as the load-id display always has', () => {
    expect(loadIdentity({ internalId: 'FK-109589035' })).toBe('109589035');
  });
});
