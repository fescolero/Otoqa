/**
 * Org-scope query helper for multi-tenant correctness.
 *
 * The single most important invariant in this codebase is that every read
 * is scoped to the caller's org. Doing this inline means every call site
 * has to remember:
 *   - which field name the table uses (`workosOrgId` vs `organizationId`)
 *   - which index covers org-only equality (`by_org` vs `by_organization`)
 *
 * `queryByOrg(ctx, table, orgId)` centralises that decision. It returns a
 * Convex query that's already been narrowed via `withIndex`, so the caller
 * can chain `.first()`, `.take(N)`, `.order(...)`, `.paginate(...)`, etc.
 *
 * Schema is the source of truth — when a new table is added with a different
 * field/index combo, register it in `ORG_INDEX_BY_TABLE` here. Tables that
 * don't match the simple "single-field org equality" pattern (composite
 * indexes like `by_org_status`, `by_org_period`, etc.) keep using
 * `db.query(...).withIndex(...)` directly; this helper is for the
 * org-only entry point.
 */
import type { GenericQueryCtx } from 'convex/server';
import type { DataModel } from '../_generated/dataModel';

type Ctx = GenericQueryCtx<DataModel>;

/**
 * Tables whose org-scope is reachable via a single-field index on the org.
 * Each entry encodes:
 *   - `index`  – the index name on that table
 *   - `field`  – the column the org id lives in on that table
 *
 * Adding a table here is a one-line change once the schema gains a matching
 * index. Do NOT add tables whose primary org index is composite (e.g.
 * `by_org_status`) — callers of those should keep their inline `withIndex`
 * because the composite key is part of the query semantics.
 */
const ORG_INDEX_BY_TABLE = {
  // Aggregate tables — bounded (1 row per org).
  organizationStats: { index: 'by_org', field: 'workosOrgId' },
  accountingPeriodStats: { index: 'by_org', field: 'workosOrgId' },

  // Audit log — composite `by_organization` index on (organizationId, timestamp).
  // Convex's index DSL allows `.eq` on any prefix of the key, so we can use
  // this index for the org-only case.
  auditLog: { index: 'by_organization', field: 'organizationId' },
} as const satisfies Record<string, { index: string; field: string }>;

/**
 * Tables this helper supports. Used as the public type for `table`.
 */
export type OrgScopedTable = keyof typeof ORG_INDEX_BY_TABLE;

/**
 * Start an org-scoped query.
 *
 * Returns the same shape as `ctx.db.query(table).withIndex(...)`, so the
 * caller can chain `.first()`, `.unique()`, `.take(N)`, `.order(...)`,
 * `.paginate(...)`, or `.collect()` (only when the result set is bounded
 * by org — e.g. settings/config tables; never for growing tables like
 * loads / legs / locations / auditLog).
 *
 * Type-narrowing: because we go through `ctx.db.query(table).withIndex(...)`,
 * the returned query is parameterised on the *specific* table's document
 * type. `.first()` returns `Doc<table> | null`, `.collect()` returns
 * `Doc<table>[]`, etc. Subsequent `.filter(q => q.eq(q.field('foo'), ...))`
 * autocompletes the actual columns.
 */
export function queryByOrg<T extends OrgScopedTable>(
  ctx: Ctx,
  table: T,
  orgId: string,
) {
  const meta = ORG_INDEX_BY_TABLE[table];
  // The cast is local to this helper — Convex doesn't expose a public type
  // for "name of an index that has `field` as its first key", so we satisfy
  // the static check via the `satisfies` clause above and cast `field` to
  // `any` here. Call-site type narrowing is preserved because the return
  // type is fully inferred from `ctx.db.query(table).withIndex(...)`.
  return ctx.db.query(table).withIndex(meta.index as never, (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).eq(meta.field, orgId),
  );
}
