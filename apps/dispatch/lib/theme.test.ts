/**
 * Locks the dispatch palette to the v8 design bundle.
 *
 * The app spent its whole life on the legacy orange driver theme while the
 * approved design (and the driver app) were on v8 blue/neutral. These
 * assertions are deliberately literal — a hex here is the design's value,
 * not a preference — so any drift back toward the old palette fails loudly
 * instead of shipping.
 */
import { describe, expect, it } from 'vitest';
import { borderRadius, colors, darkColors, lightColors, typography } from './theme';

describe('dispatch theme — v8 palette', () => {
  it('accents in v8 blue, not the legacy orange', () => {
    expect(colors.primary).toBe('#2E5CFF');
    expect(colors.primary).not.toBe('#FF6B00');
  });

  it('uses the v8 neutral surfaces, not the legacy dark-logistics greys', () => {
    expect(colors.background).toBe('#0E1017'); // n950, was #1A1D21
    expect(colors.card).toBe('#171A22'); // n900, was #22262B
    expect(colors.border).toBe('#3B414F'); // was #3F4552
  });

  it('puts readable text on the accent (white, not the old near-black)', () => {
    expect(colors.primaryForeground).toBe('#FFFFFF');
    expect(colors.primaryForeground).not.toBe('#1A1D21');
  });

  it('separates the two muted-text roles the design distinguishes', () => {
    // foregroundMuted covers text-secondary; foregroundSubtle is the
    // tertiary role captions and section headers should migrate to.
    expect(colors.foregroundMuted).toBe('#B0B6C3');
    expect(colors.foregroundSubtle).toBe('#858B99');
    expect(colors.foregroundMuted).not.toBe(colors.foregroundSubtle);
  });

  it('defaults the static export to dark — module-scope styles depend on it', () => {
    expect(colors).toBe(darkColors);
  });

  it('ships a light palette that actually inverts', () => {
    expect(lightColors.background).toBe('#FFFFFF');
    expect(lightColors.foreground).toBe('#171A22');
    expect(lightColors.primary).toBe(darkColors.primary); // accent holds across schemes
  });

  it('maps every legacy color name the screens still import', () => {
    // Guards the swap: a missing key would be `undefined` at a call site and
    // render as an invisible/black element rather than throwing.
    for (const key of [
      'background',
      'card',
      'muted',
      'foreground',
      'foregroundMuted',
      'primary',
      'primaryForeground',
      'border',
      'success',
      'warning',
      'destructive',
    ] as const) {
      expect(colors[key], `colors.${key}`).toMatch(/^(#|rgba)/);
    }
  });
});

describe('dispatch theme — type ramp and radii', () => {
  it('snaps the legacy sizes onto the v8 scale', () => {
    expect(typography.xs).toBe(11); // was 10
    expect(typography.md).toBe(15); // was 16
    expect(typography.base).toBe(14); // already matched
    expect(typography.lg).toBe(18); // already matched
  });

  it('keeps the weight names the screens use', () => {
    expect(typography.medium).toBe('500');
    expect(typography.semibold).toBe('600');
    expect(typography.bold).toBe('700');
  });

  it('serves radii from the v8 set at the values screens expect', () => {
    expect(borderRadius.md).toBe(8);
    expect(borderRadius.lg).toBe(12);
    expect(borderRadius.full).toBe(9999);
  });
});
