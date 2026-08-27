/**
 * How a run identifies itself on the board.
 *
 * Pure and react-native-free so the node vitest project can cover it.
 *
 * Geography was the design's answer, and it's the wrong one for HCR contract
 * work: a carrier running USPS routes sees the same two cities all day, so
 * "Moreno Valley → Ontario, via Ontario, Moreno Valley, Ontario…" tells a
 * dispatcher nothing about which run they're looking at. The contract and
 * trip numbers do. Route stays as the fallback for work that carries no
 * contract facets.
 */

export interface RunFacets {
  hcrs?: string[];
  trips?: string[];
  from?: string | null;
  to?: string | null;
  via?: string[];
}

export interface RunIdentity {
  /** Bold first line. */
  primary: string;
  /** Muted second line, omitted when there's nothing worth saying. */
  secondary: string | null;
  /** True when this came from contract facets rather than geography. */
  fromContract: boolean;
}

/**
 * Collapse trip numbers to something a phone row can hold.
 *
 * A contiguous numeric block becomes a range — an 8-load run is usually
 * trips 211 through 218, and printing all eight wastes the line that has to
 * distinguish it from the run below. Non-contiguous sets list the first few
 * and count the rest.
 */
export function formatTrips(trips: string[]): string | null {
  if (trips.length === 0) return null;
  if (trips.length === 1) return `Trip ${trips[0]}`;

  const nums = trips.map((t) => Number(t));
  const allNumeric = nums.every((n) => Number.isFinite(n));
  if (allNumeric) {
    const sorted = [...nums].sort((a, b) => a - b);
    const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
    if (contiguous) return `Trips ${sorted[0]}–${sorted[sorted.length - 1]}`;
  }

  const head = trips.slice(0, 3).join(', ');
  const rest = trips.length - 3;
  return rest > 0 ? `Trips ${head} +${rest}` : `Trips ${head}`;
}

/** One contract reads as itself; several are worth counting, not listing. */
export function formatHcrs(hcrs: string[]): string | null {
  if (hcrs.length === 0) return null;
  if (hcrs.length === 1) return `HCR ${hcrs[0]}`;
  return `${hcrs.length} HCRs`;
}

/** The route line, kept for work with no contract identity. */
export function formatRoute(run: RunFacets): string {
  const { from, to } = run;
  if (from && from === to) return `${from} round trip`;
  if (from || to) return `${from ?? '—'} → ${to ?? '—'}`;
  return 'Route unavailable';
}

export function runIdentity(run: RunFacets): RunIdentity {
  const hcr = formatHcrs(run.hcrs ?? []);
  const trips = formatTrips(run.trips ?? []);

  if (hcr || trips) {
    return {
      // Whichever exists leads; with both, the contract is the heading and
      // the trips qualify it.
      primary: hcr ?? trips!,
      secondary: hcr && trips ? trips : formatRoute(run),
      fromContract: true,
    };
  }

  return { primary: formatRoute(run), secondary: null, fromContract: false };
}


/**
 * A single load's heading, on the same principle as a run's.
 *
 * `HCR 945L4 · Trip 27` says which of today's identical-looking runs this
 * is; the load number does not. It stays available in the meta line beneath,
 * where operations can still read it off, rather than being dropped.
 *
 * Falls back to the load number for work with no contract facets — that's
 * the only identity such a load has.
 */
export function loadIdentity(load: {
  hcr?: string | null;
  tripNumber?: string | null;
  internalId?: string | null;
}): string {
  const parts: string[] = [];
  if (load.hcr) parts.push(`HCR ${load.hcr}`);
  if (load.tripNumber) parts.push(`Trip ${load.tripNumber}`);
  if (parts.length > 0) return parts.join(' · ');
  return load.internalId ? load.internalId.replace(/^fk[-_]?/i, '') : '—';
}
