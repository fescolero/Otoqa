'use client';

/**
 * EntityDocumentsTab — the Documents surface for a driver, a carrier
 * partnership, or the org's own company file.
 *
 * Layout per design Otoqa Web.html § DvDocsFullPage:
 *   • 5-stat summary strip — On file · Valid · Expiring · Expired · Missing
 *   • Documents card — FilterBar (Document + Status) + Upload; one row per
 *     visible document type (plus one per document for multi-document
 *     types), status from the shared status module
 *   • Archived & replaced card — superseded and archived rows
 *
 * Partnerships also show the linked carrier's shared company documents:
 * when a shared document is the effective one for a type (latest expiry
 * wins, spec §6.3) the row is read-only with source "Carrier", and the
 * broker can still add its own record alongside. The company file adds a
 * per-document Share/Withhold action (spec §6.2).
 *
 * Backed by entityDocuments (docs/documents-storage-spec.md). A document
 * is a file plus a user-entered date; a type with no active document is
 * Missing. Mirror date fields on the parent are written by the backend.
 */

import * as React from 'react';
import { useAction, useMutation } from 'convex/react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
import type { DocumentEntity } from '@/convex/lib/documentTypeDefaults';
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
  WIcon,
} from '@/components/web';
import type { Id } from '@/convex/_generated/dataModel';
import { DocPreviewModal, type DocRecord } from '@/components/loads/doc-preview-modal';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { DateInput } from '@/components/ui/date-input';

import { DocumentUploadDialog } from './document-upload-dialog';
import {
  chipForStatus,
  formatBytes,
  formatTimestamp,
  formatYmd,
  isSharedDocument,
  type DocumentRowModel,
  type EntityDocument,
  type SharedDocument,
} from './entity-documents-model';
import { useEntityDocuments } from './use-entity-documents';

export interface EntityDocumentsTabProps {
  entity: DocumentEntity;
  entityId: string;
  /** Display name of the entity, used in dialog titles. */
  entityName?: string;
}

type ArchivedRow = EntityDocument & { id: string; typeName: string };
type AnyDoc = EntityDocument | SharedDocument;
type CopyTarget = { row: DocumentRowModel; doc: SharedDocument };
type CopyDates = { issueDate?: string; expirationDate?: string };

/** The copy activates under OUR carrier type, whose flags may require a
 *  date the carrier's copy never carried (spec §7). */
function missingCopyDates(target: CopyTarget): { issue: boolean; expiry: boolean } {
  return {
    issue: !!target.row.type.issueDateRequired && !target.doc.issueDate,
    expiry: !!target.row.type.expires && !target.doc.expirationDate,
  };
}

export function EntityDocumentsTab({ entity, entityId, entityName }: EntityDocumentsTabProps) {
  const docs = useEntityDocuments(entity, entityId);
  const archiveDoc = useMutation(api.entityDocuments.archive);
  const setShared = useMutation(api.entityDocuments.setShared);
  const saveSharedCopy = useAction(api.carrierDocuments.saveSharedCopy);
  const [copying, setCopying] = React.useState<string | null>(null);
  const [copyTarget, setCopyTarget] = React.useState<CopyTarget | null>(null);
  const download = {
    driver: useAction(api.driverDocuments.getDownloadUrl),
    carrier: useAction(api.carrierDocuments.getDownloadUrl),
    organization: useAction(api.organizationDocuments.getDownloadUrl),
  }[entity];

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
        if (f.propId === 'src' && !f.values.includes(r.source ?? 'none')) return false;
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
    ...(entity === 'carrier'
      ? [{
          id: 'src', label: 'Source', icon: 'handshake' as const, kind: 'enum' as const, operator: 'is any of' as const,
          options: [
            { value: 'own',    label: 'Our records' },
            { value: 'shared', label: 'Carrier shared' },
          ],
        }]
      : []),
  ];

  // ── Preview / download via short-lived signed GET ─────────────────────
  const openPreview = async (doc: AnyDoc | null, typeName: string) => {
    if (!doc || !doc.hasFile) return;
    const isPdf = !!doc.contentType?.includes('pdf');
    const shared = isSharedDocument(doc);
    const record: DocRecord = {
      id: doc._id,
      name: `${typeName}${doc.fileName ? ` — ${doc.fileName}` : ''}`,
      src: shared ? doc.sharedFromOrgName : doc.uploadedByName ?? 'Ops',
      when: formatTimestamp(doc.activatedAt ?? doc.uploadedAt),
      status: 'valid',
      preview: isPdf ? { kind: 'pdf', url: '' } : { kind: 'image', url: '' },
      activity: [
        {
          id: 'up',
          text: shared ? <>Shared by {doc.sharedFromOrgName}</> : <>Uploaded by {doc.uploadedByName ?? 'ops'}</>,
        },
        ...(doc.expirationDate ? [{ id: 'exp', text: <>Expires {formatYmd(doc.expirationDate)}</> }] : []),
        ...(doc.issueDate ? [{ id: 'iss', text: <>Issued {formatYmd(doc.issueDate)}</> }] : []),
        ...(doc.note ? [{ id: 'note', text: <>{doc.note}</> }] : []),
      ],
    };
    setPreview(record);
    try {
      const signed = await download({ docId: doc._id });
      setPreview((cur) =>
        cur?.id === doc._id
          ? { ...cur, preview: { ...cur.preview, url: signed.url }, openUrl: signed.url, downloadUrl: signed.downloadUrl }
          : cur,
      );
    } catch (e) {
      toast.error(convexErrorMessage(e) ?? 'Could not open document');
      setPreview(null);
    }
  };

  const onArchive = async (row: DocumentRowModel) => {
    const own = row.ownDoc;
    if (!own) return;
    const ok = window.confirm(
      `Archive ${row.type.name}? ${
        entity === 'carrier' && row.source === 'shared'
          ? 'The carrier-shared copy will remain in effect.'
          : 'This record will show "Missing" for this document until a new one is uploaded.'
      }`,
    );
    if (!ok) return;
    try {
      await archiveDoc({ docId: own._id });
      toast.success(`${row.type.name} archived`);
    } catch (e) {
      toast.error(convexErrorMessage(e) ?? 'Failed to archive');
    }
  };

  const performSaveCopy = async (target: CopyTarget, dates?: CopyDates) => {
    setCopying(target.row.id);
    try {
      await saveSharedCopy({
        partnershipId: entityId as Id<'carrierPartnerships'>,
        sharedDocId: target.doc._id,
        ...dates,
      });
      toast.success(`${target.row.type.name} saved to your records`);
      setCopyTarget(null);
    } catch (e) {
      toast.error(convexErrorMessage(e) ?? 'Could not save a copy');
    } finally {
      setCopying(null);
    }
  };

  const onSaveCopy = (row: DocumentRowModel) => {
    if (entity !== 'carrier' || !row.doc || !isSharedDocument(row.doc)) return;
    const target: CopyTarget = { row, doc: row.doc };
    const missing = missingCopyDates(target);
    // Ask for any date our type requires before copying — the server
    // refuses the copy without it, and there is nowhere else to enter it.
    if (missing.issue || missing.expiry) setCopyTarget(target);
    else void performSaveCopy(target);
  };

  const onToggleShare = async (row: DocumentRowModel) => {
    const own = row.ownDoc;
    if (!own || own.shared === undefined) return;
    try {
      await setShared({ docId: own._id, shared: !own.shared });
      toast.success(own.shared ? `${row.type.name} withheld from linked brokers` : `${row.type.name} shared with linked brokers`);
    } catch (e) {
      toast.error(convexErrorMessage(e) ?? 'Failed to update sharing');
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
    ...(entity === 'carrier'
      ? [{
          key: 'src', label: 'Source', width: '120px',
          render: (r: DocumentRowModel) =>
            r.source === 'shared' ? (
              <Chip status="assigned" label="Carrier" />
            ) : r.source === 'own' ? (
              <span className="text-[12px] text-[var(--text-secondary)]">Our records</span>
            ) : (
              <span className="text-[12px] text-[var(--text-tertiary)]">—</span>
            ),
        } satisfies DSMiniColumn<DocumentRowModel>]
      : []),
    ...(entity === 'organization'
      ? [{
          key: 'shared', label: 'Shared', width: '110px',
          render: (r: DocumentRowModel) =>
            r.ownDoc && r.ownDoc.shared !== undefined ? (
              r.ownDoc.shared ? <Chip status="assigned" label="Shared" /> : <Chip status="inactive" label="Withheld" />
            ) : (
              <span className="text-[12px] text-[var(--text-tertiary)]">—</span>
            ),
        } satisfies DSMiniColumn<DocumentRowModel>]
      : []),
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
    if (r.doc?.hasFile) actions.push({ label: 'View', icon: 'eye', onClick: () => void openPreview(r.doc, r.type.name) });
    if (r.source === 'shared' && r.ownDoc?.hasFile) {
      actions.push({ label: 'View our copy', icon: 'eye', onClick: () => void openPreview(r.ownDoc, r.type.name) });
    }
    if (docs.canEdit && docs.linkedCarrierOffboarding && r.source === 'shared' && r.doc && isSharedDocument(r.doc)) {
      actions.push({
        label: copying === r.id ? 'Saving…' : 'Save a copy',
        icon: 'copy',
        onClick: () => onSaveCopy(r),
      });
    }
    if (docs.canEdit) {
      // Only singleton types supersede on upload; multi-document types
      // (drug screens…) keep every active row, so the verb is "Add another".
      const replaces = !!r.ownDoc && r.type.singleton;
      actions.push({
        label: replaces ? 'Replace' : r.ownDoc ? 'Add another' : r.source === 'shared' ? 'Add our own' : 'Upload',
        icon: 'upload',
        onClick: () => setUpload({ typeKey: r.type.key, replacingName: replaces ? r.type.name : undefined }),
      });
      if (r.ownDoc) actions.push({ label: 'Archive', icon: 'archive', danger: true, onClick: () => void onArchive(r) });
    }
    if (entity === 'organization' && docs.canShare && r.ownDoc && r.ownDoc.shared !== undefined) {
      actions.push({
        label: r.ownDoc.shared ? 'Withhold from brokers' : 'Share with brokers',
        icon: 'handshake',
        onClick: () => void onToggleShare(r),
      });
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
      render: (r) => <span className="num">{formatTimestamp(r.archivedAt)}</span>,
    },
    {
      key: 'note', label: 'Note', width: '180px',
      render: (r) => <span className="text-[var(--text-tertiary)]">{r.archiveNote ?? '—'}</span>,
    },
  ];

  const emptyCopy =
    entity === 'carrier'
      ? 'No document types are enabled for carriers. Add or unhide types in Settings › Documents.'
      : entity === 'organization'
        ? 'No company document types are enabled. Add or unhide types in Settings › Documents.'
        : 'No document types are enabled. Add or unhide types in Settings › Documents.';

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

      {entity === 'carrier' && docs.linkedCarrierOffboarding && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-xl border px-3.5 py-2.5 text-[12.5px]"
          style={{ borderColor: 'rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.06)' }}
        >
          <WIcon name="alert" size={14} style={{ color: '#B43030' }} />
          <span>
            <strong className="font-medium">{docs.linkedCarrierName ?? 'This carrier'}</strong> is leaving Otoqa.
            Documents they share disappear on{' '}
            <span className="num font-medium">{formatTimestamp(docs.linkedCarrierOffboarding.purgeAt)}</span>.
            Use <em>Save a copy</em> on each shared row to keep it in your own records.
          </span>
        </div>
      )}
      {entity === 'carrier' && docs.linkedCarrierName && !docs.linkedCarrierOffboarding && (
        <p className="m-0 text-[12px] text-[var(--text-tertiary)]">
          Linked to <strong className="font-medium text-foreground">{docs.linkedCarrierName}</strong>. Documents they
          share appear here automatically; the latest expiry wins when you also keep your own copy.
        </p>
      )}

      {/* Documents */}
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
            if (r.doc?.hasFile) void openPreview(r.doc, r.type.name);
            else if (docs.canEdit) setUpload({ typeKey: r.type.key });
          }}
          className="rounded-t-none border-0 border-t"
        />
        {!docs.loading && docs.rows.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-[var(--text-tertiary)]">{emptyCopy}</div>
        )}
      </DSCard>

      {/* Archived & replaced */}
      <DSCard title={`Archived & replaced (${archivedRows.length})`} bodyClassName="p-0">
        <DSMiniTable<ArchivedRow>
          columns={archivedCols}
          rows={archivedRows}
          total={archivedRows.length}
          rowActions={(r) => (r.hasFile ? [{ label: 'View', icon: 'eye', onClick: () => void openPreview(r, r.typeName) }] : [])}
          onRowClick={(r) => r.hasFile && void openPreview(r, r.typeName)}
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
        entity={entity}
        entityId={entityId}
        types={docs.types}
        initialTypeKey={upload?.typeKey}
        replacingName={upload?.replacingName}
        entityName={entityName}
      />

      <DocPreviewModal doc={preview} onClose={() => setPreview(null)} />

      {copyTarget && (
        <SaveCopyDialog
          target={copyTarget}
          busy={copying === copyTarget.row.id}
          onClose={() => setCopyTarget(null)}
          onConfirm={(dates) => void performSaveCopy(copyTarget, dates)}
        />
      )}
    </div>
  );
}

/**
 * Collects the date(s) our carrier type requires that the carrier's shared
 * copy lacks, then saves the copy. Mounted only while open, so it starts
 * clean each time.
 */
function SaveCopyDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: CopyTarget;
  busy: boolean;
  onClose: () => void;
  onConfirm: (dates: CopyDates) => void;
}) {
  const missing = missingCopyDates(target);
  const [issueDate, setIssueDate] = React.useState(target.doc.issueDate ?? '');
  const [expirationDate, setExpirationDate] = React.useState(target.doc.expirationDate ?? '');
  const complete = (!missing.issue || !!issueDate) && (!missing.expiry || !!expirationDate);

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save a copy · {target.row.type.name}</DialogTitle>
          <DialogDescription>
            {target.doc.sharedFromOrgName}&apos;s copy has no {missing.issue && missing.expiry ? 'issue or expiration date' : missing.issue ? 'issue date' : 'expiration date'}.
            Your records require {missing.issue && missing.expiry ? 'them' : 'it'} — enter {missing.issue && missing.expiry ? 'them' : 'it'} from the document to save the copy.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {missing.expiry && (
            <div className="grid gap-1.5">
              <Label htmlFor="copy-exp">Expiration date</Label>
              <DateInput
                id="copy-exp"
                value={expirationDate}
                onDateChange={(d) => setExpirationDate(d ?? '')}
                disabled={busy}
                placeholder="As printed on the document"
              />
            </div>
          )}
          {missing.issue && (
            <div className="grid gap-1.5">
              <Label htmlFor="copy-issue">Issue date</Label>
              <DateInput id="copy-issue" value={issueDate} onDateChange={(d) => setIssueDate(d ?? '')} disabled={busy} />
            </div>
          )}
        </div>
        <DialogFooter>
          <WBtn variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </WBtn>
          <WBtn
            variant="primary"
            size="sm"
            disabled={busy || !complete}
            onClick={() => onConfirm({ issueDate: issueDate || undefined, expirationDate: expirationDate || undefined })}
          >
            {busy ? 'Saving…' : 'Save a copy'}
          </WBtn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
