'use client';

/**
 * LoadDocumentUploadDialog — ops upload of a load document (POD, receipt,
 * cargo/damage/accident photo, other) from the load detail page.
 *
 * Same bucket contract as driver captures (documents-storage-spec.md §1,
 * §9): normalize (HEIC → JPEG in-browser) → presign → PUT with the signed
 * metadata headers → HEAD-verified finalize that records the row.
 */

import * as React from 'react';
import { useAction } from 'convex/react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type LoadDocType = 'POD' | 'Receipt' | 'Cargo' | 'Damage' | 'Accident' | 'Other';

const TYPES: Array<{ value: LoadDocType; label: string }> = [
  { value: 'POD', label: 'Proof of delivery' },
  { value: 'Receipt', label: 'Receipt (lumper, fuel, toll…)' },
  { value: 'Cargo', label: 'Cargo condition' },
  { value: 'Damage', label: 'Damage' },
  { value: 'Accident', label: 'Accident' },
  { value: 'Other', label: 'Other' },
];

type Phase = 'idle' | 'converting' | 'presigning' | 'uploading' | 'finalizing';
const PHASE_LABEL: Record<Exclude<Phase, 'idle'>, string> = {
  converting: 'Converting photo…',
  presigning: 'Preparing upload…',
  uploading: 'Uploading…',
  finalizing: 'Saving…',
};

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
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [progress, setProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const busy = phase !== 'idle';

  const submit = async () => {
    if (!file) {
      setError('Attach the document file.');
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setError('File is too large (25 MB max).');
      return;
    }
    setError(null);
    try {
      const normalized = await normalizeUploadImage(file, () => setPhase('converting'));
      setPhase('presigning');
      const presigned = await getUploadUrl({
        loadId,
        type,
        fileName: normalized.file.name,
        contentType: normalized.contentType,
        sizeBytes: normalized.file.size,
      });
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
        await cancelUpload({ key: presigned.key }).catch(() => undefined);
        throw putErr;
      }
      setPhase('finalizing');
      await finalizeUpload({ loadId, type, key: presigned.key, fileName: normalized.file.name, note: note || undefined });
      toast.success(`${TYPES.find((t) => t.value === type)?.label ?? type} added`);
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

        {busy && (
          <div className="text-[12px] text-[var(--text-secondary)]">
            {PHASE_LABEL[phase as Exclude<Phase, 'idle'>]}
            {phase === 'uploading' && progress != null ? ` ${Math.round(progress * 100)}%` : ''}
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
        <WBtn variant="primary" size="sm" onClick={submit} disabled={busy}>
          {busy ? 'Working…' : 'Save'}
        </WBtn>
      </DialogFooter>
    </DialogContent>
  );
}
