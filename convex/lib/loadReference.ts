/**
 * The human-facing load number.
 *
 * `loadInformation` carries three identifiers and none of them is the
 * one to show a user on its own:
 *
 *   - `internalId`   — required, the dispatcher-facing number
 *                      ("96073365", or "FK-96073365" on FourKites
 *                      imports).
 *   - `orderNumber`  — optional, the customer's own order number.
 *   - `externalLoadId` — the source system's id; not user-facing.
 *
 * Rows written outside the load form can hold an empty `internalId`,
 * so the fallback deliberately uses `||` and not `??` — `??` only
 * catches null/undefined, and `internalId` is a required `v.string()`,
 * which makes an empty string the realistic degenerate value.
 *
 * Returns `undefined` when the load carries no usable number at all,
 * so callers can decide what to render rather than printing an empty
 * string.
 */
export function loadReferenceOf(
  load: { internalId?: string; orderNumber?: string } | null | undefined,
): string | undefined {
  if (!load) return undefined;
  return load.internalId || load.orderNumber || undefined;
}
