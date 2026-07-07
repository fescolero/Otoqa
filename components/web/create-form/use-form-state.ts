/**
 * useFormState — the create-form state machine.
 *
 * Ported from `record-create-shell.jsx` (`useFormState`) in the design
 * bundle. Owns:
 *   - `vals`        — flat `{ [fieldId]: value }` seeded from each
 *                     field's `default` (or kind-appropriate empty)
 *   - `errors`      — `{ [fieldId]: message | null }` map (cleared on
 *                     edit; populated by Save)
 *   - `touched`     — `{ [fieldId]: bool }` set on blur (not currently
 *                     used for rendering; reserved)
 *   - `submitted`   — gates whether the error summary + per-field error
 *                     messages render
 *   - `savingState` — `'saved' | 'saving' | 'error'` driving the
 *                     autosave indicator
 *
 * Phase-1 scope: the autosave effect only flips the indicator state. It
 * does NOT write to Convex. Phase 4 adds the drafts-table wiring for
 * long forms (Carrier, Customer, Driver, Load) via `schema.draftKey`.
 *
 * Two correctness rules to preserve when refactoring:
 *
 *   1. `validate()` MUST skip fields and sections that are hidden by
 *      `showIf`. Otherwise a hidden tier1 field can permanently block
 *      Save with no UI affordance to reach it.
 *
 *   2. `set()` clears the field's error so the user sees immediate
 *      feedback when they fix a mistake — without waiting for the next
 *      Save attempt.
 */

'use client';

import * as React from 'react';
import type {
  CreateFormSchema,
  FormField,
  FormValues,
  FormErrors,
  SavingState,
} from './schema-types';
import { isFieldEmpty } from './field-empty';

/** Initial value for a field whose schema declares no `default`. */
function emptyForKind(field: FormField): unknown {
  switch (field.kind) {
    case 'toggle':
      return false;
    case 'stops-list':
      return [];
    default:
      return '';
  }
}

// `isFieldEmpty` lives in `./field-empty` — see that module's header
// for the rationale. The rail and save bar import it too so all three
// surfaces agree on what "missing" means.

/** 800ms after the last change, the autosave indicator flips back to
 *  'saved'. Matches the design spec exactly. */
const AUTOSAVE_DEBOUNCE_MS = 800;

export interface UseFormStateReturn {
  vals: FormValues;
  errors: FormErrors;
  touched: Record<string, boolean>;
  submitted: boolean;
  savingState: SavingState;
  savedAt: number;
  /** True once the user has made at least one edit since mount or `reset`. */
  dirty: boolean;
  /** Update a single field's value and clear its pending error. */
  set: (id: string, value: unknown) => void;
  /** Mark a field as touched (used by blur handlers). */
  blur: (id: string) => void;
  /** Run validation. Returns the error map (also call `setErrors` /
   *  `setSubmitted` separately to actually surface them). */
  validate: () => FormErrors;
  /** Replace the error map (typically with the result of `validate()`). */
  setErrors: (errs: FormErrors) => void;
  /** Flip the submitted flag after a Save attempt — gates the error UI. */
  setSubmitted: (next: boolean) => void;
  /** Reset every field back to its initial seed (used by Save & New). */
  reset: () => void;
  /**
   * Replace `vals` with a draft restored from server-side persistence
   * WITHOUT flipping `dirty`. Used by the resume-banner so a successful
   * Resume click doesn't immediately trigger another autosave round-trip
   * writing back the same data we just read.
   */
  resumeFrom: (vals: FormValues) => void;
}

export interface UseFormStateOptions {
  /**
   * Called 800ms after the last edit. The shell awaits this and flips
   * the autosave indicator to `'saved'` on resolve / `'error'` on throw.
   * Wrap the underlying mutation in a stable ref OR pass an inline arrow
   * either way — `useFormState` stores the latest reference internally,
   * so a new function identity per render does NOT re-arm the debounce
   * timer (which would silently break the save during continuous typing).
   */
  onAutosave?: (vals: FormValues) => Promise<void>;
}

export function useFormState(
  schema: CreateFormSchema,
  initial?: FormValues,
  opts?: UseFormStateOptions,
): UseFormStateReturn {
  // Seed `vals` exactly once from the schema + caller-supplied initial.
  // We deliberately don't include `initial` in the deps so a parent
  // re-rendering with a new (but value-equal) initial object doesn't
  // wipe the form.
  const seed = React.useMemo<FormValues>(() => {
    const out: FormValues = { ...(initial ?? {}) };
    for (const section of schema.sections) {
      for (const field of section.fields ?? []) {
        if (!(field.id in out)) {
          out[field.id] = field.default ?? emptyForKind(field);
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [vals, setVals] = React.useState<FormValues>(seed);
  const [errors, setErrorsState] = React.useState<FormErrors>({});
  const [touched, setTouched] = React.useState<Record<string, boolean>>({});
  const [submitted, setSubmittedState] = React.useState(false);
  const [savingState, setSavingState] = React.useState<SavingState>('saved');
  const [savedAt, setSavedAt] = React.useState<number>(0);
  const [dirty, setDirty] = React.useState(false);

  // Initialize `savedAt` to the mount time on the client only. We can't
  // `Date.now()` during the initial render because that would mismatch
  // SSR hydration; instead seed it once in a layout effect.
  React.useLayoutEffect(() => {
    if (savedAt === 0) setSavedAt(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hold the latest `onAutosave` in a ref so the autosave effect's deps
  // can stay narrow. If we listed `onAutosave` directly, every
  // re-render where the page wrapper passes an inline arrow would
  // produce a new function identity → effect tears down → timer is
  // canceled → autosave never actually fires during continuous typing.
  // This is the documented escape hatch for "I want fresh values but
  // not fresh dep deltas".
  const onAutosaveRef = React.useRef<UseFormStateOptions['onAutosave']>(
    opts?.onAutosave,
  );
  React.useEffect(() => {
    onAutosaveRef.current = opts?.onAutosave;
  });

  // Autosave — when `vals` changes after a user edit, flip indicator
  // to 'saving' and schedule a flip back after the debounce. Any
  // further change during the debounce window restarts the timer (the
  // cleanup clears the old timeout). If `onAutosave` was provided we
  // also await it inside the timer and surface failure as the 'error'
  // indicator state; the page wrapper can layer a toast on top if
  // visibility matters more than the corner pulse.
  React.useEffect(() => {
    if (!dirty) return;
    setSavingState('saving');
    const t = setTimeout(async () => {
      try {
        if (onAutosaveRef.current) {
          await onAutosaveRef.current(vals);
        }
        setSavingState('saved');
        setSavedAt(Date.now());
      } catch (err) {
        // Keep the failure quiet here — page wrappers that care can
        // wire their own toast. The indicator's red icon is the
        // user-visible signal.
        console.error('[create-form] autosave failed', err);
        setSavingState('error');
      }
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [vals, dirty]);

  const set = React.useCallback((id: string, value: unknown) => {
    setVals((prev) => {
      // Skip the state update (and the autosave cycle) when the value
      // doesn't actually change — avoids spurious "Saving…" flickers
      // when a controlled input re-emits its current value.
      if (Object.is(prev[id], value)) return prev;
      return { ...prev, [id]: value };
    });
    setDirty(true);
    // Clear the pending error so the user gets immediate feedback when
    // they fix a mistake. Only mutate state if there was actually an
    // error there to clear.
    setErrorsState((prev) => (prev[id] ? { ...prev, [id]: null } : prev));
  }, []);

  const blur = React.useCallback((id: string) => {
    setTouched((prev) => (prev[id] ? prev : { ...prev, [id]: true }));
  }, []);

  const validate = React.useCallback((): FormErrors => {
    const errs: FormErrors = {};
    for (const section of schema.sections) {
      // Hidden sections contribute no validation — their fields don't
      // count toward "fields needed to save."
      if (section.showIf && !section.showIf(vals)) continue;
      for (const field of section.fields ?? []) {
        if (field.showIf && !field.showIf(vals)) continue;

        if (field.required === 'tier1') {
          const isEmpty = isFieldEmpty(field, vals);
          if (isEmpty) {
            errs[field.id] =
              field.requiredMsg ?? `${field.label} is required to save.`;
          }
        }

        if (field.validate) {
          const msg = field.validate(vals[field.id], vals);
          if (msg) errs[field.id] = msg;
        }
      }
    }
    return errs;
  }, [schema, vals]);

  const setErrors = React.useCallback((errs: FormErrors) => {
    setErrorsState(errs);
  }, []);

  const setSubmitted = React.useCallback((next: boolean) => {
    setSubmittedState(next);
  }, []);

  const reset = React.useCallback(() => {
    setVals(seed);
    setErrorsState({});
    setTouched({});
    setSubmittedState(false);
    setDirty(false);
    setSavingState('saved');
    setSavedAt(Date.now());
  }, [seed]);

  // Restore a draft without flipping `dirty`. The autosave effect gates
  // on `dirty`, so doing this through `set()` (which sets dirty) would
  // immediately trigger an autosave that writes back the data we just
  // read — wasteful and easy to confuse during debugging.
  const resumeFrom = React.useCallback((next: FormValues) => {
    setVals(next);
    setErrorsState({});
    setSubmittedState(false);
    // Intentionally NOT touching `dirty`. The next user edit will flip
    // it via `set()` like any other change.
  }, []);

  return {
    vals,
    errors,
    touched,
    submitted,
    savingState,
    savedAt,
    dirty,
    set,
    blur,
    validate,
    setErrors,
    setSubmitted,
    reset,
    resumeFrom,
  };
}
