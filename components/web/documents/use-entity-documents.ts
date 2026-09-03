'use client';

/**
 * useEntityDocuments — the one data hook behind every documents surface
 * (Documents tabs, Overview sections, attention bands, tab badges) for
 * drivers, carrier partnerships, and the org's own company file.
 * Subscribes to entityDocuments.listForEntity and composes the view-model
 * with the shared status module, so surfaces cannot disagree.
 */

import * as React from 'react';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { localTodayDateStr } from '@/convex/_helpers/documentStatus';
import type { DocumentEntity } from '@/convex/lib/documentTypeDefaults';
import {
  composeDocumentsViewModel,
  type DocumentsViewModel,
  type EntityDocumentsList,
} from './entity-documents-model';

export interface EntityDocumentsState extends DocumentsViewModel {
  loading: boolean;
  canEdit: boolean;
  canShare: boolean;
  types: EntityDocumentsList['types'];
  documents: EntityDocumentsList['documents'];
  shared: EntityDocumentsList['shared'];
  linkedCarrierName?: string;
  today: string;
}

const EMPTY: DocumentsViewModel = {
  rows: [],
  archived: [],
  counts: { total: 0, onFile: 0, valid: 0, expiring: 0, expired: 0, missing: 0 },
  attention: 0,
};

export function useEntityDocuments(entity: DocumentEntity, entityId: string | undefined): EntityDocumentsState {
  const data = useAuthQuery(api.entityDocuments.listForEntity, entityId ? { entity, entityId } : 'skip');
  // Local calendar day, fixed for the component's life; a stale "today"
  // only shifts a chip by a day at midnight.
  const today = React.useMemo(() => localTodayDateStr(), []);

  const vm = React.useMemo(
    () => (data ? composeDocumentsViewModel(data.types, data.documents, today, data.shared) : EMPTY),
    [data, today],
  );

  return {
    ...vm,
    loading: data === undefined,
    canEdit: data?.canEdit ?? false,
    canShare: data?.canShare ?? false,
    types: data?.types ?? [],
    documents: data?.documents ?? [],
    shared: data?.shared ?? [],
    linkedCarrierName: data?.linkedCarrierName,
    today,
  };
}

/** Driver convenience wrapper. */
export function useDriverDocuments(driverId: string | undefined): EntityDocumentsState {
  return useEntityDocuments('driver', driverId);
}
