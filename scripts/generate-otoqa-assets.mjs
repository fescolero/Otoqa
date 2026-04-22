// Generate Otoqa icon + splash assets from the canonical Orbit O mark.
//
// Source of truth: /tmp/otoqa-logo-design/otoqa-mobile/project/logo/
//   • logo-marks.jsx  — OrbitOSymbol / OrbitOLockup definitions
//   • logo-usage.jsx  — OrbitAdaptiveForeground (safe-zone scaled mark)
//                     + SplashContent (light/dark composition)
//
// We produce four PNGs, all rasterized from hand-authored SVG (no
// headless browser, no image tracing) so the output is crisp at any
// target density:
//
//   1. icon.png          — iOS app icon (1024×1024, opaque #2E5CFF bg)
//   2. adaptive-icon.png — Android foreground layer (1024×1024, transparent,
//                          mark centered in 66% safe zone; the "hole"
//                          punched by the traveling dot is filled with
//                          bg color, matching the Android composite)
//   3. splash.png        — Light splash content (1284×2778, transparent,
//                          Orbit O lockup + OTOQA CARRIER signature)
//   4. splash-dark.png   — Dark variant of the above
//
// Expo composites splash.png over app.json's backgroundColor, so these
// two PNGs only contain the mark; the background fill comes from config.
//
// Run:  node scripts/generate-otoqa-assets.mjs

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'mobile', 'assets');

// ─── Brand tokens (from logo-usage.jsx) ─────────────────────────────────
const BRAND = {
  // iOS icon + Android adaptive background fill
  accent: '#2E5CFF',
  accentDark: '#5C82FF',
  // Splash canvases
  bgLight: '#F7F8FC',
  bgDark: '#0B0D14',
  // Splash text colors
  textLight: '#171A22',
  textDark: '#E8EBF2',
  // Splash footer (OTOQA CARRIER signature)
  footerLight: '#9BA3B4',
  footerDark: '#6B7385',
};

// ─── Orbit O primitive ──────────────────────────────────────────────────
//
// The mark lives on a 100-unit viewBox. Dimensions taken verbatim from
// logo-marks.jsx::OrbitOSymbolOn so every surface (icon, adaptive,
// splash) shares the same proportions.
//
//   • Outer ring:    cx=50 cy=50 r=32, stroke 8
//   • Inner core:    cx=50 cy=50 r=12, solid fill
//   • Traveling dot: cx=76 cy=32
//       outer r=11 filled with surface color (the "hole" in the ring)
//       inner r=7  filled with mark color  (the dot sitting in the hole)
//
// markColor = color of the ring/core/dot (white for icon, varies for splash)
// surface   = color that fills the punched hole (blue for iOS icon and
//             Android adaptive foreground; canvas for splash)
function orbitOSvg(markColor, surface) {
  return `
    <g>
      <circle cx="50" cy="50" r="32" stroke="${markColor}" stroke-width="8" fill="none"/>
      <circle cx="50" cy="50" r="12" fill="${markColor}"/>
      <circle cx="76" cy="32" r="11" fill="${surface}"/>
      <circle cx="76" cy="32" r="7"  fill="${markColor}"/>
    </g>
  `;
}

// ─── 1. iOS app icon ────────────────────────────────────────────────────
// 1024×1024, opaque #2E5CFF, Orbit O scaled to 62% of canvas (matches
// the Android safe-zone rule so both platforms share the same mark size).
async function buildIosIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 108 108">
      <rect width="108" height="108" fill="${BRAND.accent}"/>
      <g transform="translate(54 54) scale(0.62) translate(-50 -50)">
        ${orbitOSvg('#FFFFFF', BRAND.accent)}
      </g>
    </svg>
  `;
  const out = join(OUT_DIR, 'icon.png');
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
  console.log(`✓ icon.png (iOS)         → ${out}`);
}

// ─── 2. Android adaptive icon foreground ────────────────────────────────
// 1024×1024, transparent, mark scaled to 62% (safe zone). The "hole"
// punched by the traveling dot is filled with the BLUE bg color so that
// when Android composites this foreground over the solid blue background
// layer, the dot reads correctly. See OrbitAdaptiveForeground in
// logo-usage.jsx — it uses fill="#2E5CFF" for the hole for the same
// reason.
async function buildAndroidAdaptive() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 108 108">
      <g transform="translate(54 54) scale(0.62) translate(-50 -50)">
        ${orbitOSvg('#FFFFFF', BRAND.accent)}
      </g>
    </svg>
  `;
  const out = join(OUT_DIR, 'adaptive-icon.png');
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
  console.log(`✓ adaptive-icon.png      → ${out}`);
}

// ─── 3/4. Splash screens (light + dark) ─────────────────────────────────
// 1284×2778 portrait (iPhone Pro Max native), transparent. Expo's
// `splash.resizeMode: contain` centers the image within device bounds
// and fills the remainder with `splash.backgroundColor` — so the PNG
// only needs the lockup + signature, not the canvas fill.
//
// Composition (from logo-usage.jsx::SplashContent):
//   • Hero: OrbitOLockup symbolSize=44, textSize=26, centered with a
//     -16% nudge toward optical center (above geometric center).
//   • Footer: "OTOQA CARRIER" uppercase, 9px, letter-spacing 0.8,
//     pinned 28px above the bottom.
//
// For PNG output we scale those design units to the 1284-wide canvas
// using the same proportional relationship a React Native renderer
// would (image width ≈ device width on contain mode).
async function buildSplash(variant) {
  const isDark = variant === 'dark';
  const canvas = isDark ? BRAND.bgDark : BRAND.bgLight;
  const accent = isDark ? BRAND.accentDark : BRAND.accent;
  const text = isDark ? BRAND.textDark : BRAND.textLight;
  const footer = isDark ? BRAND.footerDark : BRAND.footerLight;

  // Splash canvas dimensions. 1284 × 2778 is the target (iPhone 13 Pro
  // Max native). Expo's `contain` resizeMode centers this PNG and fills
  // the device with `backgroundColor`, so the PNG itself stays
  // transparent — only the mark and wordmark are baked in.
  const W = 1284;
  const H = 2778;

  // ─── Lockup geometry ────────────────────────────────────────────────
  //
  // Key insight: sharp's SVG rasterizer doesn't have Inter bundled, so
  // CSS `letter-spacing` and the font's own glyph metrics get replaced
  // by whatever fallback the renderer pulls in (usually something
  // wider). My first attempt computed `wordWidth` from an Inter-700
  // advance estimate and the wordmark overflowed the right edge on the
  // actual render.
  //
  // Robust fix: pin the wordmark to a fixed pixel width with
  // `textLength` + `lengthAdjust="spacingAndGlyphs"`. SVG renderers
  // scale glyphs AND spacing uniformly to hit the target width, so the
  // output is identical regardless of which font was substituted.
  const symbolPx = 220;          // mark diameter, ~17% of canvas width
  const wordWidth = 440;         // fixed target — equals 2× symbol diameter
  const wordHeight = 120;        // visual font-size; actual rendered
                                 // height tracks textLength scaling
  const gap = 75;                // ≈ symbolPx × 0.34 (design ratio)
  const lockupWidth = symbolPx + gap + wordWidth;

  // Optical center: the lockup sits slightly above the geometric middle
  // because the "OTOQA CARRIER" footer adds visual weight at the bottom.
  // SplashContent uses paddingBottom: 16% to achieve the same bias.
  const lockupX = (W - lockupWidth) / 2;
  const lockupY = H * 0.42 - symbolPx / 2;

  // Orbit O symbol: transform a 100-unit symbol into a symbolPx box,
  // positioned at the left of the lockup.
  const symbolScale = symbolPx / 100;

  // Wordmark baseline: the text anchor in SVG is the baseline, so we
  // position `y` at roughly 78% of the symbol height for optical
  // balance (cap-height of most sans-serifs sits at ~72–78% of font
  // size; we match that to the symbol's optical middle).
  const wordX = lockupX + symbolPx + gap;
  const wordY = lockupY + symbolPx * 0.72;

  // Footer signature pinned above the home indicator.
  const footerY = H - 140;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <!-- Orbit O symbol (color varies by light/dark) -->
      <g transform="translate(${lockupX} ${lockupY}) scale(${symbolScale})">
        ${orbitOSvg(accent, canvas)}
      </g>
      <!-- OTOQA wordmark. textLength + lengthAdjust pin the width to
           exactly ${wordWidth}px regardless of which font the
           renderer pulled in — this was the actual bug in v1. -->
      <text
        x="${wordX}"
        y="${wordY}"
        font-family="Inter, -apple-system, system-ui, sans-serif"
        font-weight="700"
        font-size="${wordHeight}"
        textLength="${wordWidth}"
        lengthAdjust="spacingAndGlyphs"
        fill="${text}"
      >OTOQA</text>
      <!-- OTOQA CARRIER signature. textLength also pinned so this
           line is always exactly one visual unit wide. -->
      <text
        x="${(W - 380) / 2}"
        y="${footerY}"
        font-family="Inter, -apple-system, system-ui, sans-serif"
        font-weight="600"
        font-size="34"
        textLength="380"
        lengthAdjust="spacingAndGlyphs"
        fill="${footer}"
      >OTOQA CARRIER</text>
    </svg>
  `;

  const out = join(OUT_DIR, variant === 'dark' ? 'splash-dark.png' : 'splash.png');
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
  console.log(`✓ splash${variant === 'dark' ? '-dark' : ''}.png        → ${out}`);
}

// ─── Entrypoint ─────────────────────────────────────────────────────────
await mkdir(OUT_DIR, { recursive: true });
await buildIosIcon();
await buildAndroidAdaptive();
await buildSplash('light');
await buildSplash('dark');
console.log('\nDone. Review in mobile/assets/ then commit.');
