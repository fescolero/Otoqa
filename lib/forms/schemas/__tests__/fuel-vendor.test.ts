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
    // toStrictEqual, not toEqual: toEqual ignores keys whose value is
    // `undefined`, so it cannot tell "mapped correctly" from "dropped
    // on the floor" — the exact drift this file exists to catch.
    expect(mapValsToFuelVendorUpdateArgs(vals)).toStrictEqual(FULL_RECORD);
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

  it('emits undefined for an emptied field — which the wire then drops', () => {
    const vals = mapRecordToFuelVendorVals({ name: 'Petro-Canada', country: 'CA' });
    const args = mapValsToFuelVendorUpdateArgs({ ...vals, country: '' });

    // The translator's half of the contract.
    expect(args.country).toBeUndefined();

    // And the half that makes clearing impossible today: Convex strips
    // undefined-valued keys out of mutation args, so `country` never
    // reaches `ctx.db.patch` and the stored 'CA' survives the save.
    // Asserting on the serialized payload is the only way to see it —
    // `toBeUndefined` alone reads as "clearing works", which it does
    // not. Clearing an optional vendor column needs an explicit null
    // signal, the way `fuelEntries.update` handles `loadId`.
    expect(Object.keys(JSON.parse(JSON.stringify(args)))).not.toContain(
      'country',
    );
  });

  it('wires the country field into the address composite', () => {
    // Without this the autocomplete resolves a country and throws it
    // away, so picking a Toronto address still saves the vendor as US.
    const composite = fieldById(buildFuelVendorSchema(), 'addressComposite');
    expect(composite?.ids?.country).toBe('country');
  });

  it('does not render a suite input the vendor table cannot store', () => {
    // fuelVendors has no addressLine2 column; rendering the composite's
    // suite input would collect a value and silently drop it on save.
    const composite = fieldById(buildFuelVendorSchema(), 'addressComposite');
    expect(composite?.ids?.suite).toBeUndefined();
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
