'use client';

/**
 * useUploadSequence — the one browser-side upload state machine shared by
 * every document dialog (entity documents and load documents):
 *
 *   normalize (HEIC → JPEG in-browser) → presign → PUT with the signed
 *   metadata headers → finalize (server HEADs the object and records it).
 *
 * A failed PUT calls `cancel` so no pending row / stray object is left
 * behind; the hourly sweep is the backstop for a closed tab. The dialogs
 * only supply the three server calls and render `phase` / `progress` /
 * `error` — a fix to the sequence lands in one place.
 */

import * as React from 'react';

import { MAX_DOCUMENT_BYTES } from '@/convex/lib/r2';
import { normalizeUploadImage, type NormalizedUpload } from '@/lib/normalize-upload-image';
import { putWithProgress } from '@/lib/upload-put';
import { convexErrorMessage } from '@/lib/convex-error';

export type UploadPhase = 'idle' | 'converting' | 'presigning' | 'uploading' | 'finalizing';

export const UPLOAD_PHASE_LABEL: Record<Exclude<UploadPhase, 'idle'>, string> = {
  converting: 'Converting photo…',
  presigning: 'Preparing upload…',
  uploading: 'Uploading…',
  finalizing: 'Saving…',
};

export interface PresignedUpload {
  uploadUrl: string;
  metadataHeaders: Record<string, string>;
}

export interface UploadSteps<P extends PresignedUpload, R> {
  /** Server presign for the normalized file. */
  presign: (file: { fileName: string; contentType: string; sizeBytes: number }) => Promise<P>;
  /** Drop the pending row / object after a failed PUT. Errors are swallowed. */
  cancel: (presigned: P) => Promise<unknown>;
  /** HEAD-verified activation. Receives the presign result and the file as sent. */
  finalize: (presigned: P, file: NormalizedUpload) => Promise<R>;
}

/** Pre-flight the file locally so the user hears about it before any call. */
export function validateUploadFile(file: File | null): string | null {
  if (!file) return 'Attach the document file.';
  if (file.size > MAX_DOCUMENT_BYTES) return 'File is too large (25 MB max).';
  return null;
}

export function useUploadSequence() {
  const [phase, setPhase] = React.useState<UploadPhase>('idle');
  const [progress, setProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const busy = phase !== 'idle';

  /**
   * Run the full sequence for `file`. Resolves with finalize's result, or
   * `undefined` after setting `error` — the caller keeps the dialog open
   * on `undefined` and closes it otherwise.
   */
  const upload = React.useCallback(
    async <P extends PresignedUpload, R>(file: File, steps: UploadSteps<P, R>): Promise<R | undefined> => {
      setError(null);
      try {
        const normalized = await normalizeUploadImage(file, () => setPhase('converting'));

        setPhase('presigning');
        const presigned = await steps.presign({
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
          // Never leave a pending row / orphan object behind for a failed PUT.
          await steps.cancel(presigned).catch(() => undefined);
          throw putErr;
        }

        setPhase('finalizing');
        return await steps.finalize(presigned, normalized);
      } catch (e) {
        setError(convexErrorMessage(e) ?? (e instanceof Error ? e.message : 'Upload failed. Please try again.'));
        return undefined;
      } finally {
        setPhase('idle');
        setProgress(null);
      }
    },
    [],
  );

  /**
   * Run a single server call under the "Saving…" phase with the same error
   * handling — for date-only entries that have no file to send.
   */
  const runSaving = React.useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setError(null);
    setPhase('finalizing');
    try {
      return await fn();
    } catch (e) {
      setError(convexErrorMessage(e) ?? (e instanceof Error ? e.message : 'Save failed. Please try again.'));
      return undefined;
    } finally {
      setPhase('idle');
    }
  }, []);

  return { phase, progress, error, busy, setError, upload, runSaving };
}

/** The "Uploading… 42%" line plus progress bar every upload dialog shows. */
export function UploadProgress({ phase, progress }: { phase: UploadPhase; progress: number | null }) {
  if (phase === 'idle') return null;
  return (
    <div className="text-[12px] text-[var(--text-secondary)]">
      {UPLOAD_PHASE_LABEL[phase]}
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
  );
}
