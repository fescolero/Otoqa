/**
 * Shared print/download choreography for generated PDF blobs.
 *
 * Centralizes the fiddly parts both invoice preview sheets need:
 *   - per-call toast ids, so overlapping generations (or unrelated toasts)
 *     are never dismissed by someone else's flow
 *   - window.open null-check — after async PDF generation the call is
 *     outside the user-gesture window, so popup blockers can eat it;
 *     report that honestly instead of a false success
 *   - blob-URL lifetimes long enough for slow tabs/downloads to dereference
 *     the blob before revocation
 */

import { toast } from 'sonner';

let seq = 0;
const nextToastId = () => `pdf-action-${++seq}`;

/** Open a generated PDF blob in a new tab (print flow). */
export function openPdfBlob(blob: Blob): void {
  const toastId = nextToastId();
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (win) {
    toast.success('PDF opened in new tab', { id: toastId });
  } else {
    toast.error('Pop-up blocked — allow pop-ups for this site or use Download instead', {
      id: toastId,
    });
  }
  // Give slow/background tabs ample time to fetch the blob before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Download a generated PDF blob as `<filename>`. */
export function downloadPdfBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Deferred revoke — revoking in the same tick can abort the download in
  // some browsers (the download subsystem dereferences the URL async).
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast.success('PDF downloaded successfully', { id: nextToastId() });
}

/**
 * Run an async PDF generation with a scoped loading toast; returns the blob
 * or null on failure (already toasted).
 */
export async function generatePdfWithToast(
  generate: () => Promise<Blob>,
  loadingMessage: string,
): Promise<Blob | null> {
  const toastId = nextToastId();
  toast.loading(loadingMessage, { id: toastId });
  try {
    const blob = await generate();
    toast.dismiss(toastId);
    return blob;
  } catch (error) {
    toast.error('Failed to generate PDF', { id: toastId });
    console.error('PDF generation error:', error);
    return null;
  }
}
