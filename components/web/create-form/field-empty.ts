/**
 * `isFieldEmpty` — single source of truth for "does this field count
 * as missing?"
 *
 * Three places in the shell ask this question and they must agree:
 *
 *   - `useFormState.validate()` — drives the Save button's blocking
 *     errors.
 *   - `<StickySaveBar>` — drives the "N required fields remain"
 *     status text.
 *   - `<TocSidebar>` — drives the green/check / accent-ring /
 *     hairline-ring section dots.
 *
 * If two callers disagree, the rail can show a section as "complete"
 * (green) while the save bar still says "1 required field remains".
 * Keep them aligned by routing all three through this helper.
 *
 * Composite kinds need special handling:
 *
 *   - `kind: 'address'` — the composite's value lives under five
 *     sibling field ids (`field.ids.street/suite/city/state/zip`),
 *     not under `vals[field.id]`. We inspect the four mandatory
 *     sub-fields (suite is optional).
 *
 *   - `kind: 'stops-list'` — `vals[field.id]` is an array of stop
 *     objects; an empty array counts as missing.
 */

import type { FormField } from './schema-types';

export function isFieldEmpty(
  field: FormField,
  vals: Record<string, unknown>,
): boolean {
  if (field.kind === 'address' && field.ids) {
    return (
      isBlank(vals[field.ids.street]) ||
      isBlank(vals[field.ids.city]) ||
      isBlank(vals[field.ids.state]) ||
      isBlank(vals[field.ids.zip])
    );
  }
  const v = vals[field.id];
  if (Array.isArray(v)) return v.length === 0;
  return isBlank(v);
}

function isBlank(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    (typeof v === 'string' && v.trim() === '')
  );
}
