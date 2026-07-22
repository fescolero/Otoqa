/**
 * CommentsThread — full read/write thread for a record.
 *
 * Renders inside the DetailsSlideOver (Comments section) and the
 * DetailsFullPage right rail. List is reactive via Convex; the input is a
 * simple textarea with ⌘↵ to post.
 */

'use client';

import * as React from 'react';
import { useMutation, useQuery } from 'convex/react';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { Avatar, WBtn } from '@/components/web';
import { cn } from '@/lib/utils';

interface CommentsThreadProps {
  entityType: string;
  entityId: string;
  className?: string;
  /** Compose box defaults to focused = false; pass true for the full-page rail. */
  autoFocus?: boolean;
}

export function CommentsThread({ entityType, entityId, className, autoFocus }: CommentsThreadProps) {
  const comments = useQuery(api.comments.listForRecord, { entityType, entityId });
  const add = useMutation(api.comments.addComment);
  const remove = useMutation(api.comments.deleteComment);
  const update = useMutation(api.comments.updateComment);

  const [draft, setDraft] = React.useState('');
  const [posting, setPosting] = React.useState(false);
  const [editingId, setEditingId] = React.useState<Id<'comments'> | null>(null);
  const [editDraft, setEditDraft] = React.useState('');

  const post = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      await add({ entityType, entityId, body });
      setDraft('');
    } catch (e) {
      console.error('[CommentsThread] add failed', e);
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <ol className="flex flex-col gap-3 m-0 p-0 list-none">
        {comments === undefined && (
          <li className="text-[12.5px] text-[var(--text-tertiary)] py-2">Loading…</li>
        )}
        {comments && comments.length === 0 && (
          <li className="text-[12.5px] text-[var(--text-tertiary)] py-2">No comments yet.</li>
        )}
        {comments?.map((c) => {
          const editing = editingId === c._id;
          return (
            <li
              key={c._id}
              className="flex items-start gap-2 rounded-lg border border-[var(--border-hairline)] bg-card p-3"
            >
              <Avatar name={c.authorName} size={26} />
              <div className="flex-1 min-w-0 flex flex-col gap-1">
                <header className="flex items-baseline gap-2">
                  <span className="text-[12.5px] font-semibold text-foreground truncate">{c.authorName}</span>
                  <span className="text-[11px] text-[var(--text-tertiary)]">
                    {formatDistanceToNow(c.createdAt, { addSuffix: true })}
                  </span>
                  {c.editedAt && (
                    <span className="text-[11px] text-[var(--text-tertiary)]">· edited</span>
                  )}
                </header>
                {editing ? (
                  <div className="flex flex-col gap-1.5">
                    <textarea
                      autoFocus
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={3}
                      className="bg-transparent border border-[var(--accent)] rounded p-2 text-[13px] text-foreground resize-y"
                    />
                    <div className="flex items-center gap-1.5">
                      <WBtn
                        size="xs"
                        variant="primary"
                        onClick={async () => {
                          const body = editDraft.trim();
                          if (!body) return;
                          await update({ id: c._id, body });
                          setEditingId(null);
                        }}
                      >
                        Save
                      </WBtn>
                      <WBtn size="xs" variant="ghost" onClick={() => setEditingId(null)}>
                        Cancel
                      </WBtn>
                    </div>
                  </div>
                ) : (
                  <p className="m-0 text-[13px] text-foreground whitespace-pre-line">{c.body}</p>
                )}
              </div>
              {!editing && (
                <ItemMenu
                  onEdit={() => {
                    setEditingId(c._id);
                    setEditDraft(c.body);
                  }}
                  onDelete={async () => {
                    if (!window.confirm('Delete this comment?')) return;
                    await remove({ id: c._id });
                  }}
                />
              )}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-col gap-1.5">
        <textarea
          rows={3}
          value={draft}
          autoFocus={autoFocus}
          placeholder="Add a comment…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void post();
            }
          }}
          className="bg-card border border-[var(--border-hairline)] rounded-lg p-2.5 text-[13px] text-foreground resize-y outline-none focus:border-[var(--accent)]"
        />
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] text-[var(--text-tertiary)]">⌘↵ to post</span>
          <WBtn
            size="sm"
            variant="primary"
            onClick={() => void post()}
            disabled={posting || draft.trim().length === 0}
          >
            {posting ? 'Posting…' : 'Post'}
          </WBtn>
        </div>
      </div>
    </div>
  );
}

function ItemMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="focus-ring h-6 w-6 inline-flex items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
        title="Comment actions"
      >
        ⋯
      </button>
      {open && (
        <div
          className="absolute right-0 top-7 z-10 min-w-[140px] rounded-lg border border-[var(--border-hairline-strong)] bg-card p-1 shadow-[var(--shadow-popover)]"
          onMouseLeave={() => setOpen(false)}
        >
          <button
            type="button"
            onClick={() => {
              onEdit();
              setOpen(false);
            }}
            className="focus-ring w-full px-2.5 py-1.5 rounded text-left text-[12.5px] text-foreground hover:bg-[var(--bg-row-hover)]"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              onDelete();
              setOpen(false);
            }}
            className="focus-ring w-full px-2.5 py-1.5 rounded text-left text-[12.5px] text-[#B43030] hover:bg-[var(--bg-row-hover)]"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
