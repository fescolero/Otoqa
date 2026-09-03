'use client';

/**
 * DocumentUploadDialog — add or replace a document on a driver, a carrier
 * partnership, or the org's own company file.
 *
 * A document is a file plus a user-entered date (documents-storage-spec.md
 * §3, §4): the form requires whatever the type's flags say (expiry for
 * expiring types, issue date when required, a file unless the type
 * allows date-only entries). Flow for files:
 *
 *   normalize (HEIC → JPEG in-browser) → presign → PUT with the signed
 *   metadata headers → finalize (server HEADs the object, activates the
 *   row, archives the previous singleton, writes mirrors + summary).
 *
 * A failed PUT cancels the pending row so no orphan is left behind; the
 * hourly sweep is the backstop for a closed tab.
 */

import * as React from 'react';
import { useAction, useMutation } from 'convex/react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import type { EffectiveDocumentType } from '@/convex/_helpers/documentStatus';
import type { DocumentEntity } from '@/convex/lib/documentTypeDefaults';
import { MAX_DOCUMENT_BYTES } from '@/convex/lib/r2';
import { normalizeUploadImage, UPLOAD_INPUT_ACCEPT } from '@/lib/normalize-upload-image';
import { putWithProgress } from '@/lib/upload-put';
import { convexErrorMessage } from '@/lib/convex-error';
import { WBtn, WIcon } from '@/components/web';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DateInput } from '@/components/ui/date-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatBytes } from './entity-documents-model';

type Phase = 'idle' | 'converting' | 'presigning' | 'uploading' | 'finalizing';

const PHASE_LABEL: Record<Exclude<Phase, 'idle'>, string> = {
  converting: 'Converting photo…',
  presigning: 'Preparing upload…',
  uploading: 'Uploading…',
  finalizing: 'Saving…',
};

export interface DocumentUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity: DocumentEntity;
  entityId: string;
  types: readonly EffectiveDocumentType[];
  /** Preselect a type (Replace / Upload on a Missing row). */
  initialTypeKey?: string;
  /** Name of the document being replaced, for the title. */
  replacingName?: string;
  /** Entity display name, for the title. */
  entityName?: string;
  onSaved?: () => void;
}

export function DocumentUploadDialog(props: DocumentUploadDialogProps) {
  const { open, onOpenChange } = props;
  // Form state lives in the inner component, which Radix unmounts when the
  // dialog closes — so every open starts clean without a reset effect.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <UploadForm {...props} />}
    </Dialog>
  );
}

/** The per-entity action set. Same shapes; different owning rows. */
function useEntityActions(entity: DocumentEntity) {
  const driver = {
    getUploadUrl: useAction(api.driverDocuments.getUploadUrl),
    finalizeUpload: useAction(api.driverDocuments.finalizeUpload),
    cancelUpload: useAction(api.driverDocuments.cancelUpload),
  };
  const carrier = {
    getUploadUrl: useAction(api.carrierDocuments.getUploadUrl),
    finalizeUpload: useAction(api.carrierDocuments.finalizeUpload),
    cancelUpload: useAction(api.carrierDocuments.cancelUpload),
  };
  const organization = {
    getUploadUrl: useAction(api.organizationDocuments.getUploadUrl),
    finalizeUpload: useAction(api.organizationDocuments.finalizeUpload),
    cancelUpload: useAction(api.organizationDocuments.cancelUpload),
  };
  return { driver, carrier, organization }[entity];
}

function UploadForm({
  onOpenChange,
  entity,
  entityId,
  types,
  initialTypeKey,
  replacingName,
  entityName,
  onSaved,
}: DocumentUploadDialogProps) {
  const actions = useEntityActions(entity);
  const createDateOnly = useMutation(api.entityDocuments.createDateOnly);

  const visibleTypes = React.useMemo(() => types.filter((t) => !t.hidden), [types]);

  const [typeKey, setTypeKey] = React.useState<string>(initialTypeKey ?? visibleTypes[0]?.key ?? '');
  const [file, setFile] = React.useState<File | null>(null);
  const [issueDate, setIssueDate] = React.useState<string>('');
  const [expirationDate, setExpirationDate] = React.useState<string>('');
  const [note, setNote] = React.useState('');
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [progress, setProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const type = visibleTypes.find((t) => t.key === typeKey) ?? null;
  const busy = phase !== 'idle';

  const validate = (): string | null => {
    if (!type) return 'Pick a document type.';
    if (type.uploadRequired && !file) return 'Attach the document file.';
    if (type.expires && !expirationDate) return 'Enter the expiration date shown on the document.';
    if (type.issueDateRequired && !issueDate) return 'Enter the issue date.';
    if (file && file.size > MAX_DOCUMENT_BYTES) return 'File is too large (25 MB max).';
    return null;
  };

  const presign = async (fileName: string, contentType: string, sizeBytes: number) => {
    const common = { typeKey: type!.key, fileName, contentType, sizeBytes };
    switch (entity) {
      case 'driver':
        return (actions as ReturnType<typeof useEntityActions>).getUploadUrl({
          ...common,
          driverId: entityId as Id<'drivers'>,
        } as never);
      case 'carrier':
        return actions.getUploadUrl({ ...common, partnershipId: entityId as Id<'carrierPartnerships'> } as never);
      case 'organization':
        return actions.getUploadUrl({ ...common, orgId: entityId } as never);
    }
  };

  const submit = async () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    if (!type) return;
    setError(null);

    try {
      if (!file) {
        setPhase('finalizing');
        await createDateOnly({
          entity,
          entityId,
          typeKey: type.key,
          issueDate: issueDate || undefined,
          expirationDate: expirationDate || undefined,
          note: note || undefined,
        });
      } else {
        const normalized = await normalizeUploadImage(file, () => setPhase('converting'));

        setPhase('presigning');
        const presigned = await presign(normalized.file.name, normalized.contentType, normalized.file.size);

        setPhase('uploading');
        setProgress(0);
        try {
          await putWithProgress(
            presigned.uploadUrl,
            normalized.file,
            { 'Content-Type': normalized.contentType, ...presigned.metadataHeaders },
            setProgress,
          );
        } catch (putErr) {
          // Never leave a pending row behind for a failed PUT.
          await actions.cancelUpload({ docId: presigned.docId }).catch(() => undefined);
          throw putErr;
        }

        setPhase('finalizing');
        await actions.finalizeUpload({
          docId: presigned.docId,
          issueDate: issueDate || undefined,
          expirationDate: expirationDate || undefined,
          note: note || undefined,
        });
      }

      toast.success(`${type.name} ${replacingName ? 'replaced' : 'added'}`);
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      setError(convexErrorMessage(e) ?? (e instanceof Error ? e.message : 'Upload failed. Please try again.'));
    } finally {
      setPhase('idle');
      setProgress(null);
    }
  };

  return (
    <DialogContent
      className="max-w-lg"
      onInteractOutside={(e) => busy && e.preventDefault()}
      onEscapeKeyDown={(e) => busy && e.preventDefault()}
    >
      <DialogHeader>
        <DialogTitle>
          {replacingName ? `Replace ${replacingName}` : 'Upload document'}
          {entityName ? ` · ${entityName}` : ''}
        </DialogTitle>
        <DialogDescription>
          {replacingName
            ? 'The current document is archived once the new one is saved.'
            : 'The file is the visual confirmation; you enter the dates from it.'}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="doc-type">Document type</Label>
          <Select value={typeKey} onValueChange={setTypeKey} disabled={busy || !!initialTypeKey}>
            <SelectTrigger id="doc-type">
              <SelectValue placeholder="Pick a type" />
            </SelectTrigger>
            <SelectContent>
              {visibleTypes.map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="doc-file">File{type && !type.uploadRequired ? ' (optional for this type)' : ''}</Label>
          <input
            ref={inputRef}
            id="doc-file"
            type="file"
            accept={UPLOAD_INPUT_ACCEPT}
            disabled={busy}
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setError(null);
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="focus-ring flex items-center gap-2.5 rounded-lg border border-dashed border-[var(--border-hairline-strong)] bg-[var(--bg-surface-2)] px-3 py-2.5 text-left text-[12.5px] hover:bg-[var(--bg-surface-3)] disabled:opacity-60"
          >
            <WIcon name="upload" size={14} />
            {file ? (
              <span className="min-w-0 flex-1 truncate">
                {file.name} <span className="text-[var(--text-tertiary)]">· {formatBytes(file.size)}</span>
              </span>
            ) : (
              <span className="text-[var(--text-tertiary)]">
                Choose a PDF, JPEG, PNG, WebP, or HEIC photo (25 MB max)
              </span>
            )}
          </button>
        </div>

        {type?.expires && (
          <div className="grid gap-1.5">
            <Label htmlFor="doc-exp">Expiration date</Label>
            <DateInput
              id="doc-exp"
              value={expirationDate}
              onDateChange={(d) => setExpirationDate(d ?? '')}
              disabled={busy}
              placeholder="As printed on the document"
            />
          </div>
        )}

        {type && (type.issueDateRequired || !type.expires) && (
          <div className="grid gap-1.5">
            <Label htmlFor="doc-issue">Issue date{type.issueDateRequired ? '' : ' (optional)'}</Label>
            <DateInput id="doc-issue" value={issueDate} onDateChange={(d) => setIssueDate(d ?? '')} disabled={busy} />
          </div>
        )}

        <div className="grid gap-1.5">
          <Label htmlFor="doc-note">Note (optional)</Label>
          <Input
            id="doc-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            maxLength={200}
            placeholder="e.g. Renewed at DMV Fresno"
          />
        </div>

        {busy && (
          <div className="text-[12px] text-[var(--text-secondary)]">
            {PHASE_LABEL[phase as Exclude<Phase, 'idle'>]}
            {phase === 'uploading' && progress != null ? ` ${Math.round(progress * 100)}%` : ''}
            {phase === 'uploading' && (
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-[var(--bg-surface-3)]">
                <div
                  className="h-full bg-[var(--accent)] transition-[width]"
                  style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="m-0 text-[12.5px]" style={{ color: '#B43030' }}>
            {error}
          </p>
        )}
      </div>

      <DialogFooter>
        <WBtn variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </WBtn>
        <WBtn variant="primary" size="sm" onClick={submit} disabled={busy || !type}>
          {busy ? 'Working…' : replacingName ? 'Replace' : 'Save'}
        </WBtn>
      </DialogFooter>
    </DialogContent>
  );
}
