/**
 * The contract these tests defend: `fetchConvexAccessToken` returns `null`
 * only when the user is genuinely signed out.
 *
 * Convex reads a `null` as "no identity" and responds by calling
 * `clearAuth()` and re-running every mounted subscription without a token,
 * so a `null` returned for a transient reason shows up in production as a
 * simultaneous burst of `ConvexError('Unauthenticated')` across every query
 * on the page.
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchConvexAccessToken } from './convex-access-token';

const noSleep = () => Promise.resolve();

describe('fetchConvexAccessToken', () => {
  it('returns null when nobody is signed in, without touching the token sources', async () => {
    const refresh = vi.fn();
    const getAccessToken = vi.fn();

    await expect(
      fetchConvexAccessToken({ hasUser: false, refresh, getAccessToken, sleep: noSleep }),
    ).resolves.toBeNull();

    expect(refresh).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('uses the cached token on a normal (non-forced) fetch', async () => {
    const refresh = vi.fn();
    const getAccessToken = vi.fn().mockResolvedValue('cached-token');

    await expect(
      fetchConvexAccessToken({ hasUser: true, refresh, getAccessToken, sleep: noSleep }),
    ).resolves.toBe('cached-token');

    expect(refresh).not.toHaveBeenCalled();
  });

  it('forces a refresh when Convex asks for one', async () => {
    const refresh = vi.fn().mockResolvedValue('fresh-token');
    const getAccessToken = vi.fn();

    await expect(
      fetchConvexAccessToken({
        hasUser: true,
        forceRefreshToken: true,
        refresh,
        getAccessToken,
        sleep: noSleep,
      }),
    ).resolves.toBe('fresh-token');

    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('retries a rejecting refresh and returns the token once it succeeds', async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue('fresh-token');
    const getAccessToken = vi.fn();

    await expect(
      fetchConvexAccessToken({
        hasUser: true,
        forceRefreshToken: true,
        refresh,
        getAccessToken,
        sleep: noSleep,
      }),
    ).resolves.toBe('fresh-token');

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  // The regression this whole change exists for.
  it('falls back to the still-valid cached token when every refresh fails', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('network'));
    // AuthKit keeps the previous token when a refresh throws, so this still
    // resolves as long as the token is outside the expiry buffer.
    const getAccessToken = vi.fn().mockResolvedValue('still-valid-cached-token');

    await expect(
      fetchConvexAccessToken({
        hasUser: true,
        forceRefreshToken: true,
        refresh,
        getAccessToken,
        sleep: noSleep,
      }),
    ).resolves.toBe('still-valid-cached-token');

    expect(refresh).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('treats a refresh that resolves undefined the same as one that throws', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const getAccessToken = vi.fn().mockResolvedValue('still-valid-cached-token');

    await expect(
      fetchConvexAccessToken({
        hasUser: true,
        forceRefreshToken: true,
        refresh,
        getAccessToken,
        sleep: noSleep,
      }),
    ).resolves.toBe('still-valid-cached-token');
  });

  it('returns null when the cached token is also unusable', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('network'));
    // Inside the expiry buffer, so AuthKit tries to renew and rethrows.
    const getAccessToken = vi.fn().mockRejectedValue(new Error('network'));

    await expect(
      fetchConvexAccessToken({
        hasUser: true,
        forceRefreshToken: true,
        refresh,
        getAccessToken,
        sleep: noSleep,
      }),
    ).resolves.toBeNull();
  });

  it('does not re-try the cached token on a non-forced fetch that already failed', async () => {
    const refresh = vi.fn();
    const getAccessToken = vi.fn().mockRejectedValue(new Error('network'));

    await expect(
      fetchConvexAccessToken({ hasUser: true, refresh, getAccessToken, sleep: noSleep }),
    ).resolves.toBeNull();

    // Four attempts through the retry loop and no extra fallback call.
    expect(getAccessToken).toHaveBeenCalledTimes(4);
  });

  it('backs off between attempts', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('network'));
    const getAccessToken = vi.fn().mockRejectedValue(new Error('network'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await fetchConvexAccessToken({
      hasUser: true,
      forceRefreshToken: true,
      refresh,
      getAccessToken,
      sleep,
    });

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 300]);
  });
});
