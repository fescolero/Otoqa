/**
 * @otoqa/convex-client — the ONE place mobile apps import Convex
 * generated types from (split-plan §2.1).
 *
 * Re-exports the root backend's codegen so there is exactly one
 * `npx convex codegen` output in the repo. History: apps/driver carries
 * a hand-copied `convex/_generated` snapshot that had already drifted
 * from the backend when this package was created.
 *
 * Adoption:
 *   - apps/dispatch (Phase 1): imports from here from day one.
 *   - apps/driver: still on its local copy — rewiring its ~30 import
 *     sites is deliberately NOT part of the Phase 0 restructure so the
 *     driver build stays byte-equivalent; it migrates in its own
 *     release with normal device verification.
 */
export { api, internal } from '../../convex/_generated/api';
export type { Doc, Id, DataModel, TableNames } from '../../convex/_generated/dataModel';
