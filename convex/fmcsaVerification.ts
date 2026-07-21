/**
 * FMCSA carrier-authority verification.
 *
 * Checks the org's USDOT and MC/docket numbers against FMCSA data and stores
 * the result on the organization row (`authorityVerification`), which drives
 * the Verified/Pending badges on Settings → General. Also refreshes the
 * existing `operatingAuthorityActive` and `safetyRating` fields.
 *
 * Verification runs through a PROVIDER CHAIN:
 *
 *   1. QCMobile API (live) — used when the FMCSA_WEBKEY env var is set
 *      (free key from https://mobile.fmcsa.dot.gov/QCDevsite/). FMCSA's
 *      mobile web services have been offline since 2025 with no announced
 *      restoration date; when they return, this becomes the primary again
 *      automatically.
 *   2. FMCSA Open Data on data.transportation.gov (Socrata JSON API) — the
 *      official programmatic channel FMCSA points to while QCMobile is down.
 *      Company Census File (az4n-8mr2) answers existence / legal name /
 *      record status; the L&I Carrier registry (6qg9-x4f8, with Motus
 *      AuthHist dm5j-zc6c as backup) maps docket numbers to the USDOT
 *      number and carries operating-authority status for the MC
 *      cross-check. These are MCMIS extracts
 *      refreshed on a weekly-to-monthly cadence — near-real-time, not live —
 *      so results carry `source: 'open-data'` and the UI labels them.
 *      Optional SOCRATA_APP_TOKEN env var lifts the shared rate limit.
 *
 * Runs two ways:
 *   - Nightly cron (`verifyAllOrgs`) over every org with a USDOT number.
 *   - On demand from the settings page (`requestVerification` mutation, which
 *     asserts the caller's org and schedules the internal action).
 */

import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from './_generated/server';
import { internal } from './_generated/api';
import { assertOrgPermission } from './lib/auth';

const QCMOBILE_BASE_URL = 'https://mobile.fmcsa.dot.gov/qc/services';
const SOCRATA_BASE_URL = 'https://data.transportation.gov/resource';
const CENSUS_DATASET = 'az4n-8mr2'; // Company Census File
// Authority registries, queried in order for the MC ↔ USDOT cross-check.
// `conclusiveWhenEmpty` marks a FULL registry: only those may turn an empty
// answer into "not on file". NONE currently qualify: the legacy L&I Carrier
// file (6qg9-x4f8) is retired, and the entire Motus dataset family only
// carries deltas since Motus launched (~2025) — confirmed live: an active
// AUTHORIZED FOR HIRE carrier was absent from both Motus Carrier and
// AuthHist. So open data can currently confirm an MC (rows with a matching
// docket) or contradict it (rows exist, docket differs) but never prove
// absence. Restore conclusiveWhenEmpty if FMCSA publishes a full registry.
const AUTHORITY_DATASETS: Array<{ id: string; conclusiveWhenEmpty: boolean }> = [
  { id: 'nakq-58th', conclusiveWhenEmpty: false }, // Motus Carrier — deltas since launch
  { id: 'dm5j-zc6c', conclusiveWhenEmpty: false }, // Motus AuthHist — change history
];
// Filter column naming differs across FMCSA files; try until one is accepted.
const DOT_FILTER_COLUMNS = ['usdot_number', 'dot_number'];

type UsdotStatus = 'verified' | 'not_found' | 'error';
type McStatus = 'verified' | 'mismatch' | 'unchecked';
type VerificationSource = 'qcmobile' | 'open-data';

interface VerificationResult {
  checkedAt: number;
  usdotStatus: UsdotStatus;
  mcStatus: McStatus;
  source?: VerificationSource;
  allowedToOperate?: boolean;
  legalName?: string;
  safetyRating?: string;
  error?: string;
}

/**
 * Digits-only, leading-zero-insensitive view of an MC/docket number —
 * "MC-948217" and "00948217" both normalize to "948217". MCMIS extracts
 * often zero-pad docket numbers, so exact digit comparison false-negatives.
 */
const docketDigits = (value: string) => value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');

// ─── Public entry: on-demand verification from Settings → General ─────────

export const requestVerification = mutation({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await assertOrgPermission(ctx, args.workosOrgId, 'settings:edit');

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
      source: v.optional(v.union(v.literal('qcmobile'), v.literal('open-data'))),
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

// ─── Provider 1: QCMobile (live, keyed) ───────────────────────────────────

/** Fetch one QCMobile endpoint, returning parsed JSON or null on 404. */
async function qcMobileGet(path: string, webKey: string): Promise<unknown | null> {
  const res = await fetch(`${QCMOBILE_BASE_URL}${path}?webKey=${encodeURIComponent(webKey)}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`QCMobile API responded ${res.status}`);
  return res.json();
}

async function checkWithQcMobile(
  dot: string,
  mcNumber: string | undefined,
  webKey: string,
): Promise<VerificationResult> {
  // Carrier snapshot — existence, operating status, safety rating.
  const snapshot = (await qcMobileGet(`/carriers/${dot}`, webKey)) as {
    content?: { carrier?: Record<string, unknown> } | null;
  } | null;
  const carrier = snapshot?.content?.carrier;

  if (!carrier) {
    return {
      checkedAt: Date.now(),
      usdotStatus: 'not_found',
      mcStatus: 'unchecked',
      source: 'qcmobile',
      error: `USDOT ${dot} not found in FMCSA records`,
    };
  }

  // MC cross-check against the carrier's registered docket numbers.
  let mcStatus: McStatus = 'unchecked';
  const wantedDocket = mcNumber ? docketDigits(mcNumber) : '';
  if (wantedDocket) {
    try {
      const dockets = (await qcMobileGet(`/carriers/${dot}/docket-numbers`, webKey)) as {
        content?: Array<{ docketNumber?: number | string }> | null;
      } | null;
      const registered = (dockets?.content ?? []).map((d) => docketDigits(String(d.docketNumber ?? '')));
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
    source: 'qcmobile',
    allowedToOperate: carrier.allowedToOperate === 'Y',
    legalName: typeof carrier.legalName === 'string' ? carrier.legalName : undefined,
    safetyRating: typeof carrier.safetyRating === 'string' ? carrier.safetyRating : undefined,
  };
}

// ─── Provider 2: FMCSA Open Data (Socrata) ────────────────────────────────

async function socrataGet(
  dataset: string,
  params: Record<string, string>,
): Promise<Array<Record<string, unknown>>> {
  const qs = new URLSearchParams(params).toString();
  const token = process.env.SOCRATA_APP_TOKEN;
  const res = await fetch(`${SOCRATA_BASE_URL}/${dataset}.json?${qs}`, {
    headers: {
      Accept: 'application/json',
      ...(token ? { 'X-App-Token': token } : {}),
    },
  });
  if (!res.ok) throw new Error(`FMCSA open data responded ${res.status}`);
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) throw new Error('FMCSA open data returned an unexpected shape');
  return json as Array<Record<string, unknown>>;
}

/**
 * Pick the census facts we need out of a Company Census File row.
 * Exported for tests. Field names follow the Socrata API (lower_snake);
 * `status_code` is the MCMIS record status — 'A' means active.
 */
export function parseCensusRecord(rows: Array<Record<string, unknown>>): {
  found: boolean;
  legalName?: string;
  recordActive?: boolean;
} {
  const rec = rows[0];
  if (!rec) return { found: false };
  const legal = rec.legal_name ?? rec.legal_name_txt;
  const status = rec.status_code ?? rec.status;
  return {
    found: true,
    legalName: typeof legal === 'string' ? legal : undefined,
    recordActive:
      typeof status === 'string' ? status.trim().toUpperCase().startsWith('A') : undefined,
  };
}

/**
 * Does any Authority History row register the wanted docket number to this
 * carrier? Exported for tests. Matches any column whose name mentions
 * "docket" so minor dataset-schema drift doesn't break us.
 */
export function matchDocketRows(
  rows: Array<Record<string, unknown>>,
  wantedDocketDigits: string,
): McStatus {
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!/docket/i.test(key)) continue;
      if (docketDigits(String(value ?? '')) === wantedDocketDigits) return 'verified';
    }
  }
  return 'mismatch';
}

/**
 * Does any authority row carry an active operating-authority status?
 * Exported for tests. Status columns vary by file (`op_auth_status` in the
 * Motus datasets, `*_authority` / `*_auth_status` style in the legacy L&I
 * layout) with values like "Active"/"Inactive" or "A"/"I" — so this checks
 * every auth-named non-type column, and "Inactive" must never read as
 * active.
 */
export function authorityActiveFromRows(rows: Array<Record<string, unknown>>): boolean {
  return rows.some((row) =>
    Object.entries(row).some(([key, value]) => {
      if (!/auth/i.test(key) || /type/i.test(key)) return false;
      const status = String(value ?? '').trim().toUpperCase();
      return status === 'A' || status.startsWith('ACTIVE');
    }),
  );
}

/**
 * Rows whose DOT-named column (never a docket column) normalizes to the
 * wanted DOT. Exported for tests — guards the LIKE fallback below against
 * a different DOT that merely shares a digit suffix.
 */
export function rowsMatchingDot(
  rows: Array<Record<string, unknown>>,
  dot: string,
): Array<Record<string, unknown>> {
  return rows.filter((row) =>
    Object.entries(row).some(([key, value]) => {
      const k = key.toLowerCase();
      if (!k.includes('dot') || k.includes('docket')) return false;
      return docketDigits(String(value ?? '')) === dot;
    }),
  );
}

/**
 * Fetch this carrier's authority rows from the first registry dataset and
 * filter-column combination that responds. Each dataset gets two attempts:
 * exact equality, then a LIKE suffix sweep in case the file stores
 * zero-padded identifiers ("01239730"), verified client-side. Returns:
 *   - rows      → authority on file (docket cross-check is meaningful)
 *   - []        → a FULL registry answered and has nothing for this DOT
 *   - null      → nothing conclusive (only delta/history files answered
 *                 empty, or nothing answered at all) — callers must treat
 *                 this as "couldn't check", never "not on file".
 */
async function fetchAuthorityRows(
  dot: string,
): Promise<Array<Record<string, unknown>> | null> {
  let conclusiveEmpty = false;
  for (const { id, conclusiveWhenEmpty } of AUTHORITY_DATASETS) {
    let answered = false;
    for (const column of DOT_FILTER_COLUMNS) {
      try {
        const rows = await socrataGet(id, { [column]: dot, $limit: '5000' });
        answered = true;
        if (rows.length > 0) return rows;
        break; // dataset answered with no rows — its other column won't differ
      } catch {
        // Wrong filter column for this file or dataset unavailable — try next.
      }
    }
    if (answered) {
      // Zero-padded identifiers don't equality-match; sweep by suffix and
      // verify client-side. `dot` is digits-only, so the SoQL is inert.
      for (const column of DOT_FILTER_COLUMNS) {
        try {
          const rows = await socrataGet(id, {
            $where: `${column} like '%${dot}'`,
            $limit: '5000',
          });
          const relevant = rowsMatchingDot(rows, dot);
          if (relevant.length > 0) return relevant;
          break;
        } catch {
          // Column not in this file — try the next name.
        }
      }
      if (conclusiveWhenEmpty) conclusiveEmpty = true;
    }
  }
  return conclusiveEmpty ? [] : null;
}

async function checkWithOpenData(
  dot: string,
  mcNumber: string | undefined,
): Promise<VerificationResult> {
  const censusRows = await socrataGet(CENSUS_DATASET, { dot_number: dot, $limit: '1' });
  const census = parseCensusRecord(censusRows);

  if (!census.found) {
    return {
      checkedAt: Date.now(),
      usdotStatus: 'not_found',
      mcStatus: 'unchecked',
      source: 'open-data',
      error: `USDOT ${dot} not found in the FMCSA census`,
    };
  }

  const authRows = await fetchAuthorityRows(dot);

  let mcStatus: McStatus = 'unchecked';
  const wantedDocket = mcNumber ? docketDigits(mcNumber) : '';
  if (wantedDocket && authRows) {
    // Rows → real cross-check. Empty (only possible from a full registry)
    // → genuinely "not on file". Null stays "unchecked".
    mcStatus = matchDocketRows(authRows, wantedDocket);
  }

  return {
    checkedAt: Date.now(),
    usdotStatus: 'verified',
    mcStatus,
    source: 'open-data',
    // Prefer the real per-docket operating-authority status; carriers with
    // no authority rows (e.g. private carriers) fall back to the census
    // registration record status.
    allowedToOperate:
      authRows && authRows.length > 0 ? authorityActiveFromRows(authRows) : census.recordActive,
    legalName: census.legalName,
    // Safety rating is not in the census dataset; storeResult leaves the
    // previously known rating untouched when this is absent.
  };
}

// ─── The chain ────────────────────────────────────────────────────────────

export const verifyOrg = internalAction({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    const authority = await ctx.runQuery(internal.fmcsaVerification.getOrgAuthority, {
      workosOrgId: args.workosOrgId,
    });
    if (!authority?.usdotNumber?.trim()) return;

    const dot = authority.usdotNumber.replace(/\D/g, '');
    let result: VerificationResult | null = null;

    if (!dot) {
      result = {
        checkedAt: Date.now(),
        usdotStatus: 'not_found',
        mcStatus: 'unchecked',
        error: 'USDOT number contains no digits',
      };
    } else {
      const failures: string[] = [];

      const webKey = process.env.FMCSA_WEBKEY;
      if (webKey) {
        try {
          result = await checkWithQcMobile(dot, authority.mcNumber, webKey);
        } catch (error) {
          failures.push(
            `QCMobile: ${error instanceof Error ? error.message : 'lookup failed'}`,
          );
        }
      }

      if (!result) {
        try {
          result = await checkWithOpenData(dot, authority.mcNumber);
        } catch (error) {
          failures.push(
            `Open data: ${error instanceof Error ? error.message : 'lookup failed'}`,
          );
        }
      }

      if (!result) {
        result = {
          checkedAt: Date.now(),
          usdotStatus: 'error',
          mcStatus: 'unchecked',
          error: failures.join(' · ') || 'No verification source available',
        };
      }
    }

    await ctx.runMutation(internal.fmcsaVerification.storeResult, {
      workosOrgId: args.workosOrgId,
      result,
    });
  },
});

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
    // Stagger requests so the sweep stays polite to the FMCSA endpoints.
    for (let i = 0; i < orgIds.length; i++) {
      await ctx.scheduler.runAfter(i * 2000, internal.fmcsaVerification.verifyOrg, {
        workosOrgId: orgIds[i],
      });
    }
  },
});
