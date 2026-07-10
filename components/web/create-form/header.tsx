/**
 * CreateHeader — non-sticky page header for create flows.
 *
 * Layout (top to bottom):
 *   breadcrumb · · · ·
 *   <title> + autosave indicator (baseline-aligned)
 *   <subtitle>
 *
 * The header is intentionally NOT sticky — only the save bar at the
 * bottom is — so the title scrolls away with the form content. The
 * autosave indicator sits inline with the title rather than docked to
 * a corner: it's the user's signal that their work isn't being lost
 * and needs to live where their eye already is.
 */

'use client';

import * as React from 'react';
import { WIcon } from '@/components/web/icons';
import type { CreateFormSchema, SavingState } from './schema-types';

interface CreateHeaderProps {
  schema: CreateFormSchema;
  savingState: SavingState;
  savedAt: number;
}

export function CreateHeader({ schema, savingState, savedAt }: CreateHeaderProps) {
  return (
    <div
      style={{
        padding: '20px 28px 14px',
        borderBottom: '1px solid var(--border-hairline)',
        background: 'var(--bg-surface)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        {/* Breadcrumb */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            color: 'var(--text-tertiary)',
            marginBottom: 6,
          }}
        >
          {schema.breadcrumb.map((crumb, i) => (
            <React.Fragment key={i}>
              {i > 0 && (
                <WIcon
                  name="chevron-right"
                  size={10}
                  color="var(--text-tertiary)"
                />
              )}
              <span>{crumb}</span>
            </React.Fragment>
          ))}
        </div>

        {/* Title + autosave indicator on the same baseline */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 600,
              margin: 0,
              lineHeight: 1.2,
              color: 'var(--text-primary)',
            }}
          >
            {schema.title}
          </h1>
          <SaveIndicator state={savingState} savedAt={savedAt} />
        </div>

        {schema.subtitle && (
          <p
            style={{
              fontSize: 13,
              color: 'var(--text-secondary)',
              margin: '4px 0 0',
              lineHeight: 1.45,
            }}
          >
            {schema.subtitle}
          </p>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Autosave indicator
 *
 *   saving → pulsing accent dot + "Saving draft…"
 *   saved  → green check + "Draft saved {just now | Ns ago | Nm ago}"
 *   error  → red alert icon + "Couldn't save draft"
 *
 * The relative-time label re-renders every 5 seconds so the user sees
 * the timestamp drift naturally. We do this with a small interval
 * rather than a date library because it's the only place we need it.
 * ────────────────────────────────────────────────────────────────── */

interface SaveIndicatorProps {
  state: SavingState;
  savedAt: number;
}

function SaveIndicator({ state, savedAt }: SaveIndicatorProps) {
  const [, force] = React.useReducer((n: number) => n + 1, 0);

  // Tick once every 5 seconds so the "Ns ago" / "Nm ago" label drifts
  // forward without the rest of the form re-rendering. Only runs in the
  // 'saved' state — we don't need timekeeping while 'saving' or 'error'.
  React.useEffect(() => {
    if (state !== 'saved') return;
    const id = setInterval(() => force(), 5000);
    return () => clearInterval(id);
  }, [state]);

  if (state === 'saving') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: 'var(--text-tertiary)',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--accent)',
            animation: 'create-form-pulse 1.2s ease-in-out infinite',
          }}
        />
        Saving draft…
        <style>{`
          @keyframes create-form-pulse {
            0%, 100% { opacity: 0.4; }
            50%      { opacity: 1; }
          }
        `}</style>
      </span>
    );
  }

  if (state === 'error') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: '#B43030',
        }}
      >
        <WIcon name="alert" size={11} />
        Couldn&apos;t save draft
      </span>
    );
  }

  // 'saved'
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        color: 'var(--text-tertiary)',
      }}
    >
      <WIcon name="check" size={10} color="#0F8C5F" />
      Draft saved {formatRelativeSince(savedAt)}
    </span>
  );
}

function formatRelativeSince(timestamp: number): string {
  if (!timestamp) return 'just now';
  const ms = Date.now() - timestamp;
  if (ms < 10_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}
