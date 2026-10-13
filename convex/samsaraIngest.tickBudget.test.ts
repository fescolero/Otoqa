import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_PAGE_BUDGET_MS,
  SAMSARA_FETCH_TIMEOUT_MS,
  pageFetchTimeoutMs,
} from './samsaraIngest';
import { fetchVehicleStatsFeed } from './samsaraApiClient';

/**
 * The samsara-gps-poll cron fires every 10s and Convex skips the next run
 * when a tick overruns. These cover the two guards that keep a tick inside
 * its interval: the drain-loop budget and the per-request fetch timeout.
 */

describe('pageFetchTimeoutMs', () => {
  const now = 1_000_000;

  it('caps a single request at SAMSARA_FETCH_TIMEOUT_MS when budget is plentiful', () => {
    expect(pageFetchTimeoutMs(now + 7_000, now)).toBe(SAMSARA_FETCH_TIMEOUT_MS);
  });

  it('shrinks the timeout to the remaining budget near the deadline', () => {
    expect(pageFetchTimeoutMs(now + 2_500, now)).toBe(2_500);
  });

  it('allows a request with exactly the minimum budget left', () => {
    expect(pageFetchTimeoutMs(now + MIN_PAGE_BUDGET_MS, now)).toBe(MIN_PAGE_BUDGET_MS);
  });

  it('stops the drain when less than the minimum budget is left', () => {
    expect(pageFetchTimeoutMs(now + MIN_PAGE_BUDGET_MS - 1, now)).toBeNull();
  });

  it('stops the drain once the deadline has passed', () => {
    expect(pageFetchTimeoutMs(now - 500, now)).toBeNull();
  });
});

describe('fetchVehicleStatsFeed timeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aborts a hung request and reports it as transient_error', async () => {
    // A fetch that never resolves on its own — only the abort signal ends it.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
      ),
    );

    const result = await fetchVehicleStatsFeed({
      apiToken: 'token',
      environment: 'production',
      timeoutMs: 20,
    });

    expect(result.kind).toBe('transient_error');
  });

  it('passes no abort signal when no timeout is given', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [], pagination: { endCursor: 'c', hasNextPage: false } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchVehicleStatsFeed({ apiToken: 'token', environment: 'production' });

    expect(result.kind).toBe('ok');
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeUndefined();
  });
});
