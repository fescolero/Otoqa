import { describe, it, expect } from 'vitest';
import { toCountryCode, countryDisplayName } from '../format-country';

describe('country normalization', () => {
  it('folds the long names and variants onto the ISO code', () => {
    for (const raw of ['United States', 'united states', 'USA', 'us', ' US ']) {
      expect(toCountryCode(raw)).toBe('US');
    }
    expect(toCountryCode('Canada')).toBe('CA');
    expect(toCountryCode('México')).toBe('MX');
  });

  it('passes an unrecognized country through rather than guessing', () => {
    // Losing a country is worse than storing an odd one.
    expect(toCountryCode('Belgium')).toBe('Belgium');
  });

  it('treats blank and undefined as empty', () => {
    expect(toCountryCode(undefined)).toBe('');
    expect(toCountryCode('   ')).toBe('');
  });

  it('spells the code back out for address blocks', () => {
    // Invoices print this line; a bare "US" reads wrong there.
    expect(countryDisplayName('US')).toBe('United States');
    expect(countryDisplayName('CA')).toBe('Canada');
  });

  it('renders a row that still holds the long name identically', () => {
    // Storage is mixed until rows converge, so display must not care.
    expect(countryDisplayName('United States')).toBe('United States');
    expect(countryDisplayName('USA')).toBe('United States');
  });

  it('round-trips: normalize then display is stable', () => {
    for (const raw of ['United States', 'USA', 'US']) {
      expect(countryDisplayName(toCountryCode(raw))).toBe('United States');
    }
    expect(countryDisplayName(toCountryCode('Belgium'))).toBe('Belgium');
  });
});
