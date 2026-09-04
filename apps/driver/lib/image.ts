import { Image } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';

// ============================================
// UPLOAD IMAGE PREPARATION
// Downscale + re-encode captures before they hit R2.
// ============================================
//
// Camera captures come off the sensor at full resolution (12–48MP →
// 2–6MB even at JPEG q0.8). Documents stay fully legible at ~2000px on
// the long edge, which lands around 300–800KB — a 5–10x cut in driver
// cellular data, upload time on weak signal, and R2 storage. Callers run
// this ONCE at capture time, before the uri reaches the upload hooks or
// the offline queue, so queued photos are stored small too.
//
// Format contract (docs/documents-storage-spec.md §1 "Image
// normalization"): every photo that leaves this function is JPEG. The
// upload path hard-codes `image/jpeg` as the content type, and the bucket
// only ever stores PDF/JPEG/PNG/WebP — so a HEIC (or anything else the
// platform hands us) MUST be re-encoded here, even when it is already
// small enough to skip the resize.

/** Long-edge ceiling. Documents scanned at ~2000px stay readable when zoomed. */
const MAX_LONG_EDGE_PX = 2000;

/** Re-encode quality for resized output. */
const JPEG_QUALITY = 0.75;

/** Quality for a format-only re-encode (no resize) — keep detail. */
const CONVERT_ONLY_QUALITY = 0.9;

function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      (error) => reject(error),
    );
  });
}

/**
 * True when the uri (or reported mime type) already points at a JPEG.
 * Camera captures on both platforms are JPEG; photo-library picks and
 * some OEM camera apps can be HEIC/HEIF, PNG, or WebP.
 */
export function isJpegSource(uri: string, mimeType?: string | null): boolean {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime) return mime === 'image/jpeg' || mime === 'image/jpg';
  const path = uri.split('?')[0].toLowerCase();
  return path.endsWith('.jpg') || path.endsWith('.jpeg');
}

/**
 * Prepare a captured photo for upload:
 *   • downscale to MAX_LONG_EDGE_PX on the long edge when larger, and
 *   • ALWAYS emit JPEG — a non-JPEG source is re-encoded even when it is
 *     already within bounds.
 *
 * Returns the original uri only when it is already a JPEG within bounds
 * (avoids a pointless generation loss). On a manipulation failure for a
 * JPEG source we fall back to the original so a driver is never blocked
 * by the resize step; for a non-JPEG source the failure is rethrown,
 * because uploading it as `image/jpeg` would corrupt the record.
 *
 * Pass `width`/`height` when the capture API already reported them
 * (ImagePicker assets and takePictureAsync results both do) to skip an
 * extra decode of the file. Pass `mimeType` when the picker reports it.
 */
/**
 * JPEG magic bytes (FF D8 FF) — for sources the picker reports no mime
 * type for and whose URI has no suffix (some Android OEM pickers), so a
 * genuine JPEG is neither re-encoded needlessly nor blocked when the
 * manipulator hiccups. Any read failure just means "unknown".
 */
async function sniffIsJpeg(uri: string): Promise<boolean> {
  try {
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: 3,
    });
    // 3 bytes → 4 base64 chars; FF D8 FF encodes to "/9j/".
    return b64.startsWith('/9j/');
  } catch {
    return false;
  }
}

export async function prepareImageForUpload(
  uri: string,
  width?: number,
  height?: number,
  mimeType?: string | null,
): Promise<string> {
  const alreadyJpeg = isJpegSource(uri, mimeType) || (await sniffIsJpeg(uri));
  try {
    let w = width;
    let h = height;
    if (!w || !h) {
      const size = await getImageSize(uri);
      w = size.width;
      h = size.height;
    }

    const longEdge = Math.max(w, h);
    const needsResize = longEdge > MAX_LONG_EDGE_PX;

    if (!needsResize && alreadyJpeg) {
      return uri;
    }

    // Resize by the long edge only — manipulateAsync preserves aspect
    // ratio when a single dimension is given. An empty action list is a
    // format-only re-encode.
    const actions = needsResize
      ? [{ resize: w >= h ? { width: MAX_LONG_EDGE_PX } : { height: MAX_LONG_EDGE_PX } }]
      : [];

    const result = await ImageManipulator.manipulateAsync(uri, actions, {
      compress: needsResize ? JPEG_QUALITY : CONVERT_ONLY_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return result.uri;
  } catch (error) {
    if (alreadyJpeg) {
      console.warn('[Image] prepareImageForUpload failed, using original JPEG:', error);
      return uri;
    }
    console.error('[Image] prepareImageForUpload could not convert non-JPEG source:', error);
    throw error instanceof Error ? error : new Error('Could not prepare photo for upload');
  }
}
