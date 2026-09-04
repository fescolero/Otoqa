'use node';

/**
 * Offboarding purge — documents-storage-spec.md §7.
 *
 * Runs daily (crons.ts). For every organization whose `purgeAt` has
 * passed and that is not yet `purgedAt`:
 *   1. delete every object under `orgs/{workosOrgId}/` (paged, bulk),
 *   2. delete legacy-prefix R2 objects its load-document rows reference
 *      (`pod-photos/`, `load-documents/`) — bytes before rows,
 *   3. delete its entityDocuments / documentTypes / loadDocuments rows in
 *      bounded batches (Convex `_storage` blobs go with their rows),
 *   4. stamp `purgedAt` and soft-delete the org, with a platform audit
 *      entry.
 *
 * This is the ONLY automated physical deletion in the documents system.
 * It is idempotent: a crash mid-way leaves fewer objects/rows and the
 * next run finishes the job. Cancelling offboarding is refused once
 * `purgeAt` has passed (platform.support.cancelOffboarding), so step 1
 * — the irreversible one — never races a cancel; the re-checks below
 * are defense in depth.
 */

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { deleteObjectsByKeys, listObjectKeys } from './s3Upload';

export const purgeDueOrganizations = internalAction({
  args: {},
  returns: v.object({ purged: v.number(), failed: v.number(), objectsDeleted: v.number(), rowsDeleted: v.number() }),
  handler: async (ctx): Promise<{ purged: number; failed: number; objectsDeleted: number; rowsDeleted: number }> => {
    const due: Array<{ organizationId: Id<'organizations'>; workosOrgId?: string; name: string }> = await ctx.runQuery(
      internal.entityDocuments.dueForPurge,
      { now: Date.now() },
    );
    let purged = 0;
    let failed = 0;
    let objectsDeleted = 0;
    let rowsDeleted = 0;

    for (const org of due) {
      // One org's storage error must not block every other org's purge:
      // log it, move on, and let tomorrow's run pick it up again (every
      // step is idempotent).
      try {
        const r = await purgeOne(ctx, org);
        objectsDeleted += r.objectsDeleted;
        rowsDeleted += r.rowsDeleted;
        if (r.stamped) purged++;
      } catch (e) {
        failed++;
        console.error(`[offboardingPurge] ${org.name} (${org.workosOrgId ?? org.organizationId}) failed; will retry next run`, e);
      }
    }

    return { purged, failed, objectsDeleted, rowsDeleted };
  },
});

async function purgeOne(
  ctx: ActionCtx,
  org: { organizationId: Id<'organizations'>; workosOrgId?: string; name: string },
): Promise<{ stamped: boolean; objectsDeleted: number; rowsDeleted: number }> {
  let objectsDeleted = 0;
  let rowsDeleted = 0;
  {
      // Re-check right before touching anything (a cancel is refused once
      // purgeAt has passed, so this only catches a stale listing).
      const stillDue: boolean = await ctx.runQuery(internal.entityDocuments.isStillDueForPurge, {
        organizationId: org.organizationId,
        now: Date.now(),
      });
      if (!stillDue) return { stamped: false, objectsDeleted, rowsDeleted };

      // 1. Bucket prefix.
      if (org.workosOrgId) {
        const prefix = `orgs/${org.workosOrgId}/`;
        let token: string | undefined;
        do {
          const page = await listObjectKeys(prefix, token);
          if (page.keys.length > 0) objectsDeleted += await deleteObjectsByKeys(page.keys);
          token = page.nextToken;
        } while (token);
      }

      // 2. Legacy-prefix objects referenced by load-document rows — deleted
      //    BEFORE the rows so a failure here leaves the rows (re-listed
      //    next run), never unreferenced bytes.
      let cursor: string | null = null;
      do {
        const page: { keys: string[]; nextCursor: string | null } = await ctx.runQuery(
          internal.entityDocuments.legacyLoadKeysForOrg,
          { organizationId: org.organizationId, cursor: cursor ?? undefined },
        );
        if (page.keys.length > 0) objectsDeleted += await deleteObjectsByKeys(page.keys);
        cursor = page.nextCursor;
      } while (cursor);

      // 3. Rows, in batches until the mutation reports nothing left.
      let done = false;
      while (!done) {
        const r: { deleted: number; done: boolean } = await ctx.runMutation(internal.entityDocuments.purgeOrgRows, {
          organizationId: org.organizationId,
        });
        rowsDeleted += r.deleted;
        done = r.done;
      }

      // 4. Stamp — false only if the org somehow stopped being due mid-run.
      const stamped: boolean = await ctx.runMutation(internal.entityDocuments.markPurged, {
        organizationId: org.organizationId,
      });
      if (stamped) {
        console.log(`[offboardingPurge] purged ${org.name} (${org.workosOrgId ?? org.organizationId})`);
      } else {
        console.warn(`[offboardingPurge] ${org.name} was no longer due mid-run; not stamped`);
      }
      return { stamped, objectsDeleted, rowsDeleted };
  }
}
