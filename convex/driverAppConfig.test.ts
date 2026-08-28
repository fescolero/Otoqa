/**
 * Tests for the driver-app release channel (convex/driverAppConfig.ts):
 * per-platform upsert semantics, input validation, and the public
 * projection the UpdateGate reads.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
      latestVersion: null,
      dispatchPhone: null,
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

  it('recordBuild merges over human-owned fields and drops stale builds', async () => {
    const t = convexTest(schema);
    await t.mutation(internal.driverAppConfig.setConfig, {
      ...ANDROID,
      minSupportedBuild: 17,
      dispatchPhone: '(510) 555-0142',
      message: 'Please update',
    });

    await t.mutation(internal.driverAppConfig.recordBuild, {
      platform: 'android',
      latestBuild: 19,
      installUrl: 'https://expo.dev/artifacts/new.apk',
      latestVersion: '1.0.0 (19)',
    });

    const after = await t.query(api.driverAppConfig.get, { platform: 'android' });
    expect(after).toMatchObject({
      latestBuild: 19,
      minSupportedBuild: 17, // floor untouched
      dispatchPhone: '(510) 555-0142',
      message: 'Please update',
      installUrl: 'https://expo.dev/artifacts/new.apk',
      latestVersion: '1.0.0 (19)',
    });

    // A re-delivered older build cannot roll the channel back.
    const outcome = await t.mutation(internal.driverAppConfig.recordBuild, {
      platform: 'android',
      latestBuild: 18,
      installUrl: 'https://expo.dev/artifacts/old.apk',
    });
    expect(outcome).toBe('ignored_stale');
    const unchanged = await t.query(api.driverAppConfig.get, { platform: 'android' });
    expect(unchanged?.latestBuild).toBe(19);
    expect(unchanged?.installUrl).toBe('https://expo.dev/artifacts/new.apk');
  });

  it('recordBuild bootstraps a missing row with a permissive floor', async () => {
    const t = convexTest(schema);
    await t.mutation(internal.driverAppConfig.recordBuild, {
      platform: 'ios',
      latestBuild: 18,
      installUrl: 'https://expo.dev/builds/xyz',
    });
    const config = await t.query(api.driverAppConfig.get, { platform: 'ios' });
    expect(config?.latestBuild).toBe(18);
    expect(config?.minSupportedBuild).toBe(1); // never blocks on its own
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

describe('EAS build webhook (/eas/build-webhook)', () => {
  const SECRET = 'test-webhook-secret-0123456789';
  const DRIVER_PROJECT = '6449e793-4e00-49e3-be2f-586c9ffc4dd2';

  beforeEach(() => {
    process.env.EAS_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.EAS_WEBHOOK_SECRET;
  });

  async function sign(body: string, secret = SECRET) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `sha1=${hex}`;
  }

  function finishedBuild(overrides: Record<string, unknown> = {}) {
    return {
      appId: DRIVER_PROJECT,
      platform: 'android',
      status: 'finished',
      buildDetailsPageUrl: 'https://expo.dev/accounts/otoqa/builds/abc',
      artifacts: { buildUrl: 'https://expo.dev/artifacts/eas/app.apk' },
      metadata: { appVersion: '1.0.0', appBuildVersion: '18', buildProfile: 'preview' },
      ...overrides,
    };
  }

  async function post(t: ReturnType<typeof convexTest>, payload: unknown, signature?: string) {
    const body = JSON.stringify(payload);
    return await t.fetch('/eas/build-webhook', {
      method: 'POST',
      headers: { 'expo-signature': signature ?? (await sign(body)) },
      body,
    });
  }

  it('records a finished driver build and serves it to the app', async () => {
    const t = convexTest(schema);
    const res = await post(t, finishedBuild());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('recorded');

    const config = await t.query(api.driverAppConfig.get, { platform: 'android' });
    expect(config).toMatchObject({
      latestBuild: 18,
      latestVersion: '1.0.0',
      installUrl: 'https://expo.dev/artifacts/eas/app.apk', // APK, not the build page
      minSupportedBuild: 1,
    });
  });

  it('rejects a bad signature and leaves no trace', async () => {
    const t = convexTest(schema);
    const body = finishedBuild();
    const res = await post(t, body, await sign(JSON.stringify(body), 'wrong-secret-9876543210'));
    expect(res.status).toBe(401);
    expect(await t.query(api.driverAppConfig.get, { platform: 'android' })).toBeNull();
  });

  it('ignores errored builds, dev-client builds, and other projects', async () => {
    const t = convexTest(schema);
    for (const payload of [
      finishedBuild({ status: 'errored' }),
      finishedBuild({ metadata: { appVersion: '1.0.0', appBuildVersion: '18', buildProfile: 'development' } }),
      finishedBuild({ appId: 'some-other-project-id' }),
    ]) {
      const res = await post(t, payload);
      expect(res.status).toBe(200); // benign skip — EAS must not retry
      expect(await res.text()).toMatch(/^ignored/);
    }
    expect(await t.query(api.driverAppConfig.get, { platform: 'android' })).toBeNull();
  });

  it('iOS builds prefer the build page over the raw IPA artifact', async () => {
    const t = convexTest(schema);
    await post(t, finishedBuild({ platform: 'ios' }));
    const config = await t.query(api.driverAppConfig.get, { platform: 'ios' });
    expect(config?.installUrl).toBe('https://expo.dev/accounts/otoqa/builds/abc');
  });
});
