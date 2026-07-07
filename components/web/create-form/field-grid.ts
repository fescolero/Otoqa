/**
 * Field grid — Layout Rule 3.
 *
 * `auto-fill, not auto-fit` is the load-bearing detail: empty tracks
 * are PRESERVED so a 2-field section shows 2 normal-width inputs +
 * trailing empty space, instead of stretching those 2 inputs across
 * the whole row. Inputs never change size section-to-section.
 *
 * Composite kinds (`address`, `stops-list`) span `1 / -1` so they
 * occupy the full width regardless of how many tracks the column has;
 * `span: 2` fields occupy two tracks. Single-track fields are the default.
 */

import type * as React from 'react';

/** Track minimum (px) — matches the design's "232px field width". */
export const FIELD_TRACK_MIN_PX = 232;

/** Gap between fields inside a card. */
export const FIELD_GAP_PX = 14;

/** Style block applied to the `<div>` wrapping a section's field set. */
export const fieldGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fill, minmax(${FIELD_TRACK_MIN_PX}px, 1fr))`,
  gap: FIELD_GAP_PX,
};

/**
 * Single-section schema → cap the grid at 3 columns so a lone card
 * doesn't read as a spreadsheet wall. (Spec §Degenerate case.)
 */
export const fieldGridStyleCapped: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fill, minmax(${FIELD_TRACK_MIN_PX}px, 1fr))`,
  maxWidth: `${FIELD_TRACK_MIN_PX * 3 + FIELD_GAP_PX * 2}px`,
  gap: FIELD_GAP_PX,
};
