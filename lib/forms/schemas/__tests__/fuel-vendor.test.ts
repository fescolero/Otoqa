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

function fieldById(schema: ReturnType<typeof buildFuelVendorSchema>, id: string) {
  return schema.sections.flatMap((s) => s.fields ?? []).find((f) => f.id === id);
}

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

  it("defaults country to 'US' on the field, not in the translator", () => {
    // A new vendor gets 'US' because the field seeds it. The translator
    // must NOT re-apply that default, or editing a row that never had a
    // country would silently backfill one.
    const field = fieldById(buildFuelVendorSchema(), 'country');
    expect(field?.default).toBe('US');

    const vals = mapRecordToFuelVendorVals({ name: 'Bare Vendor' });
    expect(mapValsToFuelVendorArgs(vals).country).toBeUndefined();
    expect(mapValsToFuelVendorUpdateArgs(vals).country).toBeUndefined();
  });

  it('clears country when the user empties the field', () => {
    const vals = mapRecordToFuelVendorVals({ name: 'Petro-Canada', country: 'CA' });
    expect(mapValsToFuelVendorUpdateArgs({ ...vals, country: '' }).country).toBeUndefined();
  });

  it('renders country inside the address section', () => {
    const section = buildFuelVendorSchema().sections.find((s) => s.id === 'address');
    expect((section?.fields ?? []).map((f) => f.id)).toContain('country');
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
    expect(
      fieldById(schema, 'discountProgram')?.options?.map((o) => o.value),
    ).toContain('PILOT_LEGACY');
  });

  it('does not duplicate a discount program already in the list', () => {
    const schema = buildFuelVendorSchema({
      mode: 'edit',
      currentDiscountProgram: 'WEX',
    });
    const opts = fieldById(schema, 'discountProgram')?.options ?? [];
    expect(opts.filter((o) => o.value === 'WEX')).toHaveLength(1);
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
