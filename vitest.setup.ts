/**
 * Vitest setup for the `web` project (jsdom environment).
 *
 * - Loads @testing-library/jest-dom matchers (`toBeInTheDocument`, etc.)
 * - Stubs ResizeObserver / IntersectionObserver / matchMedia which Radix
 *   primitives, Recharts, and react-virtual all touch but jsdom doesn't
 *   provide.
 * - Stubs scrollTo so virtualizer side-effects don't throw.
 */

import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
  root = null;
  rootMargin = '';
  thresholds: number[] = [];
}

if (typeof window !== 'undefined') {
  window.ResizeObserver = window.ResizeObserver ?? MockResizeObserver;
  window.IntersectionObserver = window.IntersectionObserver ?? (MockIntersectionObserver as unknown as typeof IntersectionObserver);
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn() as unknown as Element['hasPointerCapture'];
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = vi.fn() as unknown as Element['releasePointerCapture'];
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView'];
  }
}
