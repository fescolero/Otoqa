/**
 * Bulk PDF download helper — shared by the Invoices and Settlements lists.
 *
 * Each call site renders its OWN @react-pdf document to a Blob (this helper
 * never imports react-pdf or knows the document shape). We render with bounded
 * concurrency (react-pdf is main-thread and CPU-heavy — a few large statements
 * in flight at once is enough to jank the tab), tolerate per-item failures, then
 * STORE-zip the blobs (PDFs are already compressed, so deflate would just burn
 * CPU for nothing) and trigger a single download.
 *
 * A single successful item downloads as a bare .pdf — no pointless one-file zip.
 */
import { zipSync } from 'fflate';

export interface BulkPdfOptions<T> {
  /** Items to render — typically the selected rows. */
  items: T[];
  /**
   * Render one item to a PDF Blob plus its file name (WITHOUT the `.pdf`
   * extension). May fetch data and may throw — a throwing item is skipped and
   * reported in `failed`. The name is returned here (not derived from the item)
   * so it can use data only available after fetching, e.g. an invoice number.
   */
  render: (item: T) => Promise<{ blob: Blob; name: string }>;
  /** Name for the downloaded zip, WITHOUT the `.zip` extension. */
  zipName: string;
  /** Max documents rendered concurrently. Default 3. */
  concurrency?: number;
  /** Called after each item settles (success or failure). */
  onProgress?: (done: number, total: number) => void;
}

export interface BulkPdfResult<T> {
  ok: number;
  failed: Array<{ item: T; error: unknown }>;
}

/**
 * Wrap raw bytes in a Blob. The cast bridges a lib typing gap: under TS 5.7+
 * `Uint8Array` is generic over `ArrayBufferLike`, which `BlobPart` doesn't
 * accept directly even though the runtime handles it fine.
 */
function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes as unknown as BlobPart], { type });
}

function triggerDownload(bytes: Uint8Array, type: string, filename: string): void {
  const url = URL.createObjectURL(bytesToBlob(bytes, type));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Sanitize a file name segment for a zip entry / download filename. */
function safeName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '-').trim() || 'document';
}

export async function bulkDownloadPdfs<T>(opts: BulkPdfOptions<T>): Promise<BulkPdfResult<T>> {
  const { items, render, zipName, concurrency = 3, onProgress } = opts;
  const total = items.length;
  const rendered: Array<{ name: string; bytes: Uint8Array }> = [];
  const failed: Array<{ item: T; error: unknown }> = [];

  if (total === 0) return { ok: 0, failed };

  // Bounded-concurrency worker pool over a shared cursor — preserves input
  // order in `rendered` by writing into a fixed-size slot array.
  const slots: Array<{ name: string; bytes: Uint8Array } | null> = new Array(total).fill(null);
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= total) return;
      const item = items[i];
      try {
        const { blob, name } = await render(item);
        slots[i] = { name: safeName(name), bytes: new Uint8Array(await blob.arrayBuffer()) };
      } catch (error) {
        failed.push({ item, error });
      } finally {
        done++;
        onProgress?.(done, total);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

  for (const slot of slots) if (slot) rendered.push(slot);

  if (rendered.length === 0) return { ok: 0, failed };

  // One file → plain PDF; many → a STORE zip (level 0, PDFs already compressed).
  if (rendered.length === 1) {
    triggerDownload(rendered[0].bytes, 'application/pdf', `${rendered[0].name}.pdf`);
    return { ok: 1, failed };
  }

  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const r of rendered) {
    let entry = `${r.name}.pdf`;
    let n = 2;
    while (used.has(entry)) entry = `${r.name} (${n++}).pdf`;
    used.add(entry);
    files[entry] = r.bytes;
  }
  const zipped = zipSync(files, { level: 0 });
  triggerDownload(zipped, 'application/zip', `${safeName(zipName)}.zip`);
  return { ok: rendered.length, failed };
}
