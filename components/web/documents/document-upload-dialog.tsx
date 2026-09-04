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
import { UPLOAD_INPUT_ACCEPT } from '@/lib/normalize-upload-image';
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
import { UploadProgress, useUploadSequence, validateUploadFile } from './use-upload-sequence';

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

interface PresignCommon {
  typeKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/** The per-entity action set. finalize/cancel share one shape; presign
 *  differs only in the id field, so it is closed over here with each
 *  action's real argument type (no casts at the call site). */
function useEntityActions(entity: DocumentEntity, entityId: string) {
  const driverPresign = useAction(api.driverDocuments.getUploadUrl);
  const carrierPresign = useAction(api.carrierDocuments.getUploadUrl);
  const orgPresign = useAction(api.organizationDocuments.getUploadUrl);
  const finalize = {
    driver: useAction(api.driverDocuments.finalizeUpload),
    carrier: useAction(api.carrierDocuments.finalizeUpload),
    organization: useAction(api.organizationDocuments.finalizeUpload),
  };
  const cancel = {
    driver: useAction(api.driverDocuments.cancelUpload),
    carrier: useAction(api.carrierDocuments.cancelUpload),
    organization: useAction(api.organizationDocuments.cancelUpload),
  };
  const presign = React.useCallback(
    (common: PresignCommon) => {
      switch (entity) {
        case 'driver':
          return driverPresign({ ...common, driverId: entityId as Id<'drivers'> });
        case 'carrier':
          return carrierPresign({ ...common, partnershipId: entityId as Id<'carrierPartnerships'> });
        case 'organization':
          return orgPresign({ ...common, orgId: entityId });
      }
    },
    [entity, entityId, driverPresign, carrierPresign, orgPresign],
  );
  return { presign, finalizeUpload: finalize[entity], cancelUpload: cancel[entity] };
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
  const actions = useEntityActions(entity, entityId);
  const createDateOnly = useMutation(api.entityDocuments.createDateOnly);

  const visibleTypes = React.useMemo(() => types.filter((t) => !t.hidden), [types]);

  const [typeKey, setTypeKey] = React.useState<string>(initialTypeKey ?? visibleTypes[0]?.key ?? '');
  const [file, setFile] = React.useState<File | null>(null);
  const [issueDate, setIssueDate] = React.useState<string>('');
  const [expirationDate, setExpirationDate] = React.useState<string>('');
  const [note, setNote] = React.useState('');
  const seq = useUploadSequence();
  const { busy, error } = seq;
  const inputRef = React.useRef<HTMLInputElement>(null);

  const type = visibleTypes.find((t) => t.key === typeKey) ?? null;

  const validate = (): string | null => {
    if (!type) return 'Pick a document type.';
    if (type.uploadRequired && !file) return 'Attach the document file.';
    if (type.expires && !expirationDate) return 'Enter the expiration date shown on the document.';
    if (type.issueDateRequired && !issueDate) return 'Enter the issue date.';
    if (file) return validateUploadFile(file);
    return null;
  };

  const submit = async () => {
    const problem = validate();
    if (problem) {
      seq.setError(problem);
      return;
    }
    if (!type) return;

    const dates = { issueDate: issueDate || undefined, expirationDate: expirationDate || undefined, note: note || undefined };
    const result = file
      ? await seq.upload(file, {
          presign: (f) => actions.presign({ typeKey: type.key, ...f }),
          cancel: (p) => actions.cancelUpload({ docId: p.docId }),
          finalize: (p) => actions.finalizeUpload({ docId: p.docId, ...dates }),
        })
      : await seq.runSaving(() => createDateOnly({ entity, entityId, typeKey: type.key, ...dates }));
    if (result === undefined) return; // error shown in the dialog

    toast.success(`${type.name} ${replacingName ? 'replaced' : 'added'}`);
    onSaved?.();
    onOpenChange(false);
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
              seq.setError(null);
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

        <UploadProgress phase={seq.phase} progress={seq.progress} />

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
