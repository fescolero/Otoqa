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

  // The banner is shown only when there's an unresumed draft AND the
  // user hasn't acted on it yet AND they haven't started typing.
  //
  // The `!form.dirty` gate is load-bearing. Without it, this race
  // fires on a fresh session:
  //   1. User lands on create page with no prior draft.
  //   2. Banner doesn't show (initialDraft is null), form unlocked.
  //   3. User types — `dirty` flips, autosave queued for 800ms.
  //   4. Autosave writes the (fresh) draft row to Convex.
  //   5. `useAuthQuery(getByEntity)` is reactive — it re-resolves
  //      with that row's data, so `initialDraft` flips null → object.
  //   6. Without the `!dirty` gate, the banner now appears and the
  //      fields lock, trapping the user in a draft they just wrote
  //      themselves a moment ago.
  //
  // With the `!dirty` gate, that scenario is handled correctly:
  //   - On mount with a stale draft and dirty=false, banner shows
  //     and the lock engages — same as before.
  //   - Once the user starts typing (Resume or fresh session), dirty
  //     flips true and STAYS true; the banner does NOT re-appear
  //     even if the underlying Convex row updates from autosave.
  const showDraftBanner = !!initialDraft && !draftActed && !form.dirty;

  // OVERWRITE PROTECTION:
  //
  // When an unresumed draft exists, lock the form. Without this, a
  // user who lands on the create page, sees the banner, ignores it
  // and starts typing fresh data will silently overwrite the draft
  // — the autosave fires 800ms after the first keystroke and the
  // single-row-per-(user, entity, draftKey) storage means the prior
  // draft's contents are clobbered.
  //
  // The lock is `pointer-events: none` on the section stack (clicks
  // dropped, can't focus fields) plus opacity 0.55 (visual cue) plus
  // disabling the Save / Save & New buttons. The banner sits OUTSIDE
  // the locked region so Resume / Discard stay clickable.
  //
  // To start fresh after returning to the page: click Discard. To
  // continue prior work: click Resume.
  const fieldsLocked = showDraftBanner;

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
            // `aria-disabled` mirrors the visual lock for assistive
            // tech. We can't use the `disabled` attribute on a div,
            // and a full <fieldset disabled> wouldn't propagate
            // through every custom control (radix Select, the
            // address autocomplete, etc.) — so we lock at the
            // pointer-events layer instead and let each control
            // remain technically focusable for screen readers in the
            // locked-but-not-disabled state.
            aria-disabled={fieldsLocked || undefined}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              ...(fieldsLocked
                ? {
                    pointerEvents: 'none',
                    opacity: 0.55,
                    transition: 'opacity 200ms ease-out',
                  }
                : { transition: 'opacity 200ms ease-out' }),
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
          // Lock Save buttons while the banner is waiting on a
          // decision. The pointer-events lock above already blocks
          // form mutation; this prevents a confusing "Save" click
          // that fires validation against an empty form.
          isSubmitting={submitting || fieldsLocked}
        />
      </div>
    </div>
  );
}
