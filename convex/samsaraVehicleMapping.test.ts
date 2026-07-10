import { describe, it, expect } from 'vitest';
import { matchByVin, normalizeVin } from './samsaraVehicleMapping';
import type { SamsaraVehicleSummary } from './samsaraApiClient';

/**
 * Pure-function unit tests for the VIN matcher. No Convex harness needed —
 * the action is just `runQuery → matchByVin → runMutation` and the
 * interesting logic lives entirely in matchByVin.
 */

const truck = (
  id: string,
  unitId: string,
  vin: string,
  samsaraVehicleId?: string,
) => ({ truckId: id, unitId, vin, samsaraVehicleId });

const samsara = (
  id: string,
  vehicleVin: string | undefined,
  name = `samsara-name-${id}`,
): SamsaraVehicleSummary => ({ id, name, vehicleVin });

describe('matchByVin', () => {
  it('matches 1:1 by VIN', () => {
    const r = matchByVin(
      [samsara('s-1', '1HGCM82633A123456'), samsara('s-2', '2T1BURHE0JC012345')],
      [truck('t-1', 'TR-1', '1HGCM82633A123456'), truck('t-2', 'TR-2', '2T1BURHE0JC012345')],
    );
    expect(r.matched).toHaveLength(2);
    expect(r.matched.find((m) => m.truckId === 't-1')?.samsaraVehicleId).toBe('s-1');
    expect(r.matched.find((m) => m.truckId === 't-2')?.samsaraVehicleId).toBe('s-2');
    expect(r.alreadyMapped).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(0);
    expect(r.unmatched).toHaveLength(0);
  });

  it('normalizes VIN case + whitespace before matching', () => {
    const r = matchByVin(
      [samsara('s-1', '  1hgcm82633a123456  ')],
      [truck('t-1', 'TR-1', '1HGCM82633A123456')],
    );
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].samsaraVehicleId).toBe('s-1');
  });

  it('matches across hidden / non-printable characters in real-world VIN data', () => {
    // NBSP (U+00A0), zero-width space (U+200B), BOM (U+FEFF), and a hyphen
    // separator — all common in pasted/imported VIN data. The hardened
    // normalizer strips everything that isn't alphanumeric.
    const r = matchByVin(
      [samsara('s-1', '1HG CM82633A​123456﻿')],
      [truck('t-1', 'TR-1', '1HG-CM82633A123456')],
    );
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].samsaraVehicleId).toBe('s-1');
  });

  it('matches lowercase on one side and uppercase on the other', () => {
    const r = matchByVin(
      [samsara('s-1', '1hgcm82633a123456')],
      [truck('t-1', 'TR-1', '1HGCM82633A123456')],
    );
    expect(r.matched).toHaveLength(1);
  });

  it('skips trucks that already have samsaraVehicleId set (idempotent)', () => {
    const r = matchByVin(
      [samsara('s-1', '1HGCM82633A123456')],
      [truck('t-1', 'TR-1', '1HGCM82633A123456', 's-OLD-EXISTING')],
    );
    expect(r.matched).toHaveLength(0);
    expect(r.alreadyMapped).toHaveLength(1);
    expect(r.alreadyMapped[0].samsaraVehicleId).toBe('s-OLD-EXISTING');
  });

  it('reports unmatched when no Samsara counterpart exists', () => {
    const r = matchByVin(
      [samsara('s-1', '1HGCM82633A123456')],
      [
        truck('t-1', 'TR-1', '1HGCM82633A123456'),
        truck('t-2', 'TR-2', 'NOTINSAMSARA00000'),
      ],
    );
    expect(r.matched).toHaveLength(1);
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0].truckId).toBe('t-2');
  });

  it('flags ambiguous when multiple Samsara vehicles share a VIN', () => {
    const r = matchByVin(
      [
        samsara('s-1', '1HGCM82633A123456'),
        samsara('s-2', '1HGCM82633A123456'), // duplicate Samsara-side
      ],
      [truck('t-1', 'TR-1', '1HGCM82633A123456')],
    );
    expect(r.matched).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].keyKind).toBe('VIN');
    expect(r.ambiguous[0].samsaraVehicleIds).toEqual(['s-1', 's-2']);
    expect(r.ambiguous[0].otoqaTruckIds).toEqual(['t-1']);
  });

  it('flags ambiguous when multiple Otoqa trucks share a VIN', () => {
    const r = matchByVin(
      [samsara('s-1', '1HGCM82633A123456')],
      [
        truck('t-1', 'TR-1', '1HGCM82633A123456'),
        truck('t-2', 'TR-2', '1HGCM82633A123456'), // duplicate Otoqa-side
      ],
    );
    expect(r.matched).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].keyKind).toBe('VIN');
    expect(r.ambiguous[0].otoqaTruckIds).toEqual(['t-1', 't-2']);
  });

  it('dedupes ambiguous bucket entries (one entry per key, not per truck)', () => {
    const r = matchByVin(
      [samsara('s-1', 'V1'), samsara('s-2', 'V1')],
      [truck('t-1', 'TR-1', 'V1'), truck('t-2', 'TR-2', 'V1')],
    );
    expect(r.ambiguous).toHaveLength(1);
    expect(r.matched).toHaveLength(0);
  });

  it('handles trucks with empty/missing VINs (treats as unmatched)', () => {
    const r = matchByVin(
      [samsara('s-1', '1HGCM82633A123456')],
      [truck('t-1', 'TR-1', ''), truck('t-2', 'TR-2', '   ')],
    );
    expect(r.matched).toHaveLength(0);
    expect(r.unmatched).toHaveLength(2);
  });

  it('ignores Samsara vehicles without VINs (they cannot match anything)', () => {
    const r = matchByVin(
      [samsara('s-1', undefined), samsara('s-2', '1HGCM82633A123456')],
      [truck('t-1', 'TR-1', '1HGCM82633A123456')],
    );
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].samsaraVehicleId).toBe('s-2');
  });

  describe('name fallback (samsara.name ↔ otoqa.unitId)', () => {
    it('falls back to name when Samsara has no VIN populated', () => {
      const r = matchByVin(
        [
          { id: 's-1', name: '1174', vehicleVin: undefined },
          { id: 's-2', name: '9193', vehicleVin: undefined },
        ],
        [
          truck('t-1', '1174', '3HAMMMML1JL711174'),
          truck('t-2', '9193', '3ALACWDT1EDFV9193'),
        ],
      );
      expect(r.matched).toHaveLength(2);
      expect(r.matched.every((m) => m.strategy === 'NAME')).toBe(true);
      expect(r.unmatched).toHaveLength(0);
    });

    it('prefers VIN over name when both apply', () => {
      // Same Samsara vehicle has both a matching VIN and a name that
      // matches a *different* truck's unitId. VIN wins; the other truck
      // is unmatched.
      const r = matchByVin(
        [{ id: 's-1', name: 'unit-B', vehicleVin: '1HGCM82633A123456' }],
        [
          truck('t-1', 'unit-A', '1HGCM82633A123456'),
          truck('t-2', 'unit-B', 'OTHER-VIN-NOTHING'),
        ],
      );
      const match = r.matched.find((m) => m.truckId === 't-1');
      expect(match?.strategy).toBe('VIN');
      expect(match?.samsaraVehicleId).toBe('s-1');
      // t-2 lost the race for s-1 (VIN won for t-1); s-1 is now consumed.
      // t-2 has no Samsara name match remaining → unmatched.
      expect(r.unmatched.map((u) => u.truckId)).toEqual(['t-2']);
    });

    it('mixed fleet: some trucks match by VIN, others by name', () => {
      const r = matchByVin(
        [
          { id: 's-1', name: '1174', vehicleVin: undefined }, // name-only
          { id: 's-2', name: 'arbitrary', vehicleVin: '1HGCM82633A123456' }, // vin-only
        ],
        [
          truck('t-1', '1174', '3HAMMMML1JL711174'),
          truck('t-2', 'TR-2', '1HGCM82633A123456'),
        ],
      );
      expect(r.matched).toHaveLength(2);
      expect(r.matched.find((m) => m.truckId === 't-1')?.strategy).toBe('NAME');
      expect(r.matched.find((m) => m.truckId === 't-2')?.strategy).toBe('VIN');
    });

    it('flags ambiguous when multiple Samsara names share an Otoqa unitId', () => {
      const r = matchByVin(
        [
          { id: 's-1', name: '1174', vehicleVin: undefined },
          { id: 's-2', name: '1174', vehicleVin: undefined },
        ],
        [truck('t-1', '1174', '3HAMMMML1JL711174')],
      );
      expect(r.matched).toHaveLength(0);
      expect(r.ambiguous).toHaveLength(1);
      expect(r.ambiguous[0].keyKind).toBe('NAME');
      expect(r.ambiguous[0].samsaraVehicleIds).toEqual(['s-1', 's-2']);
    });

    it('falls back to unmatched when neither VIN nor name produces a match', () => {
      const r = matchByVin(
        [{ id: 's-1', name: 'random-string', vehicleVin: undefined }],
        [truck('t-1', '1174', '3HAMMMML1JL711174')],
      );
      expect(r.matched).toHaveLength(0);
      expect(r.unmatched).toHaveLength(1);
    });
  });

  describe('normalizeVin', () => {
    it('handles a clean VIN as a no-op (uppercase)', () => {
      expect(normalizeVin('1HGCM82633A123456')).toBe('1HGCM82633A123456');
    });

    it('strips NBSP, ZWSP, BOM', () => {
      expect(normalizeVin('1HG CM82633A​123456﻿')).toBe(
        '1HGCM82633A123456',
      );
    });

    it('strips hyphens and standard whitespace', () => {
      expect(normalizeVin('  1HG-CM82633A 123456 ')).toBe('1HGCM82633A123456');
    });

    it('returns empty string for undefined / empty input', () => {
      expect(normalizeVin(undefined)).toBe('');
      expect(normalizeVin('')).toBe('');
      expect(normalizeVin('   ')).toBe('');
    });

    it('NFKC-normalizes full-width digits and letters', () => {
      // Full-width digits / Latin letters (U+FF10–FF19 / U+FF21–FF3A) fold
      // to their ASCII counterparts under NFKC.
      expect(normalizeVin('１ＨＧＣＭ82633a123456')).toBe('1HGCM82633A123456');
    });
  });

  it('mixed scenario: matched + alreadyMapped + ambiguous + unmatched', () => {
    const r = matchByVin(
      [
        samsara('s-1', 'VIN-CLEAN-MATCH'),
        samsara('s-2', 'VIN-DUP'),
        samsara('s-3', 'VIN-DUP'), // Samsara-side dup
        samsara('s-4', 'VIN-ALREADY'),
      ],
      [
        truck('t-1', 'TR-1', 'VIN-CLEAN-MATCH'),
        truck('t-2', 'TR-2', 'VIN-DUP'),
        truck('t-3', 'TR-3', 'VIN-ALREADY', 's-PREVIOUS'),
        truck('t-4', 'TR-4', 'VIN-NOWHERE'),
      ],
    );
    expect(r.matched.map((m) => m.truckId)).toEqual(['t-1']);
    expect(r.matched[0].strategy).toBe('VIN');
    expect(r.alreadyMapped.map((m) => m.truckId)).toEqual(['t-3']);
    // ambiguous bucket reports the *normalized* key (dashes stripped)
    // along with the kind of identifier that collided.
    expect(r.ambiguous.map((a) => ({ key: a.key, keyKind: a.keyKind }))).toEqual([
      { key: 'VINDUP', keyKind: 'VIN' },
    ]);
    expect(r.unmatched.map((u) => u.truckId)).toEqual(['t-4']);
  });
});
