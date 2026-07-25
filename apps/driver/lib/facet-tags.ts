/**
 * Shared facet-tag helpers.
 *
 * Every surface that renders load badges (dashboard cards, trip detail
 * summary, future search results) pulls from this module so they stay in
 * sync on:
 *   - which tokens show up (HCR / TRIP / equipment short codes / HAZ /
 *     TARP / custom per-org facets),
 *   - what colors those tokens map to,
 *   - and what the fallback path is when `facets[]` hasn't been backfilled
 *     yet for a given load.
 */
import { tagStyles, type Palette } from './design-tokens';

// A tag's `kind` drives its color. Values are display-ready; dedupe is
// on label so HCR+TRIP variants don't clash with derived equipment tags.
export type TagKind = 'hcr' | 'trip' | 'equipment' | 'haz' | 'tarp' | 'default';
export type FacetTag = { kind: TagKind; label: string };

/**
 * Build the tag list for a load's badges.
 *
 * Pulls from two sources:
 *
 *   1. The facet system (`facets` array from the server, or the legacy
 *      parsedHcr / parsedTripNumber pair if the response pre-dates the
 *      facet migration). TRIP values get a "Trip " prefix so the badge
 *      reads "Trip 12345" instead of a bare number.
 *
 *   2. Fields on the load document that classify it but aren't stored
 *      as loadTags: equipment type (REEF / FLAT / DRY / …), isHazmat
 *      (HAZ), requiresTarp (TARP). Without these, loads that never got
 *      HCR/TRIP tags written show up with no badges at all.
 *
 * Result is de-duped by label while preserving order.
 */
export function loadFacetTags(load: {
  facets?: Array<{ key: string; value: string }>;
  parsedHcr?: string;
  parsedTripNumber?: string;
  equipmentType?: string;
  isHazmat?: boolean;
  requiresTarp?: boolean;
}): FacetTag[] {
  const out: FacetTag[] = [];
  const seen = new Set<string>();
  const push = (t: FacetTag) => {
    if (!t.label || !t.label.trim() || seen.has(t.label)) return;
    seen.add(t.label);
    out.push(t);
  };

  if (load.facets && load.facets.length > 0) {
    for (const { key, value } of load.facets) {
      if (!value || !value.trim()) continue;
      if (key === 'TRIP') push({ kind: 'trip', label: `Trip ${value}` });
      else if (key === 'HCR') push({ kind: 'hcr', label: value });
      else push({ kind: 'default', label: value });
    }
  } else {
    if (load.parsedHcr) push({ kind: 'hcr', label: load.parsedHcr });
    if (load.parsedTripNumber) push({ kind: 'trip', label: `Trip ${load.parsedTripNumber}` });
  }

  const eq = equipmentShortCode(load.equipmentType);
  if (eq) push({ kind: 'equipment', label: eq });
  if (load.isHazmat) push({ kind: 'haz', label: 'HAZ' });
  if (load.requiresTarp) push({ kind: 'tarp', label: 'TARP' });

  return out;
}

/**
 * Shorten equipment types into the 3-4 char tokens the design's
 * TAG_STYLES palette is keyed on (REEF, DRY, FLAT, …). Unknown types
 * fall back to the uppercased source string so nothing is silently
 * dropped.
 */
export function equipmentShortCode(raw?: string): string | null {
  if (!raw) return null;
  const up = raw.trim().toUpperCase();
  if (!up) return null;
  if (up.includes('REEF')) return 'REEF';
  if (up.includes('FLAT')) return 'FLAT';
  if (up.includes('DRY')) return 'DRY';
  if (up.includes('STEP')) return 'STEP';
  if (up.includes('TANK')) return 'TANK';
  if (up.includes('CONEST')) return 'CONE';
  if (up.includes('LTL')) return 'LTL';
  if (up.includes('OVERSIZE') || up.includes('OVR')) return 'OVR';
  return up.slice(0, 6);
}

/**
 * Color tokens per tag kind. Pulled live on each render — important for
 * the theme switch to recolor the badges without reloading.
 */
export function tagKindStyles(
  kind: TagKind,
  value: string,
  palette: Palette,
): { bg: string; fg: string } {
  // Equipment tokens have first-class entries in design-tokens `tagStyles`
  // keyed by the short code (REEF, FLAT, DRY, LTL, OVR, …). Prefer those.
  if (kind === 'equipment') {
    return tagStyles[value] ?? {
      bg: 'rgba(107, 115, 133, 0.18)',
      fg: palette.textPrimary,
    };
  }
  if (kind === 'hcr') {
    return { bg: 'rgba(124, 58, 237, 0.18)', fg: '#C4B5FD' };
  }
  if (kind === 'trip') {
    return { bg: 'rgba(46, 92, 255, 0.18)', fg: '#A5B6FF' };
  }
  if (kind === 'haz') {
    return { bg: 'rgba(234, 88, 12, 0.18)', fg: '#FDBA74' };
  }
  if (kind === 'tarp') {
    return { bg: 'rgba(16, 185, 129, 0.18)', fg: '#6EE7B7' };
  }
  // Fallback for unknown custom facets — still readable, palette-aware.
  const lookup = tagStyles[value];
  if (lookup) return lookup;
  return { bg: palette.accentTint, fg: palette.accent };
}
