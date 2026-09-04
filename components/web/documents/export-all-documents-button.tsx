'use client';

/**
 * ExportAllDocumentsButton — download every document the org owns as one
 * zip (documents-storage-spec.md §7). Regulatory retention for driver
 * qualification files outlives the platform relationship, so the export
 * is an explicit, always-available action — not something assumed at
 * offboarding.
 *
 * Runs entirely in the browser: lists documents (settings:manage), fetches
 * each file through a short-lived export-scoped signed GET, and packs
 * them into a zip with fflate (stored, level 0 — PDFs and JPEGs are
 * already compressed). A manifest.csv is included. Needs the bucket CORS
 * rule to allow GET from the web origin (it does; spec §1).
 *
 * Memory: the whole zip is built in memory (fflate 0.4 has no streaming
 * writer), so the export is cut into parts of at most PART_LIMIT bytes —
 * each part becomes a Blob (browser-managed, off the JS heap) before the
 * next is filled. A small org gets one file that downloads on its own; a
 * large one gets `-part1`, `-part2`, … offered as buttons, because
 * browsers block a second automatic download with no click behind it.
 */

import * as React from 'react';
import { useAction, useConvex } from 'convex/react';
import { toast } from 'sonner';
import { zipSync, strToU8 } from 'fflate';

import { api } from '@/convex/_generated/api';
import { sanitizeFilename } from '@/convex/lib/r2';
import { WBtn } from '@/components/web';
import { convexErrorMessage } from '@/lib/convex-error';

interface Progress {
  done: number;
  total: number;
  failed: number;
}

/** Max bytes held for one zip part (the browser holds ~2× this at zip time). */
const PART_LIMIT = 200 * 1024 * 1024;

const MANIFEST_HEADER = ['path', 'kind', 'entity', 'entityName', 'type', 'status', 'issueDate', 'expirationDate', 'uploadedAt'];

/** Same sanitizer the stored keys use, so zip entries match file names. */
function safe(part: string | undefined, fallback = 'unknown'): string {
  return sanitizeFilename(part ?? '', fallback);
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

interface ZipPart {
  name: string;
  url: string;
}

function triggerDownload(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ExportAllDocumentsButton({ orgLabel }: { orgLabel?: string }) {
  const convex = useConvex();
  const entityDownload = useAction(api.organizationDocuments.getExportDownloadUrl);
  const loadDownload = useAction(api.s3Upload.getDocumentDownloadUrl);
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const [parts, setParts] = React.useState<ZipPart[]>([]);

  const clearParts = React.useCallback(() => {
    setParts((cur) => {
      for (const p of cur) URL.revokeObjectURL(p.url);
      return [];
    });
  }, []);
  React.useEffect(() => clearParts, [clearParts]); // release on unmount

  const run = async () => {
    clearParts();
    setProgress({ done: 0, total: 0, failed: 0 });
    try {
      // Both listings are paged (a long-lived org has more rows than one
      // query may read); walk the cursors before fetching any bytes.
      const entityDocs = [];
      for (let cursor: string | null = null; ; ) {
        const page: Awaited<ReturnType<typeof convex.query<typeof api.entityDocuments.listAllForOrgExport>>> =
          await convex.query(api.entityDocuments.listAllForOrgExport, { cursor: cursor ?? undefined });
        entityDocs.push(...page.rows);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      const loadDocs = [];
      for (let cursor: string | null = null; ; ) {
        const page: Awaited<ReturnType<typeof convex.query<typeof api.loadDocuments.listAllForOrgExport>>> =
          await convex.query(api.loadDocuments.listAllForOrgExport, { cursor: cursor ?? undefined });
        loadDocs.push(...page.rows);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      const loadFiles = loadDocs.filter((d) => d.hasFile);
      const total = entityDocs.length + loadFiles.length;
      if (total === 0) {
        toast.message('No documents to export yet.');
        setProgress(null);
        return;
      }
      setProgress({ done: 0, total, failed: 0 });

      let files: Record<string, Uint8Array> = {};
      let manifest: string[][] = [MANIFEST_HEADER];
      let partBytes = 0;
      let done = 0;
      let failed = 0;
      const stamp = new Date().toISOString().slice(0, 10);
      const built: ZipPart[] = [];

      const flush = () => {
        if (Object.keys(files).length === 0) return;
        files['manifest.csv'] = strToU8(manifest.map((r) => r.map(csvCell).join(',')).join('\n'));
        const bytes = zipSync(files, { level: 0 });
        const n = built.length + 1;
        built.push({
          name: `${safe(orgLabel, 'otoqa')}-documents-${stamp}-part${n}.zip`,
          url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' })),
        });
        files = {};
        manifest = [MANIFEST_HEADER];
        partBytes = 0;
      };

      const add = async (path: string, url: string, row: string[]) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (partBytes > 0 && partBytes + bytes.byteLength > PART_LIMIT) flush();
        let unique = path;
        // Suffix the file name, never a dotted folder segment ("J.B._Hunt").
        for (let i = 2; files[unique]; i++) unique = path.replace(/(\.[^./]*)?$/, `-${i}$1`);
        files[unique] = bytes;
        partBytes += bytes.byteLength;
        manifest.push([unique, ...row.slice(1)]);
      };

      for (const d of entityDocs) {
        const path = `${d.entity}/${safe(d.entityName)}/${d.status === 'archived' ? 'archived/' : ''}${safe(d.typeKey)}-${safe(d.fileName, 'file')}`;
        try {
          const { downloadUrl } = await entityDownload({ docId: d.docId });
          await add(path, downloadUrl, [path, 'entity', d.entity, d.entityName, d.typeKey, d.status, d.issueDate ?? '', d.expirationDate ?? '', new Date(d.uploadedAt).toISOString()]);
        } catch (e) {
          failed++;
          console.warn('[export] skipped', path, e);
        }
        done++;
        setProgress({ done, total, failed });
      }
      for (const d of loadFiles) {
        const path = `loads/${safe(d.orderNumber ?? d.loadId)}/${safe(d.type)}-${safe(d.fileName, 'file')}`;
        try {
          const { url } = await loadDownload({ documentId: d.documentId });
          if (!url) throw new Error('no url');
          await add(path, url, [path, 'load', 'load', d.orderNumber ?? d.loadId, d.type, 'active', '', '', new Date(d.uploadedAt).toISOString()]);
        } catch (e) {
          failed++;
          console.warn('[export] skipped', path, e);
        }
        done++;
        setProgress({ done, total, failed });
      }

      flush();
      const fetched = failed ? `${done - failed} of ${total} documents (${failed} could not be fetched)` : `${total} documents`;
      if (built.length === 1) {
        // One file: the click that started the export covers this download.
        // The URL stays alive (and a "Download again" button offered) until
        // Done — revoking on a timer would abort a slow Save-As dialog.
        const only = { ...built[0], name: built[0].name.replace(/-part1\.zip$/, '.zip') };
        setParts([only]);
        triggerDownload(only.url, only.name);
        toast.success(`Exported ${fetched}`);
      } else if (built.length > 1) {
        // Several files: browsers block automatic downloads after the first,
        // so offer each part as its own button.
        setParts(built);
        toast.success(`Exported ${fetched} in ${built.length} zip files — download each part below`);
      } else {
        toast.error('Nothing could be exported.');
      }
    } catch (e) {
      toast.error(convexErrorMessage(e) ?? (e instanceof Error ? e.message : 'Export failed'));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <WBtn size="sm" variant="ghost" leading="export" onClick={run} disabled={progress !== null}>
        {progress
          ? progress.total
            ? `Exporting ${progress.done}/${progress.total}…`
            : 'Preparing…'
          : 'Export all documents'}
      </WBtn>
      {parts.map((p, i) => (
        <WBtn key={p.url} size="sm" variant="primary" leading="export" onClick={() => triggerDownload(p.url, p.name)}>
          {parts.length === 1 ? 'Download again' : `Download part ${i + 1} of ${parts.length}`}
        </WBtn>
      ))}
      {parts.length > 0 && (
        <WBtn size="sm" variant="ghost" onClick={clearParts}>
          Done
        </WBtn>
      )}
    </div>
  );
}
