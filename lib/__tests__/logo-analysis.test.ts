import { describe, expect, it } from 'vitest';
import { classifyLogoPixels } from '../logo-analysis';

/** Build an RGBA array from [count, [r,g,b,a]] groups. */
function pixels(...groups: Array<[number, [number, number, number, number]]>): number[] {
  const out: number[] = [];
  for (const [count, rgba] of groups) {
    for (let i = 0; i < count; i++) out.push(...rgba);
  }
  return out;
}

describe('classifyLogoPixels', () => {
  it('classifies black line-art on transparency as dark + hasAlpha', () => {
    const data = pixels([60, [0, 0, 0, 0]], [40, [10, 10, 10, 255]]);
    expect(classifyLogoPixels(data)).toEqual({ tone: 'dark', hasAlpha: true });
  });

  it('classifies white marks on transparency as light + hasAlpha', () => {
    const data = pixels([60, [0, 0, 0, 0]], [40, [245, 245, 245, 255]]);
    expect(classifyLogoPixels(data)).toEqual({ tone: 'light', hasAlpha: true });
  });

  it('classifies saturated logos as colorful regardless of luminance', () => {
    const data = pixels([50, [0, 0, 0, 0]], [50, [220, 30, 40, 255]]);
    expect(classifyLogoPixels(data)).toEqual({ tone: 'colorful', hasAlpha: true });
  });

  it('reports no alpha for logos that ship their own opaque background', () => {
    const data = pixels([90, [255, 255, 255, 255]], [10, [0, 0, 0, 255]]);
    expect(classifyLogoPixels(data)).toEqual({ tone: 'light', hasAlpha: false });
  });

  it('lets solid pixels vote, not anti-aliased edges', () => {
    const data = pixels(
      [50, [0, 0, 0, 0]],
      [15, [128, 128, 128, 120]], // soft edge — ignored
      [35, [0, 0, 0, 255]],
    );
    expect(classifyLogoPixels(data)).toEqual({ tone: 'dark', hasAlpha: true });
  });

  it('returns null when nothing is visible', () => {
    expect(classifyLogoPixels(pixels([100, [0, 0, 0, 0]]))).toBeNull();
    expect(classifyLogoPixels([])).toBeNull();
  });
});
