'use node';

/**
 * Offboarding purge — documents-storage-spec.md §7.
 *
 * Runs daily (crons.ts). For every organization whose `purgeAt` has
 * passed and that is not yet `purgedAt`:
 *   1. delete every object under `orgs/{workosOrgId}/` (paged, bulk),
 *   2. delete its entityDocuments / documentTypes / loadDocuments rows in
 *      bounded batches — each batch also deletes the Convex `_storage`
 *      blobs and reports legacy-prefix R2 keys its rows referenced, which
 *      are deleted here,
 *   3. stamp `purgedAt` and soft-delete the org, with a platform audit
 *      entry.
 *
 * This is the ONLY automated physical deletion in the documents system.
 * It is idempotent: a crash mid-way leaves fewer objects/rows and the
 * next run finishes the job.
 */

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { deleteObjectsByKeys, listObjectKeys } from './s3Upload';

export const purgeDueOrganizations = internalAction({
  args: {},
  returns: v.object({ purged: v.number(), objectsDeleted: v.number(), rowsDeleted: v.number() }),
  handler: async (ctx): Promise<{ purged: number; objectsDeleted: number; rowsDeleted: number }> => {
    const due: Array<{ organizationId: Id<'organizations'>; workosOrgId?: string; name: string }> = await ctx.runQuery(
      internal.entityDocuments.dueForPurge,
      { now: Date.now() },
    );
    let purged = 0;
    let objectsDeleted = 0;
    let rowsDeleted = 0;

    for (const org of due) {
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

      // 2. Rows, in batches until the mutation reports nothing left.
      let done = false;
      while (!done) {
        const r: { deleted: number; done: boolean; extraKeys: string[] } = await ctx.runMutation(
          internal.entityDocuments.purgeOrgRows,
          { organizationId: org.organizationId },
        );
        rowsDeleted += r.deleted;
        // Legacy-prefix objects referenced by the deleted rows.
        if (r.extraKeys.length > 0) objectsDeleted += await deleteObjectsByKeys(r.extraKeys);
        done = r.done;
      }

      // 3. Stamp.
      await ctx.runMutation(internal.entityDocuments.markPurged, { organizationId: org.organizationId });
      purged++;
      console.log(`[offboardingPurge] purged ${org.name} (${org.workosOrgId ?? org.organizationId})`);
    }

    return { purged, objectsDeleted, rowsDeleted };
  },
});
