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
 *   range — same product, every other fill in the pool
 *   none  — nothing to compare against (the fill is alone)
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

export type PriceTier = 'state' | 'fleet' | 'range' | 'none';

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

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const normState = (s?: string) => (s ? s.trim().toUpperCase() : undefined);

export function assessPrices(
  rows: AnomalyInput[],
  opts: typeof PRICE_ANOMALY = PRICE_ANOMALY,
): Map<string, PriceAssessment> {
  const out = new Map<string, PriceAssessment>();
  const windowMs = opts.windowDays * DAY_MS;

  const byProduct = new Map<string, AnomalyInput[]>();
  for (const r of rows) {
    const list = byProduct.get(r.product) ?? [];
    list.push(r);
    byProduct.set(r.product, list);
  }

  for (const group of byProduct.values()) {
    group.sort((a, b) => a.entryDate - b.entryDate);
    const allPrices = group.map((r) => r.pricePerGallon);

    // Sliding window over the date-sorted group.
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < group.length; i++) {
      const me = group[i];
      while (lo < group.length && group[lo].entryDate < me.entryDate - windowMs) lo++;
      while (hi < group.length && group[hi].entryDate <= me.entryDate + windowMs) hi++;

      const myState = normState(me.state);
      const fleetPeers: number[] = [];
      const statePeers: number[] = [];
      for (let j = lo; j < hi; j++) {
        if (j === i) continue;
        const p = group[j];
        fleetPeers.push(p.pricePerGallon);
        if (myState && normState(p.state) === myState) statePeers.push(p.pricePerGallon);
      }

      let tier: PriceTier = 'none';
      let peers: number[] = [];
      if (statePeers.length >= opts.minPeers) {
        tier = 'state';
        peers = statePeers;
      } else if (fleetPeers.length >= opts.minPeers) {
        tier = 'fleet';
        peers = fleetPeers;
      } else if (group.length > 1) {
        tier = 'range';
        peers = allPrices.filter((_, j) => j !== i);
      }

      if (peers.length === 0) {
        out.set(me.id, { benchmark: null, delta: 0, pct: 0, tier: 'none', peers: 0, flagged: false });
        continue;
      }
      const benchmark = median(peers);
      const delta = me.pricePerGallon - benchmark;
      const limit = Math.max(opts.floor, benchmark * opts.pct);
      out.set(me.id, {
        benchmark,
        delta,
        pct: benchmark > 0 ? delta / benchmark : 0,
        tier,
        peers: peers.length,
        flagged: delta > limit,
      });
    }
  }
  return out;
}
