/**
 * Display formatting shared across dispatch screens.
 *
 * FourKites-imported loads carry an "FK-" prefix on `internalId`
 * (e.g. "FK-109589035"); operations reads the bare number. Stripping is
 * DISPLAY-ONLY — queries, mutations, and voice matching still key on the
 * full stored id (voice ref-matching is suffix-based, so a spoken bare
 * number already hits the prefixed id).
 */
export const displayLoadId = (id?: string | null): string =>
  id ? id.replace(/^fk[-_]?/i, '') : '—';
