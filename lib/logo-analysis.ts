/**
 * Logo analysis — decides whether an uploaded logo needs a contrasting tile
 * background to stay visible (a black line-art mark on a transparent PNG is
 * invisible on a dark surface, and vice versa).
 *
 * Runs client-side on the raw upload (no CORS involved) and stores the
 * result as `organizations.logoTraits`; `OrgMark` reads it wherever the
 * logo renders. Analysis is best-effort — any failure (undecodable image,
 * SSR, canvas quirks) returns null and rendering falls back to the neutral
 * tile, never blocking the upload itself.
 *
 * Classification:
 *   - hasAlpha  — a meaningful share of fully transparent pixels. Logos
 *                 that ship their own opaque background never need help.
 *   - tone      — 'colorful' when enough visible pixels carry chroma;
 *                 otherwise 'dark' / 'light' by mean luminance. Only
 *                 monochrome transparent logos get a forced background.
 */

export interface LogoTraits {
  tone: 'dark' | 'light' | 'colorful';
  hasAlpha: boolean;
  analyzedAt: number;
}

/** Downsample target — 64×64 is plenty to classify a logo. */
const SAMPLE_SIZE = 64;

/**
 * Classify raw RGBA pixels. Pure and exported for tests.
 * Returns null when nothing is visible (e.g. an image that failed to draw).
 */
export function classifyLogoPixels(
  rgba: Uint8ClampedArray | number[],
): Omit<LogoTraits, 'analyzedAt'> | null {
  let visible = 0;
  let transparent = 0;
  let colorful = 0;
  let luminanceSum = 0;

  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a < 8) {
      transparent++;
      continue;
    }
    // Anti-aliased edge pixels blend toward the (absent) background and
    // would skew the tone — only solid pixels vote.
    if (a < 200) continue;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    visible++;
    luminanceSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 32) colorful++;
  }

  const total = Math.floor(rgba.length / 4);
  if (total === 0 || visible === 0) return null;

  const hasAlpha = transparent / total > 0.02;
  if (colorful / visible > 0.08) return { tone: 'colorful', hasAlpha };
  return { tone: luminanceSum / visible < 140 ? 'dark' : 'light', hasAlpha };
}

/**
 * Analyze an image blob (PNG, JPEG, SVG, …) by rasterizing it to a small
 * canvas and classifying the pixels.
 */
export async function analyzeLogoBlob(blob: Blob): Promise<LogoTraits | null> {
  if (typeof document === 'undefined') return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

    const data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
    const traits = classifyLogoPixels(data);
    return traits ? { ...traits, analyzedAt: Date.now() } : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
