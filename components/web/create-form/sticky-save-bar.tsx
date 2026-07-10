/**
 * StickySaveBar — bottom-docked action bar shared by every create form.
 *
 * Layout (left → right):
 *   <quiet status>         "N required fields remain" / "Ready to save"
 *   <spacer>
 *   Cancel       ghost
 *   Save & new   secondary
 *   Save         primary (accent)
 *
 * The bar is `position: sticky; bottom: 0` so it stays at the bottom of
 * the viewport while the form scrolls. Validation lives in the parent
 * — this component only displays the count and dispatches click events.
 */

'use client';

import * as React from 'react';
import { WBtn } from '@/components/web/btn';
import type {
  CreateFormSchema,
  FormErrors,
  FormValues,
} from './schema-types';
import { isFieldEmpty } from './field-empty';

interface StickySaveBarProps {
  schema: CreateFormSchema;
  vals: FormValues;
  errors: FormErrors;
  onCancel?: () => void;
  onSave: () => void;
  onSaveAndNew: () => void;
  /** Disable both save buttons (e.g. while the mutation is in flight). */
  isSubmitting?: boolean;
}

export function StickySaveBar({
  schema,
  vals,
  errors,
  onCancel,
  onSave,
  onSaveAndNew,
  isSubmitting,
}: StickySaveBarProps) {
  const remaining = countTier1Remaining(schema, vals);
  const errorCount = Object.values(errors).filter(Boolean).length;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 28px',
        background: 'var(--bg-surface)',
        borderTop: '1px solid var(--border-hairline)',
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
        {statusText(remaining, errorCount)}
      </span>
      <div style={{ flex: 1 }} />
      {onCancel && (
        <WBtn variant="ghost" size="sm" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </WBtn>
      )}
      <WBtn
        variant="secondary"
        size="sm"
        onClick={onSaveAndNew}
        disabled={isSubmitting}
      >
        Save &amp; new
      </WBtn>
      <WBtn variant="primary" size="sm" onClick={onSave} disabled={isSubmitting}>
        Save
      </WBtn>
    </div>
  );
}

function statusText(remaining: number, errorCount: number): string {
  if (errorCount > 0) {
    return `${errorCount} field${errorCount === 1 ? '' : 's'} need attention`;
  }
  if (remaining === 0) return 'Ready to save';
  return `${remaining} required field${remaining === 1 ? '' : 's'} remain`;
}

/** Count tier1 fields that are still empty, respecting `showIf` on
 *  both fields and sections. Shares `isFieldEmpty` with `validate()`
 *  and the rail so the three surfaces always agree. */
function countTier1Remaining(
  schema: CreateFormSchema,
  vals: FormValues,
): number {
  let n = 0;
  for (const section of schema.sections) {
    if (section.showIf && !section.showIf(vals)) continue;
    for (const field of section.fields ?? []) {
      if (field.showIf && !field.showIf(vals)) continue;
      if (field.required !== 'tier1') continue;
      if (isFieldEmpty(field, vals)) n += 1;
    }
  }
  return n;
}
