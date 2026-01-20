// Using legacy API for SDK 54 compatibility
import * as FileSystem from 'expo-file-system/legacy';

// ============================================
// S3 UPLOAD CLIENT
// Uses presigned URLs from Convex to upload directly to S3
// ============================================

interface UploadResult {
  success: boolean;
  fileUrl?: string;
  error?: string;
}

/**
 * Upload a file to S3 using a presigned URL
 */
export async function uploadToS3(
  presignedUrl: string,
  localFilePath: string,
  contentType: string = 'image/jpeg'
): Promise<UploadResult> {
  try {
    // Upload using expo-file-system's uploadAsync
    // This will throw if the file doesn't exist
    const response = await FileSystem.uploadAsync(presignedUrl, localFilePath, {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        'Content-Type': contentType,
      },
    });

    if (response.status >= 200 && response.status < 300) {
      // Extract the file URL from the presigned URL (remove query params)
      const fileUrl = presignedUrl.split('?')[0];
      return { success: true, fileUrl };
    } else {
      return {
        success: false,
        error: `Upload failed with status ${response.status}: ${response.body}`,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown upload error';
    console.error('[S3Upload] Error:', errorMessage);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Upload a POD photo with retry logic
 */
export async function uploadPODPhoto(
  presignedUrl: string,
  photoPath: string,
  maxRetries: number = 3
): Promise<UploadResult> {
  // Check if file exists first
  try {
    const fileInfo = await FileSystem.getInfoAsync(photoPath);
    console.log('[S3Upload] File info:', JSON.stringify(fileInfo));
    if (!fileInfo.exists) {
      return { success: false, error: `File does not exist: ${photoPath}` };
    }
  } catch (fileCheckError) {
    console.error('[S3Upload] Error checking file:', fileCheckError);
    return { success: false, error: `Error checking file: ${fileCheckError}` };
  }

  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    console.log(`[S3Upload] Attempt ${attempt + 1}/${maxRetries} for ${photoPath}`);
    const result = await uploadToS3(presignedUrl, photoPath, 'image/jpeg');
    
    if (result.success) {
      console.log('[S3Upload] Upload successful');
      return result;
    }

    lastError = result.error;
    console.log(`[S3Upload] Attempt ${attempt + 1} failed:`, lastError);
    
    // Wait before retrying (exponential backoff)
    if (attempt < maxRetries - 1) {
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`[S3Upload] Waiting ${delay}ms before retry...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return { success: false, error: lastError || 'Max retries exceeded' };
}
