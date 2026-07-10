/**
 * useCreateDraft — page-wrapper helper that bridges Convex
 * `createDrafts` to the `<CreateForm>` shell's three draft props.
 *
 * Usage:
 *
 *   const draftProps = useCreateDraft({ entity: 'carrier', draftKey: 'carrier-create-v1' });
 *   ...
 *   <CreateForm schema={schema} {...draftProps} onSaved={...} />
 *
 * Returns null-valued props when the org context isn't ready — the
 * shell's draft features stay disabled until the user is signed in.
 *
 * Stale-closure note: the shell stores `onAutosave` in a ref, so the
 * fact that this hook returns a fresh callback identity every render
 * does NOT cancel the autosave debounce timer. See
 * `use-form-state.ts` for the receive-side pattern.
 *
 * See `docs/schema-evolution.md` for when to bump `draftKey`.
 */

'use client';

import * as React from 'react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';
import type { CreateFormDraft, FormValues } from '@/components/web/create-form';

interface UseCreateDraftArgs {
  /** Entity name — matches `schema.entity`. Used as a coarse partition. */
  entity: string;
  /** Schema's `draftKey` — bump on breaking schema changes. */
  draftKey: string;
}

export interface UseCreateDraftResult {
  /** Pass to `<CreateForm initialDraft={...}/>`. */
  initialDraft: CreateFormDraft | null;
  /** Pass to `<CreateForm onAutosave={...}/>`. No-op until org is loaded. */
  onAutosave: (vals: FormValues) => Promise<void>;
  /** Pass to `<CreateForm onDraftDiscard={...}/>`. No-op until org is loaded. */
  onDraftDiscard: () => Promise<void>;
}

export function useCreateDraft({
  entity,
  draftKey,
}: UseCreateDraftArgs): UseCreateDraftResult {
  const organizationId = useOrganizationId();
  const upsertDraft = useMutation(api.createDrafts.upsert);
  const discardDraft = useMutation(api.createDrafts.discard);

  const draftQ = useAuthQuery(
    api.createDrafts.getByEntity,
    organizationId
      ? { workosOrgId: organizationId, entity, draftKey }
      : 'skip',
  );

  const initialDraft = React.useMemo<CreateFormDraft | null>(() => {
    if (!draftQ) return null;
    try {
      const parsed = JSON.parse(draftQ.vals) as FormValues;
      return { vals: parsed, updatedAt: draftQ.updatedAt };
    } catch (err) {
      // Corrupted draft (manual DB edit, unicode-mangled storage…).
      // Rather than show a stale-resume option that crashes on apply,
      // treat as no-draft. The next autosave will overwrite the bad row.
      console.warn('[create-form] failed to parse draft vals; ignoring', err);
      return null;
    }
  }, [draftQ]);

  const onAutosave = React.useCallback(
    async (vals: FormValues) => {
      if (!organizationId) return;
      await upsertDraft({
        workosOrgId: organizationId,
        entity,
        draftKey,
        vals: JSON.stringify(vals),
      });
    },
    [organizationId, entity, draftKey, upsertDraft],
  );

  const onDraftDiscard = React.useCallback(async () => {
    if (!organizationId) return;
    await discardDraft({
      workosOrgId: organizationId,
      entity,
      draftKey,
    });
  }, [organizationId, entity, draftKey, discardDraft]);

  return { initialDraft, onAutosave, onDraftDiscard };
}
