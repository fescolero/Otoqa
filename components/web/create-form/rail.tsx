/**
 * TocSidebar — persistent left rail showing every (visible) section as
 * a clickable nav row with a completion / error status dot.
 *
 * Rendering rules (spec §Rail):
 *   - Heading "SECTIONS" — 10.5/600 uppercase, tertiary text.
 *   - Each section row is a button: 8px/10px padding, 12.5px font.
 *     - Active (scroll-spy) row: `--bg-row-hover` bg, weight 600.
 *     - Inactive: weight 500, secondary text.
 *   - Status dot (8px) immediately before the label:
 *     - error      → solid red (#B43030)
 *     - complete   → solid green with white check (every tier1 filled)
 *     - todo       → 1.5px accent ring (has tier1 fields, some still empty)
 *     - no-required→ 1.5px hairline-strong ring
 *   - Error count pill on the right when a section has errors.
 *
 * **Visibility / activeness** are decided by the parent — the rail
 * receives the already-filtered `visibleSections` and the active id.
 * That keeps the scroll-spy state in the form root and the rail
 * dumb-by-design.
 */

'use client';

import * as React from 'react';
import { WIcon } from '@/components/web/icons';
import type {
  CreateFormSchema,
  FormErrors,
  FormSection,
  FormValues,
} from './schema-types';
import { isFieldEmpty } from './field-empty';

interface TocSidebarProps {
  schema: CreateFormSchema;
  /** Already filtered by `section.showIf` in the parent. */
  visibleSections: FormSection[];
  activeId: string | undefined;
  vals: FormValues;
  /** Errors map. Pass `{}` when the form hasn't been submitted yet so
   *  the rail doesn't show red dots before the user has tried to save. */
  errors: FormErrors;
  /** Called when a section row is clicked. Parent owns the scroll. */
  onJump: (sectionId: string) => void;
}

export function TocSidebar({
  schema,
  visibleSections,
  activeId,
  vals,
  errors,
  onJump,
}: TocSidebarProps) {
  return (
    <nav
      aria-label="Form sections"
      style={{
        padding: 6,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-tertiary)',
          padding: '8px 10px 6px',
        }}
      >
        Sections
      </div>

      {visibleSections.map((section) => {
        const status = computeSectionStatus(section, vals, errors);
        const isActive = section.id === activeId;
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => onJump(section.id)}
            className="focus-ring"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 10px',
              borderRadius: 6,
              border: 'none',
              background: isActive ? 'var(--bg-row-hover)' : 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: 12.5,
              fontWeight: isActive ? 600 : 500,
              fontFamily: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
              width: '100%',
            }}
          >
            <StatusDot status={status} />
            <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {section.title}
            </span>
            {status.errorCount > 0 && (
              <span
                aria-label={`${status.errorCount} error${status.errorCount === 1 ? '' : 's'}`}
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: '#B43030',
                  background: 'rgba(180, 48, 48, 0.10)',
                  padding: '1px 6px',
                  borderRadius: 999,
                }}
              >
                {status.errorCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Status computation
 *
 * A section's status is the strongest of:
 *   1. error        → any visible field has a non-null error
 *   2. complete     → has at least one tier1 field AND every visible
 *                     tier1 field is filled
 *   3. has-required → has tier1 fields with some still empty
 *   4. none         → no tier1 fields (purely optional / recommended)
 *
 * Hidden fields (showIf=false) never count — same rule as `validate()`
 * in useFormState. Otherwise a hidden tier1 field would lock the
 * section's dot to "todo" forever with no UI affordance to fill it.
 * ────────────────────────────────────────────────────────────── */

type StatusKind = 'error' | 'complete' | 'has-required' | 'none';

interface SectionStatus {
  kind: StatusKind;
  errorCount: number;
}

function computeSectionStatus(
  section: FormSection,
  vals: FormValues,
  errors: FormErrors,
): SectionStatus {
  let tier1Total = 0;
  let tier1Filled = 0;
  let errorCount = 0;

  for (const field of section.fields ?? []) {
    if (field.showIf && !field.showIf(vals)) continue;
    if (errors[field.id]) errorCount += 1;
    if (field.required === 'tier1') {
      tier1Total += 1;
      if (!isFieldEmpty(field, vals)) tier1Filled += 1;
    }
  }

  if (errorCount > 0) return { kind: 'error', errorCount };
  if (tier1Total === 0) return { kind: 'none', errorCount: 0 };
  if (tier1Filled === tier1Total) return { kind: 'complete', errorCount: 0 };
  return { kind: 'has-required', errorCount: 0 };
}

function StatusDot({ status }: { status: SectionStatus }) {
  const size = 8;

  if (status.kind === 'error') {
    return (
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: '#B43030',
          flexShrink: 0,
        }}
      />
    );
  }

  if (status.kind === 'complete') {
    return (
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: '#0F8C5F',
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <WIcon name="check" size={6} strokeWidth={3} />
      </span>
    );
  }

  // todo (accent ring) vs no-required (hairline ring) — same shape,
  // different border color.
  const ring =
    status.kind === 'has-required'
      ? 'var(--accent)'
      : 'var(--border-hairline-strong)';
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'transparent',
        border: `1.5px solid ${ring}`,
        flexShrink: 0,
      }}
    />
  );
}
