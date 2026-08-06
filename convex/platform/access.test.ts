/**
 * Fail-closed tests for the platform-console guard (requirePlatformStaff)
 * via convex/platform/access.ts.
 *
 * The contract under test (plan §5): only a token from the STAFF issuer
 * with an allowlisted, verified email passes. Tenant WorkOS tokens, Clerk
 * tokens, unauthenticated callers, unlisted emails, and deployments with
 * no STAFF_ISSUER configured are ALL rejected — and the tenant legacy
 * grandfathering rule (permissions == null ⇒ allow) must never apply.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';

const STAFF_ISSUER = 'https://api.workos.com/user_management/client_staff_test';
const TENANT_ISSUER = 'https://api.workos.com/user_management/client_tenant_test';
const CLERK_ISSUER = 'https://tenant-app.clerk.accounts.dev';
const STAFF_EMAIL = 'ops@otoqa.com';

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.STAFF_ISSUER = process.env.STAFF_ISSUER;
  savedEnv.STAFF_EMAIL_ALLOWLIST = process.env.STAFF_EMAIL_ALLOWLIST;
  process.env.STAFF_ISSUER = STAFF_ISSUER;
  process.env.STAFF_EMAIL_ALLOWLIST = `${STAFF_EMAIL}, second@otoqa.com`;
});

afterEach(() => {
  process.env.STAFF_ISSUER = savedEnv.STAFF_ISSUER;
  process.env.STAFF_EMAIL_ALLOWLIST = savedEnv.STAFF_EMAIL_ALLOWLIST;
});

describe('platform.access — requirePlatformStaff', () => {
  it('allows a staff-issuer caller with an allowlisted email', async () => {
    const t = convexTest(schema);
    const result = await t
      .withIdentity({ issuer: STAFF_ISSUER, subject: 'staff_1', email: STAFF_EMAIL } as never)
      .query(api.platform.access.me, {});
    expect(result).toEqual({ email: STAFF_EMAIL });
  });

  it('matches allowlist emails case-insensitively', async () => {
    const t = convexTest(schema);
    const result = await t
      .withIdentity({ issuer: STAFF_ISSUER, subject: 'staff_1', email: 'Ops@Otoqa.com' } as never)
      .query(api.platform.access.me, {});
    expect(result).toEqual({ email: STAFF_EMAIL });
  });

  it('rejects unauthenticated callers', async () => {
    const t = convexTest(schema);
    await expect(t.query(api.platform.access.me, {})).rejects.toThrow(/Unauthenticated/);
  });

  it('rejects tenant WorkOS tokens — even org admins with full tenant claims', async () => {
    const t = convexTest(schema);
    await expect(
      t
        .withIdentity({
          issuer: TENANT_ISSUER,
          subject: 'user_tenant_admin',
          email: STAFF_EMAIL, // allowlisted email does NOT rescue a wrong issuer
          org_id: 'org_tenant',
          role: 'admin',
        } as never)
        .query(api.platform.access.me, {}),
    ).rejects.toThrow(/Not platform staff/);
  });

  it('rejects Clerk mobile tokens', async () => {
    const t = convexTest(schema);
    await expect(
      t
        .withIdentity({
          issuer: CLERK_ISSUER,
          subject: 'user_clerk',
          phone_number: '+15305550100',
        } as never)
        .query(api.platform.access.me, {}),
    ).rejects.toThrow(/Not platform staff/);
  });

  it('rejects legacy-claims tokens (no permissions array) — no grandfathering', async () => {
    const t = convexTest(schema);
    // Tenant legacy tokens pass isPermitted via the permissions==null rule;
    // the platform path must not inherit that behavior.
    await expect(
      t
        .withIdentity({ issuer: TENANT_ISSUER, subject: 'user_legacy', email: STAFF_EMAIL } as never)
        .query(api.platform.access.me, {}),
    ).rejects.toThrow(/Not platform staff/);
  });

  it('rejects staff-issuer callers whose email is not on the allowlist', async () => {
    const t = convexTest(schema);
    await expect(
      t
        .withIdentity({ issuer: STAFF_ISSUER, subject: 'staff_x', email: 'intruder@gmail.com' } as never)
        .query(api.platform.access.me, {}),
    ).rejects.toThrow(/Not platform staff/);
  });

  it('rejects staff-issuer callers with no email claim', async () => {
    const t = convexTest(schema);
    await expect(
      t
        .withIdentity({ issuer: STAFF_ISSUER, subject: 'staff_noemail' } as never)
        .query(api.platform.access.me, {}),
    ).rejects.toThrow(/Not platform staff/);
  });

  it('rejects explicitly unverified emails', async () => {
    const t = convexTest(schema);
    await expect(
      t
        .withIdentity({
          issuer: STAFF_ISSUER,
          subject: 'staff_unverified',
          email: STAFF_EMAIL,
          emailVerified: false,
        } as never)
        .query(api.platform.access.me, {}),
    ).rejects.toThrow(/Not platform staff/);
  });

  it('fails closed when STAFF_ISSUER is not configured on the deployment', async () => {
    delete process.env.STAFF_ISSUER;
    const t = convexTest(schema);
    await expect(
      t
        .withIdentity({ issuer: STAFF_ISSUER, subject: 'staff_1', email: STAFF_EMAIL } as never)
        .query(api.platform.access.me, {}),
    ).rejects.toThrow(/not enabled/);
  });

  it('fails closed when the allowlist is empty', async () => {
    process.env.STAFF_EMAIL_ALLOWLIST = '';
    const t = convexTest(schema);
    await expect(
      t
        .withIdentity({ issuer: STAFF_ISSUER, subject: 'staff_1', email: STAFF_EMAIL } as never)
        .query(api.platform.access.me, {}),
    ).rejects.toThrow(/Not platform staff/);
  });

  it('records session start in platformAuditLog and lists it, staff-only', async () => {
    const t = convexTest(schema);
    const staff = t.withIdentity({
      issuer: STAFF_ISSUER,
      subject: 'staff_1',
      email: STAFF_EMAIL,
    } as never);

    await staff.mutation(api.platform.access.recordSessionStart, {});
    const rows = await staff.query(api.platform.access.recentAuditLog, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorEmail: STAFF_EMAIL,
      action: 'staff_session_started',
    });

    // Tenant caller cannot read the platform audit log.
    await expect(
      t
        .withIdentity({ issuer: TENANT_ISSUER, subject: 'u', org_id: 'org_t', email: STAFF_EMAIL } as never)
        .query(api.platform.access.recentAuditLog, {}),
    ).rejects.toThrow(/Not platform staff/);
  });
});
