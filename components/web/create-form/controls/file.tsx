/**
 * File control — uploads a single file to Convex storage via the
 * per-entity `generateUploadUrl` mutation supplied by the page wrapper.
 *
 * Lifecycle:
 *   1. User picks or drops a file.
 *   2. We call `uploader()` → Convex returns a one-time upload URL.
 *   3. We POST the blob to that URL with the right `Content-Type`.
 *   4. The response carries `{ storageId }` — we store that as the
 *      field's value. The page wrapper then passes it into the create
 *      mutation as `receiptStorageId: vals.attachment as Id<'_storage'>`.
 *
 * Mirrors the wiring in `components/diesel/fuel-entry-form.tsx` so the
 * eventual swap is mechanical. If the schema's `uploader` is missing
 * (page wrapper forgot to bind), the control renders disabled with a
 * dev-only console warning.
 */

'use client';

import * as React from 'react';
import { WIcon } from '@/components/web/icons';
import { WBtn } from '@/components/web/btn';
import type { FileUploader } from '../schema-types';

export interface FileControlProps {
  id: string;
  value: string; // storageId — empty string when nothing uploaded yet
  onChange: (storageId: string) => void;
  uploader?: FileUploader;
  accept?: string;
  hint?: string;
  disabled?: boolean;
  hasError?: boolean;
}

export function FileControl({
  id,
  value,
  onChange,
  uploader,
  accept,
  hint,
  disabled,
  hasError,
}: FileControlProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [filename, setFilename] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!uploader && !disabled && process.env.NODE_ENV !== 'production') {
      console.warn(
        `[create-form] file field "${id}" is missing an uploader. ` +
          `Did you forget to call bindUploaders(schema, {...}) in the page wrapper?`,
      );
    }
  }, [id, uploader, disabled]);

  const isDisabled = disabled || !uploader || uploading;

  const handleFile = React.useCallback(
    async (file: File) => {
      if (!uploader) return;
      setUploading(true);
      setUploadError(null);
      try {
        const uploadUrl = await uploader();
        const res = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: file,
        });
        if (!res.ok) throw new Error(`upload failed (${res.status})`);
        const { storageId } = (await res.json()) as { storageId: string };
        onChange(storageId);
        setFilename(file.name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        setUploadError(msg);
      } finally {
        setUploading(false);
      }
    },
    [uploader, onChange],
  );

  return (
    <div>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        disabled={isDisabled}
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: 10,
          border: `1px dashed ${
            hasError || uploadError
              ? '#B43030'
              : 'var(--border-hairline-strong)'
          }`,
          borderRadius: 8,
          background: 'var(--bg-surface-2)',
        }}
      >
        <WIcon
          name="upload"
          size={16}
          color={uploadError ? '#B43030' : 'var(--text-tertiary)'}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {value && filename ? (
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-primary)',
                fontWeight: 500,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {filename}
            </div>
          ) : value ? (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Uploaded
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {uploading
                ? 'Uploading…'
                : hint ?? 'Pick a file or drop one here.'}
            </div>
          )}
          {uploadError && (
            <div
              style={{ fontSize: 11, color: '#B43030', marginTop: 2 }}
              role="alert"
            >
              {uploadError}
            </div>
          )}
        </div>
        <WBtn
          size="xs"
          variant="secondary"
          onClick={() => inputRef.current?.click()}
          disabled={isDisabled}
        >
          {value ? 'Replace' : 'Browse'}
        </WBtn>
        {value && !uploading && (
          <WBtn
            size="xs"
            variant="ghost"
            onClick={() => {
              onChange('');
              setFilename(null);
              if (inputRef.current) inputRef.current.value = '';
            }}
            disabled={isDisabled}
          >
            Clear
          </WBtn>
        )}
      </div>
    </div>
  );
}
