/**
 * Guards for the fuel-entry schema's edit-mode translators.
 *
 * Both cases here are silent-corruption bugs: nothing throws, the save
 * reports success, and the damage only shows up on the next read.
 */

import { describe, it, expect } from 'vitest';
import {
  mapRecordToFuelEntryVals,
  mapValsToFuelEntryUpdateArgs,
  readLoadReference,
  FUEL_ENTRY_FIELD_IDS as IDS,
  type FuelEntryRecord,
} from '../fuel-entry';

/** 2026-03-11 09:20:00 local — a real capture time, not midnight. */
const CAPTURED_AT = new Date(2026, 2, 11, 9, 20, 0).getTime();

const RECORD: FuelEntryRecord = {
  entryDate: CAPTURED_AT,
  vendorId: 'vendor_1',
  gallons: 104.2,
  pricePerGallon: 3.919,
  loadId: 'load_1',
  loadReference: 'FK-96073365',
};

describe('fuel-entry edit mode', () => {
  it('keeps the original timestamp when the calendar day is untouched', () => {
    const vals = mapRecordToFuelEntryVals(RECORD);
    // The user edits something unrelated and saves.
    const args = mapValsToFuelEntryUpdateArgs(
      { ...vals, [IDS.receiptNumber]: 'R-4471' },
      RECORD,
    );

    // Without the `previous` anchor this collapses to local midnight,
    // silently moving entryDate and logging a phantom "changed the
    // date" audit row on a save that never touched it.
    expect(args.entryDate).toBe(CAPTURED_AT);
  });

  it('takes the new day when the user actually changes the date', () => {
    const vals = mapRecordToFuelEntryVals(RECORD);
    const args = mapValsToFuelEntryUpdateArgs(
      { ...vals, [IDS.date]: '2026-03-12' },
      RECORD,
    );

    expect(args.entryDate).not.toBe(CAPTURED_AT);
    expect(new Date(args.entryDate!).getDate()).toBe(12);
  });

  it('seeds the linked-load box with the human number, not the id', () => {
    const vals = mapRecordToFuelEntryVals(RECORD);
    expect(vals[IDS.loadId]).toBe('FK-96073365');
    expect(readLoadReference(vals)).toBe('FK-96073365');
  });

  it('reports a blanked linked-load box as "no reference"', () => {
    // The page turns this into an explicit `loadId: null` for the
    // mutation — `undefined` would be stripped from the args and read
    // server-side as "not submitted", leaving the old link in place.
    const vals = mapRecordToFuelEntryVals(RECORD);
    expect(readLoadReference({ ...vals, [IDS.loadId]: '' })).toBeUndefined();
  });
});
