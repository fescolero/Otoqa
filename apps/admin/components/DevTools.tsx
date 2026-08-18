'use client';

import { useEffect } from 'react';

/**
 * React Grab — point at any element in the console and copy its component and
 * source location for an agent to act on.
 *
 * Hover an element, press ⌘C / Ctrl+C, and the clipboard gets something like:
 *
 *   [<span class="chip chip-warn">paid 50d late</span> in InvoiceRow
 *    (at components/InvoicesBoard.tsx:341:11)]
 *
 * which is the whole point: "this chip is wrong" stops being a screenshot and
 * a hunt, and becomes a paste.
 *
 * WHERE IT RUNS — local dev, and PREVIEW deployments. Not production.
 *
 * Preview is included because that is where a design change is actually
 * reviewed, and its audience is the same as a laptop's: preview URLs sit
 * behind Vercel Authentication. React Grab reads the DOM and the React tree
 * and writes to the operator's own clipboard; it transmits nothing, so a
 * preview pointing at the shared Convex deployment is not an exfiltration
 * path.
 *
 * Production is excluded on a different argument, and the argument is ⌘C.
 * Staff copy org ids, invoice numbers and bank references out of this console
 * constantly during support work; an overlay that owns the copy key would
 * break its most-used interaction. That cost is worth paying on a preview
 * you opened to look at a layout, and not on the console someone is working
 * an account in.
 *
 * The flag is resolved in next.config.ts and inlined as a literal, so a
 * production build ELIMINATES this import rather than merely not taking it.
 * Reading NEXT_PUBLIC_VERCEL_ENV here directly does not work: Next only
 * inlines a NEXT_PUBLIC_ var that is set, so a build without Vercel's system
 * variables would leave the comparison as a runtime lookup and ship the whole
 * library. `grep -r "react-grab\|bippy" .next/static` after a production
 * build must return nothing; that grep is the regression check.
 *
 * Imported from node_modules rather than the CDN <script> the package README
 * suggests: this console does not load executable third-party code, and the
 * rule that made the fonts self-hosted applies harder to a script with full
 * DOM access.
 */
const ENABLED = process.env.NEXT_PUBLIC_ENABLE_GRAB === '1';

export function DevTools() {
  useEffect(() => {
    if (!ENABLED) return;
    void import('react-grab');
  }, []);

  return null;
}
