/**
 * Document status — the ONE place it is computed.
 *
 * docs/documents-storage-spec.md §3. Imported by Convex functions (list
 * counts, missing summaries) and by the web app (Documents tab, Overview
 * section, attention items). Plain TypeScript; the only dependency is the
 * calendar-day helper in ./dateUtils, which is also runtime-agnostic.
 *
 * Determinism rule (same as dateUtils): nothing here reads the clock.
 * Callers pass `todayStr` (YYYY-MM-DD). On the client use
 * `localTodayDateStr()`; Convex queries take it as an argument.
 */

import { getDateStatus } from './dateUtils';
import type { DocumentEntity, MirrorField } from '../lib/documentTypeDefaults';
import { DRIVER_MIRROR_FIELDS, DRIVER_MIRROR_TO_TYPE_KEY } from '../lib/documentTypeDefaults';


export type DocumentStatus =
  | 'missing'
  | 'needs_date'
  | 'expired'
  | 'expiring'
  | 'warning'
  | 'valid'
  | 'on_file';

/** A catalog entry after system defaults and org overrides are merged. */
export interface EffectiveDocumentType {
  key: string;
  entity: DocumentEntity;
  name: string;
  expires: boolean;
  issueDateRequired: boolean;
  uploadRequired: boolean;
  singleton: boolean;
  sharedByDefault: boolean;
  mirrorField?: MirrorField;
  /** organization types only — see documentTypeDefaults.partnerTypeKey */
  partnerTypeKey?: string;
  isSystem: boolean;
  hidden: boolean;
  sortOrder: number;
}

/** The bits of an active document row that status depends on. */
export interface ActiveDocumentLike {
  expirationDate?: string;
  hasFile: boolean;
}

/**
 * Expiry state of a bare date. Unlike the legacy `getDateStatus`, an
 * absent date is `missing`, never `valid`.
 */
export function dateExpiryStatus(
  dateStr: string | undefined | null,
  todayStr: string,
): 'missing' | 'expired' | 'expiring' | 'warning' | 'valid' {
  // One tiering for every date on the platform (dateUtils.getDateStatus).
  return getDateStatus(dateStr ?? undefined, todayStr);
}

/**
 * Status of one (entity, type) pair given its active document, if any.
 * Implements the table in spec §3.
 */
export function computeDocumentStatus(
  type: Pick<EffectiveDocumentType, 'expires' | 'uploadRequired'>,
  active: ActiveDocumentLike | null | undefined,
  todayStr: string,
): DocumentStatus {
  if (!active) return 'missing';
  if (type.uploadRequired && !active.hasFile) return 'missing';
  if (!type.expires) return 'on_file';
  if (!active.expirationDate) return 'needs_date';
  const s = dateExpiryStatus(active.expirationDate, todayStr);
  // A dated active row can't be 'missing' here (date is present), but the
  // union says otherwise — normalize for the type system.
  return s === 'missing' ? 'needs_date' : s;
}

/**
 * Effective document for a partnership type when both the broker's own
 * row and a carrier-shared row exist (spec §6.3): for expiring types the
 * LATEST expiry wins; otherwise the broker's own row wins, then the
 * shared one. Returns null when neither exists.
 */
export function pickEffectiveDocument<T extends { expirationDate?: string }>(
  type: Pick<EffectiveDocumentType, 'expires'>,
  own: readonly T[],
  shared: readonly T[],
): { doc: T; source: 'own' | 'shared' } | null {
  const candidates: Array<{ doc: T; source: 'own' | 'shared' }> = [
    ...own.map((doc) => ({ doc, source: 'own' as const })),
    ...shared.map((doc) => ({ doc, source: 'shared' as const })),
  ];
  if (candidates.length === 0) return null;
  if (!type.expires) return candidates[0];
  let best = candidates[0];
  for (const c of candidates.slice(1)) {
    const a = c.doc.expirationDate ?? '';
    const b = best.doc.expirationDate ?? '';
    if (a > b) best = c; // YYYY-MM-DD sorts lexically
  }
  return best;
}

/** Statuses that should surface in attention bands and "needs attention"
 *  counts. `warning` (31–60 days) is informational, not attention. */
export function needsAttention(status: DocumentStatus): boolean {
  return status === 'missing' || status === 'needs_date' || status === 'expired' || status === 'expiring';
}

/**
 * Time-independent "missing" summary: which visible types have no
 * qualifying active row. Stored on the parent row (`missingDocTypeKeys`)
 * so list pages don't read every document. Recomputed whenever a document
 * activates/archives or a type flag changes — never on the clock.
 */
export function computeMissingTypeKeys(
  types: readonly Pick<EffectiveDocumentType, 'key' | 'uploadRequired' | 'hidden'>[],
  activeDocs: readonly { typeKey: string; hasFile: boolean }[],
): string[] {
  const present = new Set<string>();
  for (const d of activeDocs) present.add(d.typeKey + (d.hasFile ? ':file' : ':nofile'));
  const missing: string[] = [];
  for (const t of types) {
    if (t.hidden) continue;
    const ok = t.uploadRequired ? present.has(`${t.key}:file`) : present.has(`${t.key}:file`) || present.has(`${t.key}:nofile`);
    if (!ok) missing.push(t.key);
  }
  return missing;
}

/**
 * Time-independent "needs date" summary: visible expiring types whose
 * active document(s) carry no expiration date (a flag flipped to Expires
 * after the upload). Stored beside `missingDocTypeKeys` for list rows.
 */
export function computeNeedsDateTypeKeys(
  types: readonly Pick<EffectiveDocumentType, 'key' | 'expires' | 'hidden'>[],
  activeDocs: readonly { typeKey: string; expirationDate?: string }[],
): string[] {
  const dated = new Set<string>();
  const present = new Set<string>();
  for (const d of activeDocs) {
    present.add(d.typeKey);
    if (d.expirationDate) dated.add(d.typeKey);
  }
  return types.filter((t) => t.expires && !t.hidden && present.has(t.key) && !dated.has(t.key)).map((t) => t.key);
}

/**
 * Attention count for a driver LIST row, without reading documents:
 * every missing type counts once, plus every mirrored date that is
 * expired/expiring for a type that is NOT already missing (a Missing type
 * keeps its stale mirror on purpose — spec §5.3 — so it must not be
 * double counted).
 *
 * `missingDocTypeKeys` is undefined on rows written before the summary
 * existed; until the backfill runs no documents can exist, so treat that
 * as "every upload-required system driver type is missing".
 */
export interface DriverAttentionInput {
  missingDocTypeKeys?: string[] | null;
  /** typeKey → effective expiration for every expiring type with an
   *  active document (written with the summary). Covers types that have
   *  no mirror field (hazmat, custom types). */
  docExpirations?: Record<string, string> | null;
  /** Expiring types whose active document has no date (written with the
   *  summary) — "Needs date" on the tab, attention here. */
  needsDateTypeKeys?: string[] | null;
  licenseExpiration?: string;
  medicalExpiration?: string;
  badgeExpiration?: string;
  twicExpiration?: string;
}

export const DEFAULT_REQUIRED_DRIVER_TYPE_KEYS: readonly string[] = [
  'cdl',
  'medical',
  'badge',
  'twic',
  'hazmat',
  'drug_screen',
  'i9',
  'background_check',
];

export function driverMissingKeys(row: Pick<DriverAttentionInput, 'missingDocTypeKeys'>): string[] {
  return row.missingDocTypeKeys ?? [...DEFAULT_REQUIRED_DRIVER_TYPE_KEYS];
}

export function countDriverAttention(
  row: DriverAttentionInput,
  todayStr: string,
  /** Type keys hidden in Settings › Documents: their mirrors are kept but
   *  are not compliance (the Documents tab shows nothing for them). */
  hiddenTypeKeys?: ReadonlySet<string>,
): number {
  // The unstamped-row fallback lists every default type; hidden ones must
  // drop out here exactly as they do from a stamped summary.
  const missing = new Set(driverMissingKeys(row).filter((k) => !hiddenTypeKeys?.has(k)));
  let count = missing.size;
  const needsDate = new Set(row.needsDateTypeKeys ?? []);
  for (const k of needsDate) {
    if (!missing.has(k) && !hiddenTypeKeys?.has(k)) count++;
  }
  // One date per type: the mirror fields (legacy rows) overlaid by the
  // per-type summary, which is written from the same documents and also
  // covers the types that have no mirror.
  const dates = new Map<string, string | undefined>();
  for (const field of DRIVER_MIRROR_FIELDS) dates.set(DRIVER_MIRROR_TO_TYPE_KEY[field], row[field]);
  for (const [typeKey, date] of Object.entries(row.docExpirations ?? {})) dates.set(typeKey, date);
  for (const [typeKey, date] of dates) {
    // A Needs-date type counted above keeps its stale mirror (spec §5.3);
    // it is one row on the tab, so one unit of attention here.
    if (missing.has(typeKey) || needsDate.has(typeKey) || hiddenTypeKeys?.has(typeKey)) continue;
    const s = dateExpiryStatus(date, todayStr);
    if (s === 'expired' || s === 'expiring') count++;
  }
  return count;
}

/** Local-calendar "today" for client callers. Server code must not call
 *  this — pass `todayDateStr` in from the client instead. */
export function localTodayDateStr(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  missing: 'Missing',
  needs_date: 'Needs date',
  expired: 'Expired',
  expiring: 'Expiring',
  warning: 'Valid',
  valid: 'Valid',
  on_file: 'On file',
};
