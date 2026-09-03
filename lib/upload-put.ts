/**
 * PUT a file to a presigned R2 URL with upload progress (fetch has none).
 * The caller passes the exact headers the URL was signed with — the
 * Content-Type plus every `x-amz-meta-*` header — or R2 answers 403.
 * Rejects on any non-2xx status.
 */
export function putWithProgress(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status}). Check the bucket CORS rule if this persists.`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — network error or blocked by CORS.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.send(body);
  });
}
