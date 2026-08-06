import type { MetadataRoute } from 'next';

// Belt to the X-Robots-Tag suspenders in next.config.ts: nothing on the
// platform console is ever crawlable.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', disallow: '/' },
  };
}
