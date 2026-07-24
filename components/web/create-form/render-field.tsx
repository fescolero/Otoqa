/**
 * renderField — dispatcher that maps a `FormField` to the right
 * control component. Kept separate from `create-form.tsx` so it stays
 * unit-testable in isolation.
 *
 * Decisions encoded here:
 *
 *  - `address` and `stops-list` always force `full` (grid-column: 1/-1)
 *    regardless of any `span` set on the field — composite kinds
 *    occupy the full row.
 *  - `dupCheck` runs synchronously against current `vals` and renders
 *    its result via DuplicateAlert beneath the control.
 *  - `showIf` is checked first; returning `null` causes the parent
 *    grid to skip the slot entirely (`auto-fill` still works as a
 *    "filled" tracks would).
 */

'use client';

import * as React from 'react';
import { AField } from './field';
import { DuplicateAlert } from './duplicate-alert';
import { TextControl } from './controls/text';
import { MonoControl } from './controls/mono';
import { NumberControl } from './controls/number';
import { CurrencyControl } from './controls/currency';
import { DateControl } from './controls/date';
import { SelectControl } from './controls/select';
import { SegmentedControl } from './controls/segmented';
import { ToggleControl } from './controls/toggle';
import { TextareaControl } from './controls/textarea';
import { FileControl } from './controls/file';
import { AddressControl } from './controls/address';
import {
  StopsListControl,
  type StopsListItem,
} from './controls/stops-list';
import {
  LaneStopsControl,
  type LaneStopItem,
} from './controls/lane-stops';
import { DaysControl } from './controls/days';
import type {
  FormField,
  FormValues,
  FormErrors,
} from './schema-types';

interface RenderFieldArgs {
  field: FormField;
  vals: FormValues;
  set: (id: string, value: unknown) => void;
  blur: (id: string) => void;
  errors: FormErrors;
}

export function renderField({
  field,
  vals,
  set,
  blur,
  errors,
}: RenderFieldArgs): React.ReactElement | null {
  if (field.showIf && !field.showIf(vals)) return null;

  const error = errors[field.id] ?? null;
  const v = vals[field.id];
  const composite =
    field.kind === 'address' ||
    field.kind === 'stops-list' ||
    field.kind === 'lane-stops';

  // Duplicate check runs against the current value; not debounced here
  // because the schema author's predicate is the one that should
  // decide cheapness (most use prefix matches over already-loaded
  // arrays).
  const dupMatch = field.dupCheck && v ? field.dupCheck(v, vals) : null;
  const after = dupMatch ? <DuplicateAlert match={dupMatch} /> : null;

  let control: React.ReactNode = null;

  switch (field.kind) {
    case 'mono':
      control = (
        <MonoControl
          id={field.id}
          value={String(v ?? '')}
          onChange={(next) => set(field.id, next)}
          onBlur={() => blur(field.id)}
          placeholder={field.placeholder}
          prefix={field.prefix}
          suffix={field.suffix}
          hasError={!!error}
        />
      );
      break;

    case 'number':
      control = (
        <NumberControl
          id={field.id}
          value={typeof v === 'number' ? v : undefined}
          onChange={(next) => set(field.id, next ?? '')}
          onBlur={() => blur(field.id)}
          placeholder={field.placeholder}
          prefix={field.prefix}
          suffix={field.suffix}
          hasError={!!error}
          grouping={field.grouping}
        />
      );
      break;

    case 'currency':
      control = (
        <CurrencyControl
          id={field.id}
          value={typeof v === 'number' ? v : undefined}
          onChange={(next) => set(field.id, next ?? '')}
          onBlur={() => blur(field.id)}
          placeholder={field.placeholder}
          suffix={field.suffix}
          hasError={!!error}
        />
      );
      break;

    case 'date':
      control = (
        <DateControl
          id={field.id}
          value={String(v ?? '')}
          onChange={(next) => set(field.id, next)}
          placeholder={field.placeholder}
          hasError={!!error}
        />
      );
      break;

    case 'select':
      control = (
        <SelectControl
          id={field.id}
          value={String(v ?? '')}
          onChange={(next) => set(field.id, next)}
          options={field.options ?? []}
          placeholder={field.placeholder}
          hasError={!!error}
        />
      );
      break;

    case 'segmented':
      control = (
        <SegmentedControl
          id={field.id}
          value={String(v ?? '')}
          onChange={(next) => set(field.id, next)}
          options={field.options ?? []}
        />
      );
      break;

    case 'toggle':
      control = (
        <ToggleControl
          id={field.id}
          value={Boolean(v)}
          onChange={(next) => set(field.id, next)}
          toggleLabel={field.toggleLabel}
        />
      );
      break;

    case 'textarea':
      control = (
        <TextareaControl
          id={field.id}
          value={String(v ?? '')}
          onChange={(next) => set(field.id, next)}
          onBlur={() => blur(field.id)}
          placeholder={field.placeholder}
          rows={field.rows}
          hasError={!!error}
        />
      );
      break;

    case 'file':
      control = (
        <FileControl
          id={field.id}
          value={String(v ?? '')}
          onChange={(next) => set(field.id, next)}
          uploader={field.uploader}
          accept={field.accept}
          hint={field.hint}
          hasError={!!error}
        />
      );
      break;

    case 'address':
      if (!field.ids) {
        // Schema author forgot to wire `ids`. Render a tombstone so
        // they notice immediately instead of a silent empty row.
        control = (
          <div style={{ color: '#B43030', fontSize: 12 }}>
            address field is missing `ids` mapping
          </div>
        );
      } else {
        control = (
          <AddressControl
            ids={field.ids}
            vals={vals}
            set={set}
            errors={errors}
          />
        );
      }
      break;

    case 'stops-list':
      control = (
        <StopsListControl
          id={field.id}
          value={Array.isArray(v) ? (v as StopsListItem[]) : []}
          onChange={(next) => set(field.id, next)}
        />
      );
      break;

    case 'lane-stops':
      control = (
        <LaneStopsControl
          id={field.id}
          value={Array.isArray(v) ? (v as LaneStopItem[]) : []}
          onChange={(next) => set(field.id, next)}
          facilities={field.facilities}
        />
      );
      break;

    case 'days':
      control = (
        <DaysControl
          id={field.id}
          value={Array.isArray(v) ? (v as number[]) : []}
          onChange={(next) => set(field.id, next)}
        />
      );
      break;

    case 'text':
    default:
      control = (
        <TextControl
          id={field.id}
          value={String(v ?? '')}
          onChange={(next) => set(field.id, next)}
          onBlur={() => blur(field.id)}
          placeholder={field.placeholder}
          hasError={!!error}
          format={field.format}
        />
      );
  }

  return (
    <AField
      key={field.id}
      id={field.id}
      label={field.label}
      hint={field.hint}
      error={error}
      required={field.required}
      recommended={field.recommended}
      span={field.span}
      full={composite}
      after={after}
    >
      {control}
    </AField>
  );
}

/** Build the field-id → label map used by ErrorSummary. */
export function fieldLabels(
  schema: import('./schema-types').CreateFormSchema,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const section of schema.sections) {
    for (const field of section.fields ?? []) {
      out[field.id] = field.label;
    }
  }
  return out;
}
