import { describe, it, expect } from 'vitest';
import { classifyRefToken } from './fourKitesApiClient';

describe('classifyRefToken', () => {
  describe('HCR shapes', () => {
    it.each([
      ['917DK', 'digits + 2 letters'],
      ['952L5', 'digits + letter + digit'],
      ['925L0', 'digits + letter + zero'],
      ['945L4', 'digits + letter + digit'],
      ['95236', '5 digits'],
      ['95632', '5 digits'],
      ['96036', '5 digits'],
      ['100ABC', 'digits + 3 letters'],
      ['1000A', 'digits + single letter'],
    ])('classifies %s as HCR (%s)', (token) => {
      expect(classifyRefToken(token)).toBe('HCR');
    });
  });

  describe('TRIP shapes', () => {
    it.each([
      ['108', '3-digit number'],
      ['1', 'single digit'],
      ['8', 'single digit'],
      ['205', '3-digit number'],
      ['9999', '4-digit number'],
      ['FOR2', '3 letters + 1 digit'],
      ['T01', 'letter + 2 digits'],
      ['AB123', '2 letters + 3 digits'],
      ['FMTXT', '5-letter pure-letter trip code'],
      ['ABCD', '4 letters'],
      ['ABCDEFGH', '8 letters'],
    ])('classifies %s as TRIP (%s)', (token) => {
      expect(classifyRefToken(token)).toBe('TRIP');
    });
  });

  describe('junk values', () => {
    it.each([
      ['MPG', '3-letter abbreviation'],
      ['AB', '2-letter abbreviation'],
      ['DIESEL', 'known junk word'],
      ['FUEL', 'known junk word'],
      ['GAS', '3-letter abbreviation'],
      ['BTF_DIESEL', 'contains underscore'],
      ['88.5', 'contains decimal point'],
      ['CarrierCode:000227710', 'contains colon'],
      ['', 'empty'],
      ['   ', 'whitespace only'],
      ['*', 'wildcard'],
    ])('rejects %s (%s)', (token, _description) => {
      expect(classifyRefToken(token)).toBeNull();
    });

    it('still classifies 6+ digit numbers as HCR (not junk)', () => {
      expect(classifyRefToken('100000')).toBe('HCR');
    });

    it('handles non-string input', () => {
      expect(classifyRefToken(undefined)).toBeNull();
      expect(classifyRefToken(null)).toBeNull();
      expect(classifyRefToken(123)).toBeNull();
      expect(classifyRefToken({})).toBeNull();
    });

    it('canonicalizes via uppercase before matching', () => {
      expect(classifyRefToken('917dk')).toBe('HCR');
      expect(classifyRefToken('for2')).toBe('TRIP');
      expect(classifyRefToken(' 952l5 ')).toBe('HCR');
    });
  });

  describe('the bad-load case from production', () => {
    // Real referenceNumbers from FK-107988291:
    // ["BTF_DIESEL", "MPG", "FOR2", "88.5", "95236", "CarrierCode:000227710"]
    // Old position-heuristic gave us hcr="MPG", trip="BTF_DIESEL" (wrong).
    // New classifier should pick hcr="95236", trip="FOR2".
    const refs = [
      'BTF_DIESEL',
      'MPG',
      'FOR2',
      '88.5',
      '95236',
      'CarrierCode:000227710',
    ];

    it('correctly identifies HCR=95236 and TRIP=FOR2', () => {
      const classifications = refs.map((r) => ({
        token: r,
        kind: classifyRefToken(r),
      }));
      const hcr = classifications.find((c) => c.kind === 'HCR')?.token;
      const trip = classifications.find((c) => c.kind === 'TRIP')?.token;
      expect(hcr).toBe('95236');
      expect(trip).toBe('FOR2');
    });

    it('rejects every junk token', () => {
      expect(classifyRefToken('BTF_DIESEL')).toBeNull();
      expect(classifyRefToken('MPG')).toBeNull();
      expect(classifyRefToken('88.5')).toBeNull();
      expect(classifyRefToken('CarrierCode:000227710')).toBeNull();
    });
  });

  describe('the typical-load case', () => {
    // Common shape: ["108", "917DK", "CarrierCode:..."]
    it('extracts hcr and trip in the simple case', () => {
      const refs = ['108', '917DK', 'CarrierCode:000227710'];
      const hcr = refs.find((r) => classifyRefToken(r) === 'HCR');
      const trip = refs.find((r) => classifyRefToken(r) === 'TRIP');
      expect(hcr).toBe('917DK');
      expect(trip).toBe('108');
    });

    it('still works when order is reversed (HCR before Trip)', () => {
      const refs = ['917DK', '108'];
      const hcr = refs.find((r) => classifyRefToken(r) === 'HCR');
      const trip = refs.find((r) => classifyRefToken(r) === 'TRIP');
      expect(hcr).toBe('917DK');
      expect(trip).toBe('108');
    });
  });
});
