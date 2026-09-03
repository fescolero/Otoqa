'use client';

/**
 * ExportAllDocumentsButton — download every document the org owns as one
 * zip (documents-storage-spec.md §7). Regulatory retention for driver
 * qualification files outlives the platform relationship, so the export
 * is an explicit, always-available action — not something assumed at
 * offboarding.
 *
 * Runs entirely in the browser: lists documents (settings:manage), fetches
 * each file through a short-lived signed GET, and packs them into a zip
 * with fflate (stored, level 0 — PDFs and JPEGs are already compressed).
 * A manifest.csv is included. Needs the bucket CORS rule to
 * allow GET from the web origin (it does; spec §1).
 */

import * as React from 'react';
import { useAction, useConvex } from 'convex/react';
import { toast } from 'sonner';
import { zipSync, strToU8 } from 'fflate';

import { api } from '@/convex/_generated/api';
import { WBtn } from '@/components/web';
import { convexErrorMessage } from '@/lib/convex-error';

interface Progress {
  done: number;
  total: number;
  failed: number;
}

function safe(part: string | undefined, fallback = 'unknown'): string {
  return (part || fallback).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ExportAllDocumentsButton({ orgLabel }: { orgLabel?: string }) {
  const convex = useConvex();
  const entityDownload = useAction(api.organizationDocuments.getDownloadUrl);
  const loadDownload = useAction(api.s3Upload.getDocumentDownloadUrl);
  const [progress, setProgress] = React.useState<Progress | null>(null);

  const run = async () => {
    setProgress({ done: 0, total: 0, failed: 0 });
    try {
      const [entityDocs, loadDocs] = await Promise.all([
        convex.query(api.entityDocuments.listAllForOrgExport, {}),
        convex.query(api.loadDocuments.listAllForOrgExport, {}),
      ]);
      const loadFiles = loadDocs.filter((d) => d.hasFile);
      const total = entityDocs.length + loadFiles.length;
      if (total === 0) {
        toast.message('No documents to export yet.');
        setProgress(null);
        return;
      }
      setProgress({ done: 0, total, failed: 0 });

      const files: Record<string, Uint8Array> = {};
      const manifest: string[][] = [
        ['path', 'kind', 'entity', 'entityName', 'type', 'status', 'issueDate', 'expirationDate', 'uploadedAt'],
      ];
      let done = 0;
      let failed = 0;

      const add = async (path: string, url: string) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        let unique = path;
        for (let i = 2; files[unique]; i++) unique = path.replace(/(\.[^.]*)?$/, `-${i}$1`);
        files[unique] = new Uint8Array(await res.arrayBuffer());
      };

      for (const d of entityDocs) {
        const path = `${d.entity}/${safe(d.entityName)}/${d.status === 'archived' ? 'archived/' : ''}${safe(d.typeKey)}-${safe(d.fileName, 'file')}`;
        try {
          const { url } = await entityDownload({ docId: d.docId, download: true });
          await add(path, url);
          manifest.push([path, 'entity', d.entity, d.entityName, d.typeKey, d.status, d.issueDate ?? '', d.expirationDate ?? '', new Date(d.uploadedAt).toISOString()]);
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
          await add(path, url);
          manifest.push([path, 'load', 'load', d.orderNumber ?? d.loadId, d.type, 'active', '', '', new Date(d.uploadedAt).toISOString()]);
        } catch (e) {
          failed++;
          console.warn('[export] skipped', path, e);
        }
        done++;
        setProgress({ done, total, failed });
      }

      files['manifest.csv'] = strToU8(manifest.map((r) => r.map(csvCell).join(',')).join('\n'));
      const bytes = zipSync(files, { level: 0 });

      const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${safe(orgLabel, 'otoqa')}-documents-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      toast.success(failed ? `Exported ${done - failed} of ${total} documents (${failed} could not be fetched)` : `Exported ${total} documents`);
    } catch (e) {
      toast.error(convexErrorMessage(e) ?? (e instanceof Error ? e.message : 'Export failed'));
    } finally {
      setProgress(null);
    }
  };

  return (
    <WBtn size="sm" variant="ghost" leading="export" onClick={run} disabled={progress !== null}>
      {progress
        ? progress.total
          ? `Exporting ${progress.done}/${progress.total}…`
          : 'Preparing…'
        : 'Export all documents'}
    </WBtn>
  );
}
