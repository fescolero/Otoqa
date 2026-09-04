'use client';

/**
 * LoadDocumentUploadDialog — ops upload of a load document (POD, receipt,
 * cargo/damage/accident photo, other) from the load detail page.
 *
 * Same bucket contract as driver captures (documents-storage-spec.md §1,
 * §9), and the same browser sequence as every other document dialog
 * (useUploadSequence): normalize → presign → PUT → HEAD-verified finalize.
 */

import * as React from 'react';
import { useAction } from 'convex/react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import type { WebLoadDocumentType } from '@/convex/lib/r2';
import { UPLOAD_INPUT_ACCEPT } from '@/lib/normalize-upload-image';
import { UploadProgress, useUploadSequence, validateUploadFile } from '@/components/web/documents/use-upload-sequence';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type LoadDocType = WebLoadDocumentType;

const TYPES: Array<{ value: LoadDocType; label: string }> = [
  { value: 'POD', label: 'Proof of delivery' },
  { value: 'Receipt', label: 'Receipt (lumper, fuel, toll…)' },
  { value: 'Cargo', label: 'Cargo condition' },
  { value: 'Damage', label: 'Damage' },
  { value: 'Accident', label: 'Accident' },
  { value: 'Other', label: 'Other' },
];

export interface LoadDocumentUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadId: Id<'loadInformation'>;
  orderNumber?: string;
  initialType?: LoadDocType;
}

export function LoadDocumentUploadDialog(props: LoadDocumentUploadDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open && <UploadForm {...props} />}
    </Dialog>
  );
}

function UploadForm({ onOpenChange, loadId, orderNumber, initialType }: LoadDocumentUploadDialogProps) {
  const getUploadUrl = useAction(api.loadDocumentsWeb.getUploadUrl);
  const finalizeUpload = useAction(api.loadDocumentsWeb.finalizeUpload);
  const cancelUpload = useAction(api.loadDocumentsWeb.cancelUpload);

  const [type, setType] = React.useState<LoadDocType>(initialType ?? 'POD');
  const [file, setFile] = React.useState<File | null>(null);
  const [note, setNote] = React.useState('');
  const seq = useUploadSequence();
  const { busy, error } = seq;
  const inputRef = React.useRef<HTMLInputElement>(null);

  const submit = async () => {
    const problem = validateUploadFile(file);
    if (problem || !file) {
      seq.setError(problem ?? 'Attach the document file.');
      return;
    }
    const result = await seq.upload(file, {
      presign: (f) => getUploadUrl({ loadId, type, ...f }),
      cancel: (p) => cancelUpload({ key: p.key }),
      finalize: (p, sent) =>
        finalizeUpload({ loadId, type, key: p.key, fileName: sent.file.name, note: note || undefined }),
    });
    if (result === undefined) return; // error shown in the dialog
    toast.success(`${TYPES.find((t) => t.value === type)?.label ?? type} added`);
    onOpenChange(false);
  };

  return (
    <DialogContent
      className="max-w-lg"
      onInteractOutside={(e) => busy && e.preventDefault()}
      onEscapeKeyDown={(e) => busy && e.preventDefault()}
    >
      <DialogHeader>
        <DialogTitle>Upload document{orderNumber ? ` · ${orderNumber}` : ''}</DialogTitle>
        <DialogDescription>Stored with the driver&apos;s captures for this load.</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="ld-type">Document type</Label>
          <Select value={type} onValueChange={(v) => setType(v as LoadDocType)} disabled={busy}>
            <SelectTrigger id="ld-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="ld-file">File</Label>
          <input
            ref={inputRef}
            id="ld-file"
            type="file"
            accept={UPLOAD_INPUT_ACCEPT}
            disabled={busy}
            style={{ display: 'none' }}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
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
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
            ) : (
              <span className="text-[var(--text-tertiary)]">
                Choose a PDF, JPEG, PNG, WebP, or HEIC photo (25 MB max)
              </span>
            )}
          </button>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="ld-note">Note (optional)</Label>
          <Input
            id="ld-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            maxLength={200}
            placeholder="e.g. Signed BOL emailed by consignee"
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
        <WBtn variant="primary" size="sm" onClick={submit} disabled={busy}>
          {busy ? 'Working…' : 'Save'}
        </WBtn>
      </DialogFooter>
    </DialogContent>
  );
}
