/**
 * FMCSA carrier-authority verification.
 *
 * Checks the org's USDOT and MC/docket numbers against the FMCSA QCMobile
 * API and stores the result on the organization row
 * (`authorityVerification`), which drives the Verified/Pending badges on
 * Settings → General. Also refreshes the existing `operatingAuthorityActive`
 * and `safetyRating` fields from the authoritative source.
 *
 * Runs two ways:
 *   - Nightly cron (`verifyAllOrgs`) over every org with a USDOT number.
 *   - On demand from the settings page (`requestVerification` mutation, which
 *     asserts the caller's org and schedules the internal action).
 *
 * Requires the FMCSA_WEBKEY env var (free key from
 * https://mobile.fmcsa.dot.gov/QCDevsite/). Without it, verification stores
 * an explanatory error result instead of failing silently.
 */

import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from './_generated/server';
import { internal } from './_generated/api';
import { assertCallerOwnsOrg } from './lib/auth';

const FMCSA_BASE_URL = 'https://mobile.fmcsa.dot.gov/qc/services';

type UsdotStatus = 'verified' | 'not_found' | 'error';
type McStatus = 'verified' | 'mismatch' | 'unchecked';

interface VerificationResult {
  checkedAt: number;
  usdotStatus: UsdotStatus;
  mcStatus: McStatus;
  allowedToOperate?: boolean;
  legalName?: string;
  safetyRating?: string;
  error?: string;
}

// ─── Public entry: on-demand verification from Settings → General ─────────

export const requestVerification = mutation({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const org = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .unique();
    if (!org) throw new Error('Organization not found');
    if (!org.usdotNumber?.trim()) {
      throw new Error('Add a USDOT number before verifying');
    }

    await ctx.scheduler.runAfter(0, internal.fmcsaVerification.verifyOrg, {
      workosOrgId: args.workosOrgId,
    });
  },
});

// ─── Internal plumbing ────────────────────────────────────────────────────

export const getOrgAuthority = internalQuery({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .unique();
    if (!org) return null;
    return { usdotNumber: org.usdotNumber, mcNumber: org.mcNumber };
  },
});

export const storeResult = internalMutation({
  args: {
    workosOrgId: v.string(),
    result: v.object({
      checkedAt: v.number(),
      usdotStatus: v.union(v.literal('verified'), v.literal('not_found'), v.literal('error')),
      mcStatus: v.union(v.literal('verified'), v.literal('mismatch'), v.literal('unchecked')),
      allowedToOperate: v.optional(v.boolean()),
      legalName: v.optional(v.string()),
      safetyRating: v.optional(v.string()),
      error: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .unique();
    if (!org) return;

    await ctx.db.patch(org._id, {
      authorityVerification: args.result,
      // Refresh the authoritative operating fields only when the check
      // actually reached FMCSA — an API error must not flip a previously
      // verified org to inactive.
      ...(args.result.usdotStatus === 'verified'
        ? {
            operatingAuthorityActive: args.result.allowedToOperate ?? false,
            ...(args.result.safetyRating ? { safetyRating: args.result.safetyRating } : {}),
          }
        : {}),
      updatedAt: Date.now(),
    });
  },
});

/** Fetch one QCMobile endpoint, returning parsed JSON or null on 404. */
async function fmcsaGet(path: string, webKey: string): Promise<unknown | null> {
  const res = await fetch(`${FMCSA_BASE_URL}${path}?webKey=${encodeURIComponent(webKey)}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`FMCSA API responded ${res.status}`);
  return res.json();
}

/** Digits-only view of an MC/docket number ("MC-948217" → "948217"). */
const docketDigits = (value: string) => value.replace(/\D/g, '');

export const verifyOrg = internalAction({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    const authority = await ctx.runQuery(internal.fmcsaVerification.getOrgAuthority, {
      workosOrgId: args.workosOrgId,
    });
    if (!authority?.usdotNumber?.trim()) return;

    const dot = authority.usdotNumber.replace(/\D/g, '');
    const webKey = process.env.FMCSA_WEBKEY;

    let result: VerificationResult;
    if (!webKey) {
      result = {
        checkedAt: Date.now(),
        usdotStatus: 'error',
        mcStatus: 'unchecked',
        error: 'FMCSA_WEBKEY is not configured on the Convex deployment',
      };
    } else if (!dot) {
      result = {
        checkedAt: Date.now(),
        usdotStatus: 'not_found',
        mcStatus: 'unchecked',
        error: 'USDOT number contains no digits',
      };
    } else {
      try {
        result = await checkWithFmcsa(dot, authority.mcNumber, webKey);
      } catch (error) {
        result = {
          checkedAt: Date.now(),
          usdotStatus: 'error',
          mcStatus: 'unchecked',
          error: error instanceof Error ? error.message : 'FMCSA lookup failed',
        };
      }
    }

    await ctx.runMutation(internal.fmcsaVerification.storeResult, {
      workosOrgId: args.workosOrgId,
      result,
    });
  },
});

async function checkWithFmcsa(
  dot: string,
  mcNumber: string | undefined,
  webKey: string,
): Promise<VerificationResult> {
  // Carrier snapshot — existence, operating status, safety rating.
  const snapshot = (await fmcsaGet(`/carriers/${dot}`, webKey)) as {
    content?: { carrier?: Record<string, unknown> } | null;
  } | null;
  const carrier = snapshot?.content?.carrier;

  if (!carrier) {
    return {
      checkedAt: Date.now(),
      usdotStatus: 'not_found',
      mcStatus: 'unchecked',
      error: `USDOT ${dot} not found in FMCSA records`,
    };
  }

  // MC cross-check against the carrier's registered docket numbers.
  let mcStatus: McStatus = 'unchecked';
  const wantedDocket = mcNumber ? docketDigits(mcNumber) : '';
  if (wantedDocket) {
    try {
      const dockets = (await fmcsaGet(`/carriers/${dot}/docket-numbers`, webKey)) as {
        content?: Array<{ docketNumber?: number | string }> | null;
      } | null;
      const registered = (dockets?.content ?? []).map((d) => String(d.docketNumber ?? ''));
      mcStatus = registered.includes(wantedDocket) ? 'verified' : 'mismatch';
    } catch {
      // Snapshot succeeded but docket lookup failed — report the USDOT
      // result and leave MC unchecked rather than failing the whole run.
      mcStatus = 'unchecked';
    }
  }

  return {
    checkedAt: Date.now(),
    usdotStatus: 'verified',
    mcStatus,
    allowedToOperate: carrier.allowedToOperate === 'Y',
    legalName: typeof carrier.legalName === 'string' ? carrier.legalName : undefined,
    safetyRating: typeof carrier.safetyRating === 'string' ? carrier.safetyRating : undefined,
  };
}

// ─── Nightly sweep ────────────────────────────────────────────────────────

export const listOrgsWithAuthority = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Bounded by real tenant counts. Only orgs with a USDOT number are
    // eligible for verification.
    const orgs = await ctx.db.query('organizations').collect();
    return orgs
      .filter((o) => !o.isDeleted && o.workosOrgId && o.usdotNumber?.trim())
      .map((o) => o.workosOrgId as string);
  },
});

export const verifyAllOrgs = internalAction({
  args: {},
  handler: async (ctx) => {
    const orgIds = await ctx.runQuery(internal.fmcsaVerification.listOrgsWithAuthority, {});
    // Stagger requests so the sweep stays polite to the FMCSA API.
    for (let i = 0; i < orgIds.length; i++) {
      await ctx.scheduler.runAfter(i * 2000, internal.fmcsaVerification.verifyOrg, {
        workosOrgId: orgIds[i],
      });
    }
  },
});
