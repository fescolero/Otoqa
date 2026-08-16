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

const convexOrigins = () => {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return [];
  try {
    const { origin, host } = new URL(url);
    return [origin, `wss://${host}`];
  } catch {
    return [];
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
