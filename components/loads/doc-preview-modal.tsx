'use client';

/**
 * DocPreviewModal — load-document preview drawer (per design v3
 * `details-other.jsx` § DocPreviewModal).
 *
 * Two-pane layout: rendered document on the left, details + activity +
 * Download / Open footer on the right. Esc and backdrop click close.
 *
 * Variants:
 *   • image     — POD photos, signatures (object-contain on a dark canvas)
 *   • pdf       — externally-hosted PDF rendered in an <iframe>
 *   • text      — driver notes / OCR snippets rendered as monospace text
 *   • placeholder — file isn't on file yet; shows an empty-state with Upload
 */

import * as React from 'react';
import { Chip, type ChipStatus, DSProps, WBtn, WIcon } from '@/components/web';

export type DocPreview =
  | { kind: 'image'; url: string }
  | { kind: 'pdf'; url: string }
  | { kind: 'text'; body: string }
  | { kind: 'placeholder' };

export interface DocRecord {
  id: string;
  name: string;
  src: string;
  when: string;
  status: ChipStatus;
  fileLabel?: string;
  preview: DocPreview;
  /** Activity entries shown on the right pane. */
  activity?: { id: string; text: React.ReactNode }[];
  /** External link target for the "Open" footer button. */
  openUrl?: string;
  /** Direct download target. Defaults to `preview.url` for image/pdf. */
  downloadUrl?: string;
}

interface DocPreviewModalProps {
  doc: DocRecord | null;
  onClose: () => void;
}

export function DocPreviewModal({ doc, onClose }: DocPreviewModalProps) {
  React.useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [doc, onClose]);

  if (!doc) return null;

  const downloadUrl =
    doc.downloadUrl ??
    (doc.preview.kind === 'image' || doc.preview.kind === 'pdf' ? doc.preview.url : undefined);

  return (
    <div
      onMouseDown={onClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center p-8"
      style={{ background: 'rgba(15, 17, 22, 0.55)', backdropFilter: 'blur(2px)' }}
      role="dialog"
      aria-modal="true"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="grid w-full max-w-[1080px] h-full max-h-[760px] overflow-hidden rounded-[12px] border border-[var(--border-strong)]"
        style={{
          background: 'var(--bg-surface)',
          gridTemplateColumns: 'minmax(0, 1fr) 320px',
          gridTemplateRows: 'auto minmax(0, 1fr)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
        }}
      >
        {/* Header (spans both columns) */}
        <div
          className="flex items-center justify-between px-[18px] py-3.5 border-b border-[var(--border-hairline)]"
          style={{ gridColumn: '1 / -1' }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <WIcon name="file-text" size={16} color="var(--text-secondary)" />
            <h3 className="m-0 text-[14px] font-semibold text-foreground truncate">{doc.name}</h3>
            <Chip status={doc.status} />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="focus-ring h-6 w-6 inline-flex items-center justify-center rounded text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)]"
          >
            <WIcon name="close" size={14} />
          </button>
        </div>

        {/* Left pane — preview */}
        <div
          className="overflow-auto flex justify-center items-start p-6"
          style={{ background: 'var(--bg-surface-2)' }}
        >
          {doc.preview.kind === 'image' && !doc.preview.url && (
            // R2-backed docs open with an empty URL while the caller
            // exchanges the documentId for a short-lived signed URL —
            // an empty <img src> would request the page URL itself.
            <div className="flex items-center justify-center h-full text-[13px] text-[var(--text-secondary)]">
              Loading preview…
            </div>
          )}
          {doc.preview.kind === 'image' && doc.preview.url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={doc.preview.url}
              alt={doc.name}
              className="max-w-full max-h-full rounded shadow-md object-contain"
              style={{ background: '#fff' }}
            />
          )}
          {doc.preview.kind === 'pdf' && (
            <iframe
              title={doc.name}
              src={doc.preview.url}
              className="w-full h-full rounded border border-[var(--border-hairline)]"
              style={{ background: '#fff' }}
            />
          )}
          {doc.preview.kind === 'text' && (
            <pre className="w-full max-w-[600px] p-4 rounded border border-[var(--border-hairline)] bg-card text-[12.5px] text-foreground whitespace-pre-wrap font-sans m-0">
              {doc.preview.body}
            </pre>
          )}
          {doc.preview.kind === 'placeholder' && (
            <div
              className="w-full max-w-[600px] flex flex-col items-center justify-center gap-3 rounded-lg"
              style={{
                aspectRatio: '8.5 / 11',
                border: '2px dashed var(--border-hairline-strong)',
                background: 'var(--bg-surface)',
                color: 'var(--text-tertiary)',
              }}
            >
              <WIcon name="upload" size={28} color="var(--text-tertiary)" />
              <div className="text-[13px] font-medium">No document on file yet</div>
              <div className="text-[12px]">Drop a file or click upload to attach.</div>
              <WBtn size="sm" leading="plus">{`Upload ${doc.name}`}</WBtn>
            </div>
          )}
        </div>

        {/* Right pane — details + activity + actions */}
        <div className="border-l border-[var(--border-hairline)] flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-[var(--border-hairline)]">
            <div className="text-[10.5px] uppercase tracking-[0.04em] text-[var(--text-tertiary)] mb-2">
              Details
            </div>
            <DSProps
              items={[
                { label: 'Source', value: doc.src },
                {
                  label: 'Received',
                  value: <span className="num">{doc.when}</span>,
                },
                { label: 'Status', value: <Chip status={doc.status} /> },
                {
                  label: 'File',
                  value:
                    doc.preview.kind === 'placeholder'
                      ? '—'
                      : doc.fileLabel
                        ? <span className="num">{doc.fileLabel}</span>
                        : '—',
                },
              ]}
            />
          </div>
          <div className="px-4 py-3 text-[10.5px] uppercase tracking-[0.04em] text-[var(--text-tertiary)]">
            Activity
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-3 text-[12px] text-[var(--text-secondary)]">
            {doc.preview.kind === 'placeholder' ? (
              <p className="m-0 py-2">Awaiting upload — auto-reminder fires 24h before delivery.</p>
            ) : doc.activity && doc.activity.length > 0 ? (
              <ul className="m-0 p-0 list-none">
                {doc.activity.map((a) => (
                  <li
                    key={a.id}
                    className="py-2 border-b border-[var(--border-hairline)] last:border-b-0"
                  >
                    {a.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 py-2">No activity recorded yet.</p>
            )}
          </div>
          <div className="border-t border-[var(--border-hairline)] p-3 flex gap-1.5">
            {downloadUrl ? (
              <a
                href={downloadUrl}
                download
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1"
              >
                <WBtn size="sm" leading="download">
                  Download
                </WBtn>
              </a>
            ) : (
              <WBtn size="sm" leading="download">
                Download
              </WBtn>
            )}
            {doc.openUrl ? (
              <a href={doc.openUrl} target="_blank" rel="noopener noreferrer" className="flex-1">
                <WBtn size="sm" variant="primary">
                  Open
                </WBtn>
              </a>
            ) : (
              <WBtn size="sm" variant="primary">
                Open
              </WBtn>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
