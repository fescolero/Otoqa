/**
 * Round-trip guards for the fuel-vendor schema's edit mode.
 *
 * The failure this protects against is silent: a mapper key that
 * doesn't match a `fuelVendors.update` arg name doesn't fail to
 * compile — the value just never reaches Convex, or the mutation
 * rejects the whole payload at runtime and the user sees a generic
 * "please try again". Asserting the record → vals → args round-trip
 * catches the drift at build time instead.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFuelVendorSchema,
  mapRecordToFuelVendorVals,
  mapValsToFuelVendorArgs,
  mapValsToFuelVendorUpdateArgs,
  type FuelVendorRecord,
} from '../fuel-vendor';

const FULL_RECORD: FuelVendorRecord = {
  name: 'Loves Travel Stops',
  code: 'LV',
  accountNumber: '000123456',
  discountProgram: 'COMDATA',
  contactName: 'Dana Reyes',
  contactEmail: 'support@loves.example',
  contactPhone: '(555) 555-0123',
  addressLine: '1200 W Memorial Rd',
  city: 'Oklahoma City',
  state: 'OK',
  zip: '73114',
  country: 'US',
  notes: 'Discount applies after 50 gal.',
};

describe('fuel-vendor edit mode', () => {
  it('round-trips every persisted column through vals and back', () => {
    const vals = mapRecordToFuelVendorVals(FULL_RECORD);
    expect(mapValsToFuelVendorUpdateArgs(vals)).toEqual(FULL_RECORD);
  });

  it('maps absent optional columns to undefined, not empty strings', () => {
    const vals = mapRecordToFuelVendorVals({ name: 'Bare Vendor' });
    const args = mapValsToFuelVendorUpdateArgs(vals);

    expect(args.name).toBe('Bare Vendor');
    for (const key of ['code', 'accountNumber', 'contactEmail', 'notes'] as const) {
      expect(args[key]).toBeUndefined();
    }
  });

  it('leaves country unset on update instead of backfilling US', () => {
    // The create translator stamps 'US' as a default. Applying that on
    // update would write a country onto every edited row that never
    // had one.
    const vals = mapRecordToFuelVendorVals({ name: 'Bare Vendor' });
    expect(mapValsToFuelVendorArgs(vals).country).toBe('US');
    expect(mapValsToFuelVendorUpdateArgs(vals).country).toBeUndefined();
  });

  it('keeps a non-US country through an edit', () => {
    const vals = mapRecordToFuelVendorVals({ name: 'Petro-Canada', country: 'CA' });
    expect(mapValsToFuelVendorUpdateArgs(vals).country).toBe('CA');
  });

  it('offers a stored discount program that predates the option list', () => {
    // The legacy hand-rolled edit form wrote this field as free text.
    const schema = buildFuelVendorSchema({
      mode: 'edit',
      currentDiscountProgram: 'PILOT_LEGACY',
    });
    const field = schema.sections
      .flatMap((s) => s.fields ?? [])
      .find((f) => f.id === 'discountProgram');

    expect(field?.options?.map((o) => o.value)).toContain('PILOT_LEGACY');
  });

  it('does not duplicate a discount program already in the list', () => {
    const schema = buildFuelVendorSchema({
      mode: 'edit',
      currentDiscountProgram: 'WEX',
    });
    const field = schema.sections
      .flatMap((s) => s.fields ?? [])
      .find((f) => f.id === 'discountProgram');

    const wex = (field?.options ?? []).filter((o) => o.value === 'WEX');
    expect(wex).toHaveLength(1);
  });

  it('titles the two modes differently but keeps one field layout', () => {
    const create = buildFuelVendorSchema();
    const edit = buildFuelVendorSchema({ mode: 'edit' });

    expect(create.title).not.toBe(edit.title);
    expect(edit.sections.flatMap((s) => (s.fields ?? []).map((f) => f.id))).toEqual(
      create.sections.flatMap((s) => (s.fields ?? []).map((f) => f.id)),
    );
  });
});
