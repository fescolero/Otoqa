'use client';

import * as React from 'react';

/** The shape every optimistic-concurrency record shares. */
type Revisioned = { _id: string; updatedAt: number };

/**
 * Latches the `updatedAt` revision an edit form was SEEDED from, so the
 * value sent as `expectedUpdatedAt` describes what the user actually saw.
 *
 * Two failure modes this exists to sit between, both of which have already
 * shipped once:
 *
 *  1. Passing `record.updatedAt` straight from `useAuthQuery`. That query is
 *     reactive, so when another writer touches the row the value silently
 *     becomes the server's CURRENT revision — the staleness check compares
 *     equal and never fires. That is the bug the guard exists to catch.
 *
 *  2. Latching once per component instance (`if (current === undefined)`).
 *     The edit pages are NOT remounted when the user navigates between two
 *     records in the same SPA session — that is precisely why the form shell
 *     below them is keyed on the record id. A once-only latch therefore keeps
 *     the FIRST record's revision and sends it when saving the second, and
 *     the server rejects a write that was never stale.
 *
 * Latching per record id threads between them: the revision is captured with
 * the values the form seeds from, and re-captured only when the identity of
 * the record changes — never when the same row's revision moves underneath
 * us, which is the case the guard must still catch.
 *
 * Returns `undefined` until a record has loaded. That is also the mutations'
 * "omit the check" signal, which is correct here: with no record there is no
 * seeded revision to defend, and the form cannot have been submitted yet.
 */
export function useSeededRevision(
  record: Revisioned | null | undefined,
): number | undefined {
  const [seeded, setSeeded] = React.useState<Revisioned | null>(null);

  // Adjusted during render rather than in an effect — React's documented
  // pattern for "reset state when a prop changes". The revision has to be
  // latched in the same pass that seeds the form's values: an effect would
  // commit one render later, leaving a window where a save reads the wrong
  // revision. React re-runs this function before committing, so the stale
  // return below is discarded and never reaches the DOM. The update is
  // conditional on the id actually changing, so it converges immediately.
  if (record && seeded?._id !== record._id) {
    setSeeded({ _id: record._id, updatedAt: record.updatedAt });
  }

  return seeded?.updatedAt;
}
