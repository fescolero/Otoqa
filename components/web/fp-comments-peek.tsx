/**
 * FPCommentsPeek — right-rail teaser card for the Comments thread.
 *
 *   <FPCommentsPeek
 *     count={4}
 *     latest={{ author: 'Erin Holcomb', body: 'Driver flagged a long idle…', when: '2h ago' }}
 *     onOpen={() => setCommentsOpen(true)}
 *   />
 *
 * Mirrors the design's `FPCommentsPeek`: a compact card that shows the most
 * recent comment + count, with an "Open →" link to expand the full thread.
 */

'use client';

import * as React from 'react';
import { Avatar } from './avatar';
import { WIcon } from './icons';

interface FPCommentsPeekProps {
  count: number;
  latest?: {
    author: string;
    body: React.ReactNode;
    when: string;
  };
  onOpen?: () => void;
}

export function FPCommentsPeek({ count, latest, onOpen }: FPCommentsPeekProps) {
  return (
    <div className="rounded-[10px] border border-[var(--border-hairline)] bg-card px-3.5 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <WIcon name="chat" size={13} color="var(--text-secondary)" />
          <div className="text-[12px] font-semibold tracking-[0.02em]">Comments</div>
          <span className="num text-[11px] text-[var(--text-tertiary)]">{count}</span>
        </div>
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="focus-ring text-[11.5px] font-medium text-[var(--accent)] hover:underline bg-transparent border-0 p-0 cursor-pointer"
          >
            Open →
          </button>
        )}
      </div>
      {latest ? (
        <div className="flex items-center gap-2">
          <Avatar name={latest.author} size={22} />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] text-[var(--text-secondary)] leading-[17px] truncate">
              <span className="text-foreground font-semibold">
                {latest.author.split(' ')[0]}
              </span>
              : {latest.body}
            </div>
            <div className="num text-[10.5px] text-[var(--text-tertiary)] mt-px">
              {latest.when}
            </div>
          </div>
        </div>
      ) : (
        <div className="text-[12px] text-[var(--text-tertiary)] italic">No comments yet.</div>
      )}
    </div>
  );
}
