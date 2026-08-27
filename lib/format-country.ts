/**
 * Country-code normalization.
 *
 * Two sources write this column and they disagree. Google Places
 * returns a long name ("United States", "Canada") because
 * `lib/googlePlaces.ts` reads `long_name` for country — unlike
 * `state`, which it reads as `short_name`. Hand-typed values are
 * whatever the user entered; the fuel-vendor rows in dev are mostly
 * 'USA' against a field whose hint asks for a two-letter code.
 *
 * Normalizing on seed means a row converges to the canonical code the
 * next time someone edits and saves it, without a migration.
 *
 * Only the North American set this app operates in is mapped. Anything
 * unrecognized passes through unchanged rather than being guessed at
 * or blanked — losing a country is worse than storing an odd one.
 */
const COUNTRY_CODES: Record<string, string> = {
  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  us: 'US',
  canada: 'CA',
  ca: 'CA',
  mexico: 'MX',
  'méxico': 'MX',
  mx: 'MX',
};

export function toCountryCode(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  return COUNTRY_CODES[trimmed.toLowerCase()] ?? trimmed;
}

/** Reverse of `toCountryCode`, for the long form. */
const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States',
  CA: 'Canada',
  MX: 'Mexico',
};

/**
 * The spelled-out country, for postal address blocks.
 *
 * Invoices and address panels print this line, and a bare "US" reads
 * wrong there. Storage is the two-letter code, so the display side
 * needs the inverse.
 *
 * Tolerant on purpose: a row still holding the long name from before
 * the code was canonical passes through unchanged, so callers do not
 * have to know which encoding a given row has.
 */
export function countryDisplayName(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  return COUNTRY_NAMES[toCountryCode(trimmed)] ?? trimmed;
}
