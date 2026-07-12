import { Image } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';

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

/** Long-edge ceiling. Documents scanned at ~2000px stay readable when zoomed. */
const MAX_LONG_EDGE_PX = 2000;

/** Re-encode quality for resized output. */
const JPEG_QUALITY = 0.75;

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
 * Downscale a captured photo to MAX_LONG_EDGE_PX on its long edge and
 * re-encode as JPEG. Returns the original uri untouched when the image
 * is already within bounds (avoids a pointless re-encode generation
 * loss) or when manipulation fails — a driver must never be blocked
 * from uploading because the resize step hiccuped.
 *
 * Pass `width`/`height` when the capture API already reported them
 * (ImagePicker assets and takePictureAsync results both do) to skip an
 * extra decode of the file.
 */
export async function prepareImageForUpload(
  uri: string,
  width?: number,
  height?: number,
): Promise<string> {
  try {
    let w = width;
    let h = height;
    if (!w || !h) {
      const size = await getImageSize(uri);
      w = size.width;
      h = size.height;
    }

    const longEdge = Math.max(w, h);
    if (longEdge <= MAX_LONG_EDGE_PX) {
      return uri;
    }

    // Resize by the long edge only — manipulateAsync preserves aspect
    // ratio when a single dimension is given.
    const resize = w >= h ? { width: MAX_LONG_EDGE_PX } : { height: MAX_LONG_EDGE_PX };

    const result = await ImageManipulator.manipulateAsync(uri, [{ resize }], {
      compress: JPEG_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return result.uri;
  } catch (error) {
    console.warn('[Image] prepareImageForUpload failed, using original:', error);
    return uri;
  }
}
