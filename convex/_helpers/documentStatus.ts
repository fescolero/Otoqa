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

import { diffCalendarDays } from './dateUtils';
import type { DocumentEntity, MirrorField } from '../lib/documentTypeDefaults';
import { DRIVER_MIRROR_TO_TYPE_KEY, type DriverMirrorField } from '../lib/documentTypeDefaults';

export const EXPIRING_WITHIN_DAYS = 30;
export const WARNING_WITHIN_DAYS = 60;

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
  if (!dateStr) return 'missing';
  const diff = diffCalendarDays(dateStr, todayStr);
  if (diff === null) return 'missing';
  if (diff < 0) return 'expired';
  if (diff <= EXPIRING_WITHIN_DAYS) return 'expiring';
  if (diff <= WARNING_WITHIN_DAYS) return 'warning';
  return 'valid';
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

export function countDriverAttention(row: DriverAttentionInput, todayStr: string): number {
  const missing = new Set(driverMissingKeys(row));
  let count = missing.size;
  const mirrors: DriverMirrorField[] = [
    'licenseExpiration',
    'medicalExpiration',
    'badgeExpiration',
    'twicExpiration',
  ];
  for (const field of mirrors) {
    if (missing.has(DRIVER_MIRROR_TO_TYPE_KEY[field])) continue;
    const s = dateExpiryStatus(row[field], todayStr);
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
