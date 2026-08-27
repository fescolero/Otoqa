/**
 * Tests for the driver-app release channel (convex/driverAppConfig.ts):
 * per-platform upsert semantics, input validation, and the public
 * projection the UpdateGate reads.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import { ConvexError } from 'convex/values';
import schema from './schema';
import { api, internal } from './_generated/api';

const ANDROID = {
  platform: 'android' as const,
  latestBuild: 18,
  minSupportedBuild: 18,
  installUrl: 'https://expo.dev/accounts/otoqa/builds/abc',
};

describe('driverAppConfig', () => {
  it('get returns null until a config is set', async () => {
    const t = convexTest(schema);
    expect(await t.query(api.driverAppConfig.get, { platform: 'android' })).toBeNull();
  });

  it('setConfig inserts, then replaces the same platform row', async () => {
    const t = convexTest(schema);
    await t.mutation(internal.driverAppConfig.setConfig, { ...ANDROID, message: 'Scan telemetry' });
    await t.mutation(internal.driverAppConfig.setConfig, {
      ...ANDROID,
      latestBuild: 19,
      minSupportedBuild: 18,
    });

    const config = await t.query(api.driverAppConfig.get, { platform: 'android' });
    expect(config).toEqual({
      latestBuild: 19,
      minSupportedBuild: 18,
      installUrl: ANDROID.installUrl,
      message: null, // replace, not patch — dropping the message clears it
    });

    // Still exactly one row (upsert, not append).
    await t.run(async (ctx) => {
      expect(await ctx.db.query('driverAppConfig').collect()).toHaveLength(1);
    });
  });

  it('platforms are independent rows', async () => {
    const t = convexTest(schema);
    await t.mutation(internal.driverAppConfig.setConfig, ANDROID);
    expect(await t.query(api.driverAppConfig.get, { platform: 'ios' })).toBeNull();
  });

  it('rejects a floor above the latest build and non-https install links', async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(internal.driverAppConfig.setConfig, { ...ANDROID, minSupportedBuild: 99 })
    ).rejects.toThrow(ConvexError);
    await expect(
      t.mutation(internal.driverAppConfig.setConfig, { ...ANDROID, installUrl: 'http://plain.example' })
    ).rejects.toThrow(ConvexError);
    await expect(
      t.mutation(internal.driverAppConfig.setConfig, { ...ANDROID, latestBuild: 18.5 })
    ).rejects.toThrow(ConvexError);
  });
});
