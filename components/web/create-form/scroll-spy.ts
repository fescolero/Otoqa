/**
 * Scroll-spy — pick the topmost visible `[data-form-section]` and set
 * it as the rail's active row.
 *
 * Implementation matches the spec's IntersectionObserver settings
 * exactly:
 *   rootMargin: '-15% 0px -60% 0px'
 *
 * This shrinks the intersection band to ~25% of the viewport height,
 * centered slightly above middle. Whichever section's anchor is highest
 * inside that band wins. The settings come from the reference impl;
 * deviating from them shifts which section "feels" active relative to
 * what the user is reading.
 */

import * as React from 'react';

/**
 * Attaches an IntersectionObserver to all elements matching
 * `[data-form-section]` inside `rootRef`, and calls `setActive` with
 * the topmost intersecting section's id.
 *
 * Re-runs when `sectionIds` changes shape (e.g. progressive disclosure
 * adds or removes a section).
 */
export function useScrollSpy(
  rootRef: React.RefObject<HTMLElement | null>,
  sectionIds: string[],
  setActive: (id: string) => void,
): void {
  const sectionIdsKey = sectionIds.join('|');

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = sectionIds
      .map((id) => root.querySelector<HTMLElement>(`[data-form-section="${id}"]`))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          );
        const topmost = visible[0];
        if (topmost) {
          const id = topmost.target.getAttribute('data-form-section');
          if (id) setActive(id);
        }
      },
      { root, rootMargin: '-15% 0px -60% 0px' },
    );

    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
    // sectionIdsKey is the dep — sectionIds itself would re-fire every
    // render even when the set hasn't changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionIdsKey, rootRef, setActive]);
}

/**
 * Smooth-scroll a section into view inside its create-form scroll
 * container. Called by the rail on click.
 *
 * We do NOT use `el.scrollIntoView()` here. That method walks up the
 * ancestor chain looking for the first element with scrollable
 * content — and on a tall create form, the AppShell's outer `<main>`
 * has `overflow: hidden` but is still programmatically scrollable
 * (the browser counts hidden-overflow as a candidate). scrollIntoView
 * scrolls the WRONG container, the inner column never moves, and the
 * user sees nothing happen. Manually computing the offset and writing
 * scrollTop on the create-form's own container side-steps the
 * ambiguity.
 */
export function scrollToSection(
  rootEl: HTMLElement | null,
  sectionId: string,
): void {
  if (!rootEl) return;
  const el = rootEl.querySelector<HTMLElement>(`[data-form-section="${sectionId}"]`);
  if (!el) return;
  scrollContainerToElement(rootEl, el, 0);
}

/**
 * Scroll a specific field into view inside its create-form scroll
 * container, then focus its first focusable descendant. Used by the
 * error-summary jump-pills + auto-jump on a failed save.
 *
 * Field lookup happens via `document.querySelector` since the caller
 * doesn't have a ref handy. We find the containing scroll element
 * (the nearest ancestor with `overflow-y: auto`) and scroll IT, again
 * to avoid the `scrollIntoView`-picks-wrong-ancestor pitfall.
 */
export function jumpToField(fieldId: string): void {
  const el = document.querySelector<HTMLElement>(`[data-field="${fieldId}"]`);
  if (!el) return;

  const scroller = findScrollContainer(el);
  if (scroller) {
    // `block: 'center'` — keep the failing field visually mid-column,
    // not pinned to the top — easier to read while reading the error.
    const offset = (scroller.clientHeight - el.offsetHeight) / 2;
    scrollContainerToElement(scroller, el, Math.max(offset, 24));
  }

  // Defer focus a tick so the scroll-animation kickoff doesn't get
  // interrupted by the browser scrolling-on-focus.
  setTimeout(() => {
    const focusable = el.querySelector<HTMLElement>(
      'input, select, textarea, button',
    );
    focusable?.focus({ preventScroll: true });
  }, 60);
}

/** Compute the scroll target so `el` aligns N pixels below the top of
 *  `container`, then jump to it.
 *
 *  We deliberately do NOT use `{behavior: 'smooth'}` here. Native
 *  smooth-scroll is silently aborted on this element in practice —
 *  the scroll-spy IntersectionObserver fires mid-animation, React
 *  re-renders, and the browser drops the rest of the animation. The
 *  observed result is a scroll that stops a few hundred pixels short.
 *  Setting `scrollTop` directly is instant + correct every time;
 *  visually it reads as "jumped to the section" which matches the
 *  rail's nav-button semantics.
 */
function scrollContainerToElement(
  container: HTMLElement,
  el: HTMLElement,
  topInset: number,
): void {
  // getBoundingClientRect gives viewport-relative positions; subtract
  // the container's own viewport position to translate to "container's
  // content space", then add the container's current scrollTop.
  const containerRect = container.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const targetRaw =
    container.scrollTop + (elRect.top - containerRect.top) - topInset;
  const maxScroll = container.scrollHeight - container.clientHeight;
  container.scrollTop = Math.max(0, Math.min(targetRaw, maxScroll));
}

/** Walk up from `el` to the nearest ancestor with `overflow-y` set to
 *  `auto` or `scroll`. Used by `jumpToField` to find the right scroll
 *  container without making the caller pass a ref. */
function findScrollContainer(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const overflowY = getComputedStyle(cur).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return cur;
    cur = cur.parentElement;
  }
  return null;
}
