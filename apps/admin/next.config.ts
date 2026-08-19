import type { NextConfig } from 'next';

/**
 * Console hardening (plan §8-8). The console holds cross-org data and every
 * destructive lever we have, so it gets a stricter header set than the tenant
 * app — and it is never framed, never indexed, and never a referer.
 *
 * CSP notes:
 *   - 'unsafe-inline'/'unsafe-eval' in script-src are required by Next's dev
 *     overlay and its inlined bootstrap; they're kept out of production.
 *   - connect-src must allow the Convex deployment (https + wss for the
 *     reactive socket) and the WorkOS API the AuthKit client talks to.
 *   - No external images, fonts, or scripts are used by this app, so those
 *     stay locked to 'self'.
 */
const isDev = process.env.NODE_ENV === 'development';

/**
 * React Grab (components/DevTools.tsx) runs on local dev and PREVIEW
 * deployments, never production.
 *
 * The flag is resolved HERE, and inlined as a literal into every build,
 * because reading `process.env.NEXT_PUBLIC_VERCEL_ENV` from the client bundle
 * is not safe for this: Next only inlines a NEXT_PUBLIC_ var that is actually
 * SET, so on any build where Vercel's system variables are absent — a local
 * `next build`, or a project with "expose system environment variables" turned
 * off — the comparison stays a runtime lookup, nothing folds, and ~300KB of
 * tree-walking overlay ships to production with nothing to announce it.
 *
 * Deciding it in the config makes the value a literal in all three cases, so
 * the dead branch is eliminated rather than merely not taken.
 */
const enableGrab = isDev || process.env.VERCEL_ENV === 'preview';

/**
 * The Convex origin is only known at BUILD time. On production builds the
 * Convex CLI injects NEXT_PUBLIC_CONVEX_URL (see vercel.json), but a preview
 * or a local build without it must not end up with a CSP that silently blocks
 * the console's own backend — a broken console is worse than a broad
 * connect-src. So: pin exactly when we know the origin, fall back to
 * https/wss when we don't.
 */
const convexOrigins = () => {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return ['https:', 'wss:'];
  try {
    const { origin, host } = new URL(url);
    return [origin, `wss://${host}`];
  } catch {
    return ['https:', 'wss:'];
  }
};

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' https://api.workos.com ${convexOrigins().join(' ')}`.trim(),
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
]
  .filter(Boolean)
  .join('; ');

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_ENABLE_GRAB: enableGrab ? '1' : '0' },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Internal tool: never indexed, anywhere.
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // No org ids or invoice numbers leaking through a Referer header.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
