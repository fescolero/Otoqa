import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSeededRevision } from './use-seeded-revision';

/**
 * The optimistic-concurrency latch behind `expectedUpdatedAt` on the diesel
 * edit forms. Both directions matter and both have been wrong in production:
 * too loose and the staleness guard never fires, too tight and it rejects
 * saves that were never stale.
 */
describe('useSeededRevision', () => {
  it('returns undefined until the record loads', () => {
    const { result } = renderHook(() => useSeededRevision(undefined));
    expect(result.current).toBeUndefined();
  });

  it('latches the revision the form was seeded from', () => {
    const { result } = renderHook(() =>
      useSeededRevision({ _id: 'vendor_a', updatedAt: 100 }),
    );
    expect(result.current).toBe(100);
  });

  it('seeds on the render the record first arrives, not on mount', () => {
    const { result, rerender } = renderHook(
      ({ record }) => useSeededRevision(record),
      { initialProps: { record: undefined as { _id: string; updatedAt: number } | undefined } },
    );
    expect(result.current).toBeUndefined();

    rerender({ record: { _id: 'vendor_a', updatedAt: 100 } });
    expect(result.current).toBe(100);
  });

  it('keeps the seeded revision when the same row changes underneath', () => {
    // The guard's whole purpose. `useAuthQuery` is reactive, so a concurrent
    // writer bumps `updatedAt` mid-edit; the hook must keep reporting what
    // the user was shown so the server can refuse the overwrite.
    const { result, rerender } = renderHook(
      ({ record }) => useSeededRevision(record),
      { initialProps: { record: { _id: 'vendor_a', updatedAt: 100 } } },
    );
    expect(result.current).toBe(100);

    rerender({ record: { _id: 'vendor_a', updatedAt: 250 } });
    expect(result.current).toBe(100);
  });

  it('re-seeds when a different record loads into the same component', () => {
    // The regression. Next.js reuses the edit page component across
    // /vendors/a/edit -> /vendors/b/edit, so a once-only latch would still
    // report vendor A's revision and get B's save rejected as stale.
    const { result, rerender } = renderHook(
      ({ record }) => useSeededRevision(record),
      { initialProps: { record: { _id: 'vendor_a', updatedAt: 100 } } },
    );
    expect(result.current).toBe(100);

    rerender({ record: { _id: 'vendor_b', updatedAt: 900 } });
    expect(result.current).toBe(900);
  });

  it('holds the latch across a re-render that drops the record', () => {
    // Navigating away re-resolves the query to undefined for a frame. The
    // latch must not be cleared and then re-seeded from a newer revision.
    const { result, rerender } = renderHook(
      ({ record }) => useSeededRevision(record),
      {
        initialProps: {
          record: { _id: 'vendor_a', updatedAt: 100 } as
            | { _id: string; updatedAt: number }
            | undefined,
        },
      },
    );
    expect(result.current).toBe(100);

    rerender({ record: undefined });
    expect(result.current).toBe(100);

    rerender({ record: { _id: 'vendor_a', updatedAt: 400 } });
    expect(result.current).toBe(100);
  });
});
