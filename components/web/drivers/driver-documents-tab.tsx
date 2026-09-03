'use client';

/**
 * Driver Detail — Documents tab (full-page).
 *
 * Layout per design Otoqa Web.html § DvDocsFullPage:
 *   • 5-stat summary strip — On file · Valid · Expiring · Expired · Missing
 *   • Active documents card — FilterBar (Category + Status) + Upload;
 *     one row per visible document type (plus one per document for
 *     multi-document types), status from the shared status module
 *   • Archived & replaced card — superseded and archived rows
 *
 * Backed by entityDocuments (docs/documents-storage-spec.md). A document
 * is a file plus a user-entered date; a type with no active document is
 * Missing. The four legacy driver date fields are mirrors written by the
 * backend on activation — this tab never edits them directly.
 */

import * as React from 'react';
import { useAction, useMutation } from 'convex/react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { convexErrorMessage } from '@/lib/convex-error';
import {
  Chip,
  DSCard,
  DSMiniTable,
  type DSMiniColumn,
  type DSRowAction,
  FilterBar,
  type FilterChipValue,
  type FilterProperty,
  WBtn,
} from '@/components/web';
import { DocPreviewModal, type DocRecord } from '@/components/loads/doc-preview-modal';

import { DocumentUploadDialog } from './document-upload-dialog';
import {
  chipForStatus,
  formatBytes,
  formatYmd,
  type DocumentRowModel,
  type EntityDocument,
} from './driver-documents-model';
import { useDriverDocuments } from './use-driver-documents';

interface DriverDocumentsTabProps {
  driverId: Id<'drivers'>;
  driverName?: string;
}

type ArchivedRow = EntityDocument & { id: string; typeName: string };

export function DriverDocumentsTab({ driverId, driverName }: DriverDocumentsTabProps) {
  const docs = useDriverDocuments(driverId);
  const archiveDoc = useMutation(api.entityDocuments.archive);
  const getDownloadUrl = useAction(api.driverDocuments.getDownloadUrl);

  const [filters, setFilters] = React.useState<FilterChipValue[]>([]);
  const [upload, setUpload] = React.useState<{ typeKey?: string; replacingName?: string } | null>(null);
  const [preview, setPreview] = React.useState<DocRecord | null>(null);

  const typeNames = React.useMemo(() => new Map(docs.types.map((t) => [t.key, t.name])), [docs.types]);

  const filtered = React.useMemo(() => {
    return docs.rows.filter((r) => {
      for (const f of filters) {
        if (!f.values || f.values.length === 0) continue;
        if (f.propId === 'type' && !f.values.includes(r.type.key)) return false;
        if (f.propId === 'st') {
          const bucket =
            r.status === 'missing' || r.status === 'needs_date' ? 'missing'
            : r.status === 'expired' ? 'expired'
            : r.status === 'expiring' ? 'expiring'
            : 'valid';
          if (!f.values.includes(bucket)) return false;
        }
      }
      return true;
    });
  }, [docs.rows, filters]);

  const filterProps: FilterProperty[] = [
    {
      id: 'type', label: 'Document', icon: 'file-text', kind: 'enum', operator: 'is any of',
      options: docs.types.filter((t) => !t.hidden).map((t) => ({ value: t.key, label: t.name })),
    },
    {
      id: 'st', label: 'Status', icon: 'shield', kind: 'enum', operator: 'is any of',
      options: [
        { value: 'valid',    label: 'Valid' },
        { value: 'expiring', label: 'Expiring' },
        { value: 'expired',  label: 'Expired' },
        { value: 'missing',  label: 'Missing' },
      ],
    },
  ];

  // ── Preview / download via short-lived signed GET ─────────────────────
  const openPreview = async (row: DocumentRowModel | ArchivedRow) => {
    const doc = 'doc' in row ? row.doc : row;
    if (!doc || !doc.hasFile) return;
    const typeName = 'type' in row ? row.type.name : row.typeName;
    const isPdf = !!doc.contentType?.includes('pdf');
    const record: DocRecord = {
      id: doc._id,
      name: `${typeName}${doc.fileName ? ` — ${doc.fileName}` : ''}`,
      src: doc.uploadedByName ?? 'Ops',
      when: formatYmd(new Date(doc.activatedAt ?? doc.uploadedAt).toISOString().slice(0, 10)),
      status: 'valid',
      preview: isPdf ? { kind: 'pdf', url: '' } : { kind: 'image', url: '' },
      activity: [
        { id: 'up', text: <>Uploaded by {doc.uploadedByName ?? 'ops'}</> },
        ...(doc.expirationDate ? [{ id: 'exp', text: <>Expires {formatYmd(doc.expirationDate)}</> }] : []),
        ...(doc.issueDate ? [{ id: 'iss', text: <>Issued {formatYmd(doc.issueDate)}</> }] : []),
        ...(doc.note ? [{ id: 'note', text: <>{doc.note}</> }] : []),
      ],
    };
    setPreview(record);
    try {
      const [view, download] = await Promise.all([
        getDownloadUrl({ docId: doc._id }),
        getDownloadUrl({ docId: doc._id, download: true }),
      ]);
      setPreview((cur) =>
        cur?.id === doc._id
          ? { ...cur, preview: { ...cur.preview, url: view.url }, openUrl: view.url, downloadUrl: download.url }
          : cur,
      );
    } catch (e) {
      toast.error((convexErrorMessage(e) ?? 'Could not open document'));
      setPreview(null);
    }
  };

  const onArchive = async (row: DocumentRowModel) => {
    if (!row.doc) return;
    const ok = window.confirm(
      `Archive ${row.type.name}? The driver will show "Missing" for this document until a new one is uploaded.`,
    );
    if (!ok) return;
    try {
      await archiveDoc({ docId: row.doc._id });
      toast.success(`${row.type.name} archived`);
    } catch (e) {
      toast.error((convexErrorMessage(e) ?? 'Failed to archive'));
    }
  };

  // ── Columns ────────────────────────────────────────────────────────────
  const cols: DSMiniColumn<DocumentRowModel>[] = [
    {
      key: 'name', label: 'Document', width: '1.6fr',
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate">{r.type.name}</div>
          {r.doc?.fileName ? (
            <div className="truncate text-[11px] text-[var(--text-tertiary)]">
              {r.doc.fileName} · {formatBytes(r.doc.sizeBytes)}
            </div>
          ) : r.status === 'missing' && r.lastArchived ? (
            <div className="truncate text-[11px] text-[var(--text-tertiary)]">
              Last on file {r.lastArchived.expirationDate ? `expired ${formatYmd(r.lastArchived.expirationDate)}` : 'archived'}
            </div>
          ) : r.status === 'missing' ? (
            <div className="text-[11px] text-[var(--text-tertiary)]">No file on record</div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'exp', label: 'Expires', width: '130px',
      render: (r) => (
        <span className="num">
          {r.type.expires
            ? r.doc?.expirationDate ? formatYmd(r.doc.expirationDate) : '—'
            : r.doc?.issueDate ? `Issued ${formatYmd(r.doc.issueDate)}` : '—'}
        </span>
      ),
    },
    {
      key: 'st', label: 'Status', width: '120px',
      render: (r) => {
        const c = chipForStatus(r.status);
        return <Chip status={c.status} label={c.label} />;
      },
    },
  ];

  const rowActions = (r: DocumentRowModel): DSRowAction[] => {
    const actions: DSRowAction[] = [];
    if (r.doc?.hasFile) actions.push({ label: 'View', icon: 'eye', onClick: () => void openPreview(r) });
    if (docs.canEdit) {
      actions.push({
        label: r.doc ? 'Replace' : 'Upload',
        icon: 'upload',
        onClick: () => setUpload({ typeKey: r.type.key, replacingName: r.doc ? r.type.name : undefined }),
      });
      if (r.doc) actions.push({ label: 'Archive', icon: 'archive', danger: true, onClick: () => void onArchive(r) });
    }
    return actions;
  };

  const archivedRows: ArchivedRow[] = docs.archived.map((d) => ({
    ...d,
    id: d._id,
    typeName: typeNames.get(d.typeKey) ?? d.typeKey,
  }));

  const archivedCols: DSMiniColumn<ArchivedRow>[] = [
    {
      key: 'name', label: 'Document', width: '1.6fr',
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate">{r.typeName}</div>
          {r.fileName && <div className="truncate text-[11px] text-[var(--text-tertiary)]">{r.fileName}</div>}
        </div>
      ),
    },
    {
      key: 'exp', label: 'Expired', width: '130px',
      render: (r) => <span className="num">{r.expirationDate ? formatYmd(r.expirationDate) : '—'}</span>,
    },
    {
      key: 'archivedAt', label: 'Archived', width: '120px',
      render: (r) => <span className="num">{r.archivedAt ? formatYmd(new Date(r.archivedAt).toISOString().slice(0, 10)) : '—'}</span>,
    },
    {
      key: 'note', label: 'Note', width: '180px',
      render: (r) => <span className="text-[var(--text-tertiary)]">{r.archiveNote ?? '—'}</span>,
    },
  ];

  return (
    <div className="flex flex-col gap-3.5">
      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 rounded-xl border border-[var(--border-hairline)] bg-card overflow-hidden">
        <DocStat label="On file"  value={docs.counts.onFile} />
        <DocStat label="Valid"    value={docs.counts.valid}    tone="ok"   divided />
        <DocStat label="Expiring" value={docs.counts.expiring} tone="warn" divided />
        <DocStat label="Expired"  value={docs.counts.expired}  tone="crit" divided />
        <DocStat label="Missing"  value={docs.counts.missing}  tone="crit" divided />
      </div>

      {/* Active documents */}
      <DSCard
        title={`Documents (${filtered.length})`}
        bodyClassName="p-0"
        action={
          <div className="flex items-center gap-2">
            <FilterBar properties={filterProps} value={filters} onChange={setFilters} slot="trigger" />
            {docs.canEdit && (
              <WBtn size="sm" variant="primary" leading="plus" onClick={() => setUpload({})}>
                Upload
              </WBtn>
            )}
          </div>
        }
      >
        {filters.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap px-3.5 py-2 border-b border-[var(--border-hairline)] bg-[var(--bg-surface-2)]">
            <FilterBar properties={filterProps} value={filters} onChange={setFilters} slot="chips" />
            <div className="flex-1" />
            <FilterBar properties={filterProps} value={filters} onChange={setFilters} slot="trigger" />
          </div>
        )}
        <DSMiniTable<DocumentRowModel>
          columns={cols}
          rows={filtered}
          total={filtered.length}
          rowActions={rowActions}
          onRowClick={(r) => {
            if (r.doc?.hasFile) void openPreview(r);
            else if (docs.canEdit) setUpload({ typeKey: r.type.key });
          }}
          className="rounded-t-none border-0 border-t"
        />
        {!docs.loading && docs.rows.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-[var(--text-tertiary)]">
            No document types are enabled. Add or unhide types in Settings › Documents.
          </div>
        )}
      </DSCard>

      {/* Archived & replaced */}
      <DSCard title={`Archived & replaced (${archivedRows.length})`} bodyClassName="p-0">
        <DSMiniTable<ArchivedRow>
          columns={archivedCols}
          rows={archivedRows}
          total={archivedRows.length}
          rowActions={(r) => (r.hasFile ? [{ label: 'View', icon: 'eye', onClick: () => void openPreview(r) }] : [])}
          onRowClick={(r) => r.hasFile && void openPreview(r)}
          className="rounded-t-none border-0 border-t"
        />
        {archivedRows.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-[var(--text-tertiary)]">
            No archived documents yet. Replaced and archived documents are kept here.
          </div>
        )}
      </DSCard>

      <DocumentUploadDialog
        open={upload !== null}
        onOpenChange={(o) => !o && setUpload(null)}
        driverId={driverId}
        types={docs.types}
        initialTypeKey={upload?.typeKey}
        replacingName={upload?.replacingName}
        driverName={driverName}
      />

      <DocPreviewModal doc={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

// ─── Bits ────────────────────────────────────────────────────────────────

function DocStat({
  label,
  value,
  tone,
  divided,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'warn' | 'crit';
  divided?: boolean;
}) {
  const color =
    tone === 'ok' ? '#0F8C5F' :
    tone === 'warn' ? '#B45309' :
    tone === 'crit' ? '#B43030' :
    'var(--text-primary)';
  return (
    <div
      className="px-4 py-3.5"
      style={{ borderLeft: divided ? '1px solid var(--border-hairline)' : 'none' }}
    >
      <div className="text-[11px] uppercase tracking-[0.04em] text-[var(--text-tertiary)] mb-1">
        {label}
      </div>
      <div className="num text-[22px] leading-[26px] font-medium" style={{ color: value === 0 && tone === 'crit' ? 'var(--text-primary)' : color }}>
        {value}
      </div>
    </div>
  );
}
