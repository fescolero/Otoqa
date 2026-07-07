/**
 * Client-side chunking for bulk actions over many rows.
 *
 * Convex mutations have a hard ~1-second execution budget. A bulk action that
 * sends the whole selection to one mutation makes that single transaction loop
 * every row server-side — past ~100 rows (fewer when each row does heavy
 * cascading work) it blows the budget, times out, and rolls back so NOTHING
 * commits. Splitting the selection into budget-sized chunks keeps each
 * mutation call small; each chunk is its own committed transaction, so partial
 * progress survives a mid-run failure.
 *
 * Chunks run SEQUENTIALLY, not in parallel: bulk finalizations typically patch
 * shared aggregate documents (counters, stats, settlement totals) that would
 * collide under Convex OCC if many chunks ran at once.
 *
 * Two shapes:
 *   - runChunkedBulk  — the mutation itself loops a chunk of ids server-side.
 *   - runChunkedEach  — one mutation PER id, run in bounded sequential batches
 *                       (for `Promise.all(ids.map(oneMutation))` call sites,
 *                       where each id is already its own transaction but firing
 *                       hundreds at once causes contention).
 */

/** Default rows per chunk. Comfortably under the ~1s budget for typical
 *  per-row work (~2–15 DB ops). Lower it per-call for heavy cascades. */
export const BULK_CHUNK_SIZE = 40;

export function chunkArray<T>(items: T[], size: number = BULK_CHUNK_SIZE): T[][] {
  const safeSize = Math.max(1, size);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) out.push(items.slice(i, i + safeSize));
  return out;
}

export type BulkTotals = { success: number; skipped: number; failed: number };

/** What a per-chunk mutation may return. Void/partial is fine — anything not
 *  reported failed/skipped counts as success. */
type ChunkResult = { success?: number; skipped?: number; failed?: number } | void | undefined | null;

export interface ChunkedOptions {
  /** Rows per chunk. Defaults to BULK_CHUNK_SIZE; lower for heavy per-row work. */
  chunkSize?: number;
  /** Called after each chunk with cumulative progress — wire to a toast. */
  onProgress?: (done: number, total: number, totals: BulkTotals) => void;
}

/**
 * Run ONE mutation per chunk of ids (the mutation loops the chunk server-side).
 * Sequential chunks, each an independently-committed transaction. A chunk that
 * throws counts its ids as failed and the run continues with the next chunk.
 */
export async function runChunkedBulk<TId>(
  ids: TId[],
  runChunk: (chunk: TId[]) => Promise<ChunkResult>,
  options: ChunkedOptions = {},
): Promise<BulkTotals> {
  const chunks = chunkArray(ids, options.chunkSize ?? BULK_CHUNK_SIZE);
  const totals: BulkTotals = { success: 0, skipped: 0, failed: 0 };

  for (const chunk of chunks) {
    try {
      const res = (await runChunk(chunk)) ?? {};
      const failed = res.failed ?? 0;
      const skipped = res.skipped ?? 0;
      totals.failed += failed;
      totals.skipped += skipped;
      totals.success += res.success ?? Math.max(0, chunk.length - failed - skipped);
    } catch (error) {
      totals.failed += chunk.length;
      console.error('runChunkedBulk chunk failed', error);
    }
    options.onProgress?.(totals.success + totals.skipped + totals.failed, ids.length, totals);
  }

  return totals;
}

/**
 * Run one mutation PER id, in bounded sequential batches (a barrier between
 * batches). Each id is its own transaction, so this never hits the single-tx
 * timeout — the batch cap just prevents firing hundreds of mutations
 * simultaneously, which would contend on shared documents under OCC.
 *
 * Default batch size is smaller than runChunkedBulk because each item is a full
 * round-trip and these mutations are often heavy (e.g. settlement approval
 * locking every payable).
 */
export async function runChunkedEach<TId>(
  ids: TId[],
  runOne: (id: TId) => Promise<unknown>,
  options: ChunkedOptions = {},
): Promise<BulkTotals> {
  const chunks = chunkArray(ids, options.chunkSize ?? 15);
  const totals: BulkTotals = { success: 0, skipped: 0, failed: 0 };

  for (const chunk of chunks) {
    const results = await Promise.allSettled(chunk.map((id) => runOne(id)));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        totals.success += 1;
      } else {
        totals.failed += 1;
        console.error('runChunkedEach item failed', r.reason);
      }
    }
    options.onProgress?.(totals.success + totals.skipped + totals.failed, ids.length, totals);
  }

  return totals;
}
