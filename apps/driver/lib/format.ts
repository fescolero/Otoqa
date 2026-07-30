/**
 * Display formatting for load identifiers.
 *
 * FourKites-imported loads carry an "FK-" prefix on `internalId`
 * (e.g. "FK-109589035"); operations reads the bare number. Stripping is
 * DISPLAY-ONLY — queries, mutations, and navigation params still use the
 * full stored id.
 */
export const displayLoadId = (id?: string | null): string =>
  id ? id.replace(/^fk[-_]?/i, '') : '—';
