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
