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
 * DEVELOPMENT ONLY, for two reasons that both matter:
 *
 *  1. It binds ⌘C. Staff copy org ids, invoice numbers and bank references out
 *     of this console constantly, and a selection overlay that intercepts the
 *     copy key would break the console's most-used interaction.
 *  2. It walks the React tree and reads source paths. That is fine on a laptop
 *     and wrong to ship to a page rendering customer billing data.
 *
 * The condition is statically false in a production build, so the import is
 * eliminated rather than merely skipped — verified by grepping the built
 * chunks (see README-design.md).
 *
 * Imported from node_modules rather than the CDN <script> the README suggests:
 * this console does not load executable third-party code, and the same rule
 * that made the fonts self-hosted applies harder to a script with DOM access.
 */
export function DevTools() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void import('react-grab');
  }, []);

  return null;
}
