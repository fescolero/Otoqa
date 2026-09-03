/**
 * Browser-side image normalization before a document upload.
 *
 * docs/documents-storage-spec.md §1 "Image normalization": only PDF, JPEG,
 * PNG, and WebP are ever stored. A HEIC/HEIF (what iPhones text people)
 * is converted to JPEG here, in the browser, before presign. The libheif
 * WebAssembly build behind `heic2any` is loaded lazily so nobody who
 * never picks a HEIC pays for it.
 *
 * Server-side conversion is not an option (Convex Node actions cannot run
 * native image libraries; hosted sharp builds lack HEVC decoding), and
 * the presign action refuses anything outside the stored formats, so a
 * HEIC that somehow bypasses this is rejected, never stored.
 */

export const ACCEPTED_UPLOAD_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];

export const UPLOAD_INPUT_ACCEPT = [
  ...ACCEPTED_UPLOAD_EXTENSIONS,
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
].join(',');

const STORED_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

const EXT_TO_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Browsers often report an empty or generic type for HEIC; fall back to
 *  the extension so detection is reliable. */
export function effectiveContentType(file: File): string {
  const declared = (file.type || '').toLowerCase();
  if (declared && declared !== 'application/octet-stream') return declared;
  return EXT_TO_TYPE[extensionOf(file.name)] ?? declared;
}

export function isHeic(file: File): boolean {
  const t = effectiveContentType(file);
  return t === 'image/heic' || t === 'image/heif' || ['heic', 'heif'].includes(extensionOf(file.name));
}

export function isStoredType(file: File): boolean {
  return STORED_TYPES.has(effectiveContentType(file));
}

export interface NormalizedUpload {
  file: File;
  contentType: string;
  /** True when the bytes were converted (HEIC → JPEG). */
  converted: boolean;
}

/**
 * Return a File whose bytes are in a stored format. Throws with a
 * user-facing message for anything we cannot store.
 */
export async function normalizeUploadImage(
  file: File,
  onProgress?: (phase: 'converting') => void,
): Promise<NormalizedUpload> {
  if (isStoredType(file)) {
    return { file, contentType: effectiveContentType(file), converted: false };
  }
  if (!isHeic(file)) {
    throw new Error('Unsupported file type. Upload a PDF, JPEG, PNG, WebP, or HEIC photo.');
  }

  onProgress?.('converting');
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
  const blob = Array.isArray(out) ? out[0] : out;
  if (!blob) throw new Error('Could not convert the HEIC photo. Try exporting it as JPEG.');

  const base = file.name.replace(/\.(heic|heif)$/i, '') || 'photo';
  const jpeg = new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
  return { file: jpeg, contentType: 'image/jpeg', converted: true };
}
