/**
 * Shared R2 key utilities usable from both the default Convex runtime
 * (loadDocuments mutations) and 'use node' actions (s3Upload).
 */

/**
 * Derive the R2 object key from a legacy public-URL row. Works for both
 * pub-{account}.r2.dev and custom-domain URLs — the key is the pathname.
 * Returns null (never throws) for malformed or pathless URLs so callers
 * degrade gracefully: deletion skips the object, downloads return no URL.
 */
export function keyFromExternalUrl(externalUrl: string): string | null {
  try {
    return decodeURIComponent(new URL(externalUrl).pathname.slice(1)) || null;
  } catch {
    return null;
  }
}
