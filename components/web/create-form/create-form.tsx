/**
 * CreateForm — the universal create-flow shell.
 *
 * Layout (Rule 1, enforced here verbatim):
 *
 *   ┌────────────────────────────────────────────────┐
 *   │  HEADER  breadcrumb · title · autosave         │  (non-sticky)
 *   ├──────────┬─────────────────────────────────────┤
 *   │  RAIL    │   CONTENT                            │
 *   │ (sticky) │   ┌──────────────────────────────┐  │
 *   │          │   │ ASectionCard (full width)    │  │
 *   │          │   │   fields on auto-fill grid   │  │
 *   │          │   └──────────────────────────────┘  │
 *   │          │   …more cards…                       │
 *   ├──────────┴─────────────────────────────────────┤
 *   │  STICKY SAVE BAR                                │  (sticky)
 *   └────────────────────────────────────────────────┘
 *
 * Degenerate case — a schema with one section hides the rail and caps
 * the field grid at three columns so the lone card doesn't look like
 * a spreadsheet (spec §Degenerate case).
 *
 * The shell never imports from `convex/_generated/api`. Page wrappers
 * own the mutation calls in `onSaved`.
 */

'use client';

import * as React from 'react';
import { CreateHeader } from './header';
import { TocSidebar } from './rail';
import { ASectionCard } from './section-card';
import { ErrorSummary } from './error-summary';
import { StickySaveBar } from './sticky-save-bar';
import { DraftResumeBanner } from './draft-resume-banner';
import { renderField, fieldLabels } from './render-field';
import { useFormState } from './use-form-state';
import { fieldGridStyle, fieldGridStyleCapped } from './field-grid';
import {
  useScrollSpy,
  scrollToSection,
  jumpToField,
} from './scroll-spy';
import type {
  CreateFormSchema,
  FormValues,
} from './schema-types';

/**
 * A draft loaded from the server-side `createDrafts` table. Pass this
 * to `<CreateForm>` to render the resume banner. When null, no banner
 * appears and the form seeds from `initialValues` (or schema defaults).
 */
export interface CreateFormDraft {
  vals: FormValues;
  updatedAt: number;
}

interface CreateFormProps {
  schema: CreateFormSchema;
  onSaved: (
    vals: FormValues,
    andNew: boolean,
  ) => Promise<void> | void;
  onCancel?: () => void;
  /** Seed values for the very first render (e.g. duplicating an
   *  existing record). Distinct from drafts — see `initialDraft`. */
  initialValues?: FormValues;
  /**
   * Server-side draft for the resume banner. The shell shows a banner
   * when this is non-null AND the form is not yet dirty; Resume calls
   * `form.resumeFrom(initialDraft.vals)`, Discard fires
   * `onDraftDiscard`.
   */
  initialDraft?: CreateFormDraft | null;
  /**
   * Called 800ms after every edit. The page wrapper upserts the
   * draft to Convex inside this callback. Throwing flips the autosave
   * indicator to `'error'` but doesn't block Save.
   */
  onAutosave?: (vals: FormValues) => Promise<void>;
  /**
   * Called when the user clicks Discard on the resume banner OR after
   * a successful Save (the draft is now redundant). Page wrapper
   * deletes the Convex row.
   */
  onDraftDiscard?: () => Promise<void>;
}

export function CreateForm({
  schema,
  onSaved,
  onCancel,
  initialValues,
  initialDraft,
  onAutosave,
  onDraftDiscard,
}: CreateFormProps) {
  const form = useFormState(schema, initialValues, { onAutosave });

  // The banner is dismissed locally once the user acts on it
  // (Resume / Discard) — even if the underlying query later
  // re-resolves with a non-null draft (it won't, after Discard, but
  // could after a subsequent autosave round). Persisting this in
  // component state avoids re-flashing the banner mid-session.
  const [draftActed, setDraftActed] = React.useState(false);

  // Once typing starts, drop the banner — the user has implicitly
  // chosen to start fresh. Without this, Resume after typing would
  // overwrite their fresh edits.
  const showDraftBanner =
    !!initialDraft && !draftActed && !form.dirty;

  // Visible sections — recompute on every value change so progressive
  // disclosure stays consistent with the rail and validation.
  const visibleSections = React.useMemo(
    () =>
      schema.sections.filter(
        (s) => !s.showIf || s.showIf(form.vals),
      ),
    [schema.sections, form.vals],
  );

  const [activeId, setActiveId] = React.useState<string | undefined>(
    visibleSections[0]?.id,
  );

  // If the active section gets hidden by progressive disclosure,
  // fall back to the first visible section so the rail can't point at
  // nothing.
  React.useEffect(() => {
    if (!activeId) return;
    if (!visibleSections.some((s) => s.id === activeId)) {
      setActiveId(visibleSections[0]?.id);
    }
  }, [activeId, visibleSections]);

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const visibleIds = visibleSections.map((s) => s.id);
  useScrollSpy(containerRef, visibleIds, setActiveId);

  const labels = React.useMemo(() => fieldLabels(schema), [schema]);

  const [submitting, setSubmitting] = React.useState(false);

  const runSave = React.useCallback(
    async (andNew: boolean) => {
      const errs = form.validate();
      form.setErrors(errs);
      form.setSubmitted(true);
      const failedIds = Object.keys(errs).filter((id) => errs[id]);
      if (failedIds.length > 0) {
        // Defer one tick so the freshly-rendered error elements exist
        // before we scroll to them.
        setTimeout(() => jumpToField(failedIds[0]), 50);
        return;
      }
      setSubmitting(true);
      try {
        await onSaved(form.vals, andNew);
        // Draft is now redundant — the form is a real record. Fire and
        // forget; if the discard fails the 30-day cron sweeps it up.
        if (onDraftDiscard) {
          try {
            await onDraftDiscard();
          } catch (err) {
            console.warn('[create-form] draft discard failed (non-blocking)', err);
          }
        }
        if (andNew) form.reset();
      } finally {
        setSubmitting(false);
      }
    },
    [form, onSaved, onDraftDiscard],
  );

  const singleSection = visibleSections.length <= 1;
  const gridStyle = singleSection ? fieldGridStyleCapped : fieldGridStyle;

  // Scroll-container ref points at the INNER content column. Putting
  // overflow:auto on the outer container is fragile: the outer's height
  // is set by its parent's flex chain, and the AppShell's right column
  // lacks `min-h-0` so the chain can fail to bound — outer ends up
  // sized by its own content and never scrolls. The inner main column
  // here lives inside a `flex-1; min-h-0; overflow:hidden` grid, so
  // its own `overflow-y:auto` is unconditional and works at every
  // viewport size. (Rail stays in its grid cell — no `position:sticky`
  // needed because the scroll axis is INSIDE the grid, not outside.)
  return (
    <div
      style={{
        height: '100%',
        minHeight: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-canvas)',
        overflow: 'hidden',
      }}
    >
      <CreateHeader
        schema={schema}
        savingState={form.savingState}
        savedAt={form.savedAt}
      />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          // Rule 1: 220px rail + remaining column. Hidden in the
          // degenerate one-section case.
          gridTemplateColumns: singleSection
            ? 'minmax(0, 1fr)'
            : '220px minmax(0, 1fr)',
          gap: 28,
          padding: '24px 28px 0',
          alignItems: 'start',
          overflow: 'hidden',
        }}
      >
        {!singleSection && (
          <aside style={{ alignSelf: 'start' }}>
            <TocSidebar
              schema={schema}
              visibleSections={visibleSections}
              activeId={activeId}
              vals={form.vals}
              errors={form.submitted ? form.errors : {}}
              onJump={(id) => scrollToSection(containerRef.current, id)}
            />
          </aside>
        )}

        <main
          ref={containerRef}
          className="scroll-hidden"
          style={{
            minWidth: 0,
            height: '100%',
            overflowY: 'auto',
            paddingBottom: 24,
          }}
        >
          {showDraftBanner && initialDraft && (
            <DraftResumeBanner
              updatedAt={initialDraft.updatedAt}
              onResume={() => {
                form.resumeFrom(initialDraft.vals);
                setDraftActed(true);
              }}
              onDiscard={() => {
                setDraftActed(true);
                if (onDraftDiscard) {
                  onDraftDiscard().catch((err) =>
                    console.warn(
                      '[create-form] draft discard failed (non-blocking)',
                      err,
                    ),
                  );
                }
              }}
            />
          )}
          {form.submitted && (
            <ErrorSummary
              errors={form.errors}
              fieldLabels={labels}
              onJump={jumpToField}
            />
          )}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            {visibleSections.map((section) => (
              <ASectionCard
                key={section.id}
                id={section.id}
                title={section.title}
                subtitle={section.subtitle}
                accent={section.accent}
              >
                <div style={gridStyle}>
                  {(section.fields ?? []).map((field) =>
                    renderField({
                      field,
                      vals: form.vals,
                      set: form.set,
                      blur: form.blur,
                      errors: form.submitted ? form.errors : {},
                    }),
                  )}
                </div>
              </ASectionCard>
            ))}
          </div>
        </main>
      </div>

      <div style={{ flexShrink: 0 }}>
        <StickySaveBar
          schema={schema}
          vals={form.vals}
          errors={form.errors}
          onCancel={onCancel}
          onSave={() => runSave(false)}
          onSaveAndNew={() => runSave(true)}
          isSubmitting={submitting}
        />
      </div>
    </div>
  );
}
