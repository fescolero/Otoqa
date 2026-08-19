import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isRoadsSnappingDisabled,
  resetRoadsSnappingState,
  snapPathToRoadsIndexed,
} from './googleRoads';

const KEY = 'test-key';

/** A path of `n` points spaced ~111 m apart — well past the parked-truck floor. */
function path(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    latitude: 34.08 + i * 0.001,
    longitude: -117.26,
  }));
}

/** Echo the requested path back as snappedPoints, one per input point. */
function echoResponse(url: string) {
  const raw = new URL(url).searchParams.get('path')!;
  const pts = raw.split('|').map((pair) => {
    const [lat, lng] = pair.split(',').map(Number);
    return { latitude: lat, longitude: lng };
  });
  return {
    ok: true,
    json: async () => ({
      snappedPoints: pts.map((p, i) => ({
        location: p,
        originalIndex: i,
      })),
    }),
  };
}

function mockFetch(impl: (url: string) => unknown) {
  const spy = vi.fn(async (url: string) => impl(url) as Response);
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  resetRoadsSnappingState();
  vi.unstubAllGlobals();
});

describe('snapPathToRoadsIndexed', () => {
  it('tags every returned point with its input index', async () => {
    mockFetch(echoResponse);
    const out = await snapPathToRoadsIndexed(path(5), KEY);
    expect(out).not.toBeNull();
    expect(out!.map((p) => p.originalIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('rebases originalIndex across chunk boundaries', async () => {
    // 150 points => two calls (0..99, then 99..149 overlapping by one).
    const spy = mockFetch(echoResponse);
    const out = await snapPathToRoadsIndexed(path(150), KEY);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(out).not.toBeNull();
    // Indices must be continuous 0..149 with the overlap point emitted once.
    expect(out!.map((p) => p.originalIndex)).toEqual(
      Array.from({ length: 150 }, (_, i) => i),
    );
    // And the geometry must match the input, i.e. nothing shifted by one.
    expect(out![149].latitude).toBeCloseTo(path(150)[149].latitude, 6);
  });

  it('attributes interpolated points to the preceding real point', async () => {
    mockFetch((url) => {
      const raw = new URL(url).searchParams.get('path')!;
      const pts = raw.split('|').map((pair) => {
        const [lat, lng] = pair.split(',').map(Number);
        return { latitude: lat, longitude: lng };
      });
      return {
        ok: true,
        json: async () => ({
          snappedPoints: [
            { location: pts[0], originalIndex: 0 },
            // densified fill — no originalIndex, as the real API returns
            { location: { latitude: 34.0805, longitude: -117.26 } },
            { location: { latitude: 34.0807, longitude: -117.26 } },
            { location: pts[1], originalIndex: 1 },
          ],
        }),
      };
    });

    const out = await snapPathToRoadsIndexed(path(2), KEY);
    expect(out!.map((p) => p.originalIndex)).toEqual([0, 0, 0, 1]);
  });

  it('skips a parked path without spending a request', async () => {
    const spy = mockFetch(echoResponse);
    const parked = Array.from({ length: 300 }, () => ({
      latitude: 34.081198,
      longitude: -117.265745,
    }));

    expect(await snapPathToRoadsIndexed(parked, KEY)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('serves a repeated path from cache', async () => {
    const spy = mockFetch(echoResponse);
    await snapPathToRoadsIndexed(path(5), KEY);
    await snapPathToRoadsIndexed(path(5), KEY);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('trips the breaker after repeated failures and stops calling', async () => {
    const spy = mockFetch(() => ({ ok: false, status: 404 }));

    // Distinct paths so the cache can't mask the retries.
    for (let i = 0; i < 3; i++) {
      const p = path(3).map((q) => ({ ...q, longitude: q.longitude - i }));
      expect(await snapPathToRoadsIndexed(p, KEY)).toBeNull();
    }
    expect(spy).toHaveBeenCalledTimes(3);
    expect(isRoadsSnappingDisabled()).toBe(true);

    // Everything after the breaker trips must be free.
    const after = path(3).map((q) => ({ ...q, longitude: q.longitude - 9 }));
    expect(await snapPathToRoadsIndexed(after, KEY)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('resets the failure count after a success', async () => {
    let fail = true;
    const spy = mockFetch((url) =>
      fail ? { ok: false, status: 500 } : echoResponse(url),
    );

    await snapPathToRoadsIndexed(path(3), KEY);
    fail = false;
    await snapPathToRoadsIndexed(path(4), KEY);
    fail = true;
    await snapPathToRoadsIndexed(path(5), KEY);
    await snapPathToRoadsIndexed(path(6), KEY);

    // 2 failures, success, 2 more failures => never three in a row.
    expect(isRoadsSnappingDisabled()).toBe(false);
    expect(spy).toHaveBeenCalled();
  });

  it('returns null rather than echoing the input when there is no key', async () => {
    const spy = mockFetch(echoResponse);
    expect(await snapPathToRoadsIndexed(path(5), undefined)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
