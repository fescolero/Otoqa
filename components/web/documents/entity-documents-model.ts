/**
 * Pure view-model for an entity's Documents surfaces (tab, overview
 * section, attention items) — drivers, carrier partnerships, and the
 * org's own company file. No React, no Convex — testable in the `web`
 * vitest project. Status itself comes from the shared module so every
 * surface agrees (documents-storage-spec.md §3, §6.3).
 */

import type { FunctionReturnType } from 'convex/server';
import type { api } from '@/convex/_generated/api';
import type { ChipStatus } from '@/components/web/chip';
import {
  DOCUMENT_STATUS_LABEL,
  computeDocumentStatus,
  dateExpiryStatus,
  needsAttention,
  pickEffectiveDocument,
  type DocumentStatus,
  type EffectiveDocumentType,
} from '@/convex/_helpers/documentStatus';

export type EntityDocumentsList = FunctionReturnType<typeof api.entityDocuments.listForEntity>;
export type EntityDocument = EntityDocumentsList['documents'][number];
export type SharedDocument = EntityDocumentsList['shared'][number];

export type DocumentSource = 'own' | 'shared';

export interface DocumentRowModel {
  /** Stable row id: the type key for singleton/missing rows, type+doc for
   *  multi-document types. */
  id: string;
  type: EffectiveDocumentType;
  /** The effective document backing this row, or null when Missing. */
  doc: EntityDocument | SharedDocument | null;
  /** Where the effective document came from: the entity's own records or
   *  (partnerships only) the linked carrier's shared company file. */
  source: DocumentSource | null;
  status: DocumentStatus;
  /** Partnerships: the broker's own active row when a shared document won
   *  (so the tab can still offer Replace/Archive on it). */
  ownDoc: EntityDocument | null;
  /** For Missing rows: the most recently archived document of the type,
   *  so the tab can show "last expired …" context (spec §5.3). */
  lastArchived: EntityDocument | null;
  lastArchivedStatus: 'expired' | 'expiring' | 'warning' | 'valid' | 'missing' | null;
}

export interface DocumentCounts {
  total: number;
  onFile: number;
  valid: number;
  expiring: number;
  expired: number;
  missing: number;
}

export interface DocumentsViewModel {
  rows: DocumentRowModel[];
  archived: EntityDocument[];
  counts: DocumentCounts;
  /** Rows whose status needs attention (missing / needs date / expired /
   *  expiring). */
  attention: number;
}

export function isSharedDocument(d: EntityDocument | SharedDocument): d is SharedDocument {
  return 'sharedFromOrgId' in d;
}

export function composeDocumentsViewModel(
  types: readonly EffectiveDocumentType[],
  documents: readonly EntityDocument[],
  todayStr: string,
  shared: readonly SharedDocument[] = [],
): DocumentsViewModel {
  const visible = types.filter((t) => !t.hidden).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const active = documents.filter((d) => d.status === 'active');
  const archived = documents
    .filter((d) => d.status === 'archived')
    .slice()
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));

  const rows: DocumentRowModel[] = [];
  for (const type of visible) {
    const ownDocs = active
      .filter((d) => d.typeKey === type.key)
      .sort((a, b) => (b.activatedAt ?? b.uploadedAt) - (a.activatedAt ?? a.uploadedAt));
    const sharedDocs = shared.filter((s) => s.partnerTypeKey === type.key);

    if (type.singleton || sharedDocs.length > 0) {
      // One row: the effective document across own + shared (§6.3).
      const eff = pickEffectiveDocument(type, ownDocs.slice(0, 1), sharedDocs.slice(0, 1));
      if (!eff) {
        rows.push(missingRow(type, archived, todayStr));
        continue;
      }
      rows.push({
        id: type.key,
        type,
        doc: eff.doc,
        source: eff.source,
        status: computeDocumentStatus(type, { expirationDate: eff.doc.expirationDate, hasFile: eff.doc.hasFile }, todayStr),
        ownDoc: ownDocs[0] ?? null,
        lastArchived: null,
        lastArchivedStatus: null,
      });
      continue;
    }

    if (ownDocs.length === 0) {
      rows.push(missingRow(type, archived, todayStr));
      continue;
    }
    for (const doc of ownDocs) {
      rows.push({
        id: `${type.key}:${doc._id}`,
        type,
        doc,
        source: 'own',
        status: computeDocumentStatus(type, { expirationDate: doc.expirationDate, hasFile: doc.hasFile }, todayStr),
        ownDoc: doc,
        lastArchived: null,
        lastArchivedStatus: null,
      });
    }
  }

  const counts: DocumentCounts = { total: rows.length, onFile: 0, valid: 0, expiring: 0, expired: 0, missing: 0 };
  let attention = 0;
  for (const r of rows) {
    // A row can hold a document and still be Missing (a date-only entry
    // after uploadRequired flipped back on) — never count it under both.
    if (r.doc && r.status !== 'missing') counts.onFile++;
    switch (r.status) {
      case 'valid':
      case 'warning':
      case 'on_file':
        counts.valid++;
        break;
      case 'expiring':
        counts.expiring++;
        break;
      case 'expired':
        counts.expired++;
        break;
      case 'missing':
      case 'needs_date':
        counts.missing++;
        break;
    }
    if (needsAttention(r.status)) attention++;
  }

  return { rows, archived, counts, attention };
}

function missingRow(
  type: EffectiveDocumentType,
  archived: readonly EntityDocument[],
  todayStr: string,
): DocumentRowModel {
  const lastArchived = archived.find((d) => d.typeKey === type.key) ?? null;
  return {
    id: type.key,
    type,
    doc: null,
    source: null,
    status: 'missing',
    ownDoc: null,
    lastArchived,
    lastArchivedStatus: lastArchived ? dateExpiryStatus(lastArchived.expirationDate, todayStr) : null,
  };
}

// ─── Presentation helpers ────────────────────────────────────────────────

export function chipForStatus(status: DocumentStatus): { status: ChipStatus; label: string } {
  switch (status) {
    case 'missing':
      return { status: 'danger', label: DOCUMENT_STATUS_LABEL.missing };
    case 'needs_date':
      return { status: 'warning', label: DOCUMENT_STATUS_LABEL.needs_date };
    case 'expired':
      return { status: 'expired', label: DOCUMENT_STATUS_LABEL.expired };
    case 'expiring':
      return { status: 'expiring', label: DOCUMENT_STATUS_LABEL.expiring };
    case 'warning':
      return { status: 'warning', label: 'Renew soon' };
    case 'on_file':
      return { status: 'valid', label: DOCUMENT_STATUS_LABEL.on_file };
    case 'valid':
    default:
      return { status: 'valid', label: DOCUMENT_STATUS_LABEL.valid };
  }
}

/** Compliance micro-bar chips only know valid/expiring/expired/na. */
export function complianceChipForStatus(status: DocumentStatus): 'valid' | 'expiring' | 'expired' | 'na' {
  switch (status) {
    case 'expired':
    case 'missing':
      return 'expired';
    case 'expiring':
    case 'needs_date':
    case 'warning':
      return 'expiring';
    default:
      return 'valid';
  }
}

export function formatYmd(ymd?: string | null): string {
  if (!ymd) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** A stored timestamp shown as the viewer's calendar day (not UTC's). */
export function formatTimestamp(ms?: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return formatYmd(ymd);
}

export function formatBytes(n?: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
