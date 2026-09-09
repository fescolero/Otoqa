/**
 * Price-anomaly assessment for fuel purchases.
 *
 * Every fill is judged against a BENCHMARK built from the fleet's other
 * fills of the same product close in time — never against the whole
 * range, and never against a filtered subset. So a rising market does
 * not flag every late-month fill, and filtering the report to one driver
 * or vendor does not change what "expensive" means.
 *
 * Benchmark = median $/gal of the peer set, leaving the fill itself out.
 * A median shrugs off a single fat-fingered $70/gal row where an average
 * would move. Peers are chosen in tiers, first one with enough samples:
 *
 *   state — same product, same state, within ±WINDOW days
 *   fleet — same product, any state,  within ±WINDOW days
 *   thin  — same product, within ±WINDOW days, but fewer than the minimum:
 *           a benchmark is still reported for context, never a flag
 *   none  — nothing within the window to compare against
 *
 * The benchmark depends on nothing but the fill and the fills within the
 * window around it — never on how wide a report range happens to be —
 * so the reports page and an entry's detail page always agree.
 *
 * A fill is flagged when it exceeds the benchmark by more than the larger
 * of a fixed floor and a percentage — a fixed cents figure means different
 * things at $3 and $7 diesel.
 *
 * Pure: no ctx, no db. Callers load the pool (ideally the report range
 * widened by WINDOW on each side so edge fills still have peers) and hand
 * it in.
 */

const DAY_MS = 86_400_000;

export const PRICE_ANOMALY = {
  /** Peers must fall within this many days either side of the fill. */
  windowDays: 3,
  /** A tier needs at least this many peers to be trusted. */
  minPeers: 3,
  /** Flag above benchmark × (1 + pct) … */
  pct: 0.05,
  /** … or benchmark + floor, whichever is larger. */
  floor: 0.25,
} as const;

/** price × gallons should equal the recorded total, within a few cents. */
export const TOTAL_MISMATCH = { abs: 0.05, pct: 0.005 } as const;

export type PriceTier = 'state' | 'fleet' | 'thin' | 'none';

export interface AnomalyInput {
  id: string;
  product: string;
  entryDate: number;
  pricePerGallon: number;
  gallons: number;
  totalCost: number;
  state?: string;
}

export interface PriceAssessment {
  /** Peer median $/gal, or null when the fill has no peers at all. */
  benchmark: number | null;
  /** pricePerGallon − benchmark (0 when no benchmark). */
  delta: number;
  /** delta ÷ benchmark (0 when no benchmark). */
  pct: number;
  tier: PriceTier;
  peers: number;
  flagged: boolean;
}

export function isTotalMismatch(e: Pick<AnomalyInput, 'pricePerGallon' | 'gallons' | 'totalCost'>): boolean {
  const expected = e.pricePerGallon * e.gallons;
  const tolerance = Math.max(TOTAL_MISMATCH.abs, Math.abs(e.totalCost) * TOTAL_MISMATCH.pct);
  return Math.abs(expected - e.totalCost) > tolerance;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const normState = (s?: string) => (s ? s.trim().toUpperCase() : undefined);

/** How far above `benchmark` a price may sit before it is flagged. */
export function priceLimit(benchmark: number, opts: typeof PRICE_ANOMALY = PRICE_ANOMALY): number {
  return Math.max(opts.floor, benchmark * opts.pct);
}

function judge(
  me: AnomalyInput,
  peers: AnomalyInput[],
  tier: PriceTier,
  opts: typeof PRICE_ANOMALY,
): PriceAssessment {
  if (peers.length === 0) {
    return { benchmark: null, delta: 0, pct: 0, tier: 'none', peers: 0, flagged: false };
  }
  const benchmark = median(peers.map((p) => p.pricePerGallon));
  const delta = me.pricePerGallon - benchmark;
  return {
    benchmark,
    delta,
    pct: benchmark > 0 ? delta / benchmark : 0,
    tier,
    peers: peers.length,
    // A thin peer set is shown, never trusted: one odd neighbour would
    // flag a normal fill.
    flagged: tier !== 'thin' && delta > priceLimit(benchmark, opts),
  };
}

/**
 * Pick the peer set for one fill from `windowed`, the same-product fills
 * within the anomaly window (the fill itself excluded). Tiers fall
 * through in the order the module comment gives.
 */
function pickPeers(
  me: AnomalyInput,
  windowed: AnomalyInput[],
  opts: typeof PRICE_ANOMALY,
): { tier: PriceTier; peers: AnomalyInput[] } {
  const myState = normState(me.state);
  const statePeers = myState ? windowed.filter((p) => normState(p.state) === myState) : [];
  if (statePeers.length >= opts.minPeers) return { tier: 'state', peers: statePeers };
  if (windowed.length >= opts.minPeers) return { tier: 'fleet', peers: windowed };
  if (windowed.length > 0) return { tier: 'thin', peers: windowed };
  return { tier: 'none', peers: [] };
}

function groupByProduct(rows: AnomalyInput[]): Map<string, AnomalyInput[]> {
  const byProduct = new Map<string, AnomalyInput[]>();
  for (const r of rows) {
    const list = byProduct.get(r.product) ?? [];
    list.push(r);
    byProduct.set(r.product, list);
  }
  for (const group of byProduct.values()) group.sort((a, b) => a.entryDate - b.entryDate);
  return byProduct;
}

export function assessPrices(
  rows: AnomalyInput[],
  opts: typeof PRICE_ANOMALY = PRICE_ANOMALY,
): Map<string, PriceAssessment> {
  const out = new Map<string, PriceAssessment>();
  const windowMs = opts.windowDays * DAY_MS;

  for (const group of groupByProduct(rows).values()) {
    // Sliding window over the date-sorted group.
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < group.length; i++) {
      const me = group[i];
      while (lo < group.length && group[lo].entryDate < me.entryDate - windowMs) lo++;
      while (hi < group.length && group[hi].entryDate <= me.entryDate + windowMs) hi++;
      const windowed: AnomalyInput[] = [];
      for (let j = lo; j < hi; j++) if (j !== i) windowed.push(group[j]);
      const { tier, peers } = pickPeers(me, windowed, opts);
      out.set(me.id, judge(me, peers, tier, opts));
    }
  }
  return out;
}

/**
 * Assess ONE fill against a pool and hand back the peers that judged it,
 * nearest in time first — for the detail page, which shows the user the
 * fills behind the benchmark rather than a bare median. `me` need not be
 * in `pool`; when it is, it is left out of its own peer set.
 */
export function assessOne(
  me: AnomalyInput,
  pool: AnomalyInput[],
  opts: typeof PRICE_ANOMALY = PRICE_ANOMALY,
): { assessment: PriceAssessment; peers: AnomalyInput[] } {
  const windowMs = opts.windowDays * DAY_MS;
  const windowed = pool.filter(
    (p) => p.product === me.product && p.id !== me.id && Math.abs(p.entryDate - me.entryDate) <= windowMs,
  );
  const { tier, peers } = pickPeers(me, windowed, opts);
  const sorted = [...peers].sort(
    (a, b) => Math.abs(a.entryDate - me.entryDate) - Math.abs(b.entryDate - me.entryDate),
  );
  return { assessment: judge(me, peers, tier, opts), peers: sorted };
}

// ─── Likely cause ─────────────────────────────────────────────────────
// Most fills that sit 50%+ above their peers are not overpays but entry
// errors, and the fix differs for each. These checks are cheap pattern
// tests against the benchmark; each fires only when the corrected value
// would land inside the tolerance the fill itself failed.

export type PriceCause =
  | 'mismatch'      // price × gallons ≠ total
  | 'swapped'       // price and gallons typed in each other's fields
  | 'total_as_price' // the receipt total typed into the price field
  | 'decimal'       // decimal point slipped (×10 or ×100)
  | 'product'       // priced like the OTHER product (DEF vs diesel)
  | 'none';         // nothing obvious; the price itself is high

const fits = (price: number, benchmark: number, opts: typeof PRICE_ANOMALY) =>
  Math.abs(price - benchmark) <= priceLimit(benchmark, opts);

/**
 * `otherBenchmark` is the benchmark the fill would have had under the
 * other product (DEF for a diesel fill and vice versa), when the caller
 * could compute one. Returns causes in confidence order, most likely
 * first; `none` only when nothing matched.
 */
export function diagnosePrice(
  me: Pick<AnomalyInput, 'pricePerGallon' | 'gallons' | 'totalCost'>,
  benchmark: number | null,
  otherBenchmark: number | null = null,
  opts: typeof PRICE_ANOMALY = PRICE_ANOMALY,
): PriceCause[] {
  const out: PriceCause[] = [];
  const { pricePerGallon: price, gallons, totalCost: total } = me;
  const near = (x: number) => benchmark !== null && fits(x, benchmark, opts);

  // Swapped: the gallons figure reads as a plausible price and the
  // price figure as a plausible fill size, and the product still
  // matches the recorded total.
  if (
    gallons > 0 && near(gallons) &&
    Math.abs(price * gallons - total) <= Math.max(TOTAL_MISMATCH.abs, total * TOTAL_MISMATCH.pct)
  ) {
    out.push('swapped');
  }
  // Total typed into the price field.
  if (total > 0 && Math.abs(price - total) <= Math.max(0.01, total * 0.01)) out.push('total_as_price');
  // Decimal slipped: $41.99 or $419.9 for $4.199.
  if (near(price / 10) || near(price / 100)) out.push('decimal');
  // Looks like the other product's going rate.
  if (otherBenchmark !== null && fits(price, otherBenchmark, opts)) out.push('product');
  // Internal inconsistency — reported last because the others explain it.
  if (isTotalMismatch(me)) out.push('mismatch');

  return out.length ? out : ['none'];
}
