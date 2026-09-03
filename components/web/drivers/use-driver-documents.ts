'use client';

/**
 * useDriverDocuments — the one data hook behind every driver documents
 * surface (Documents tab, Overview section, attention band, tab badge).
 * Subscribes to entityDocuments.listForEntity and composes the view-model
 * with the shared status module, so the four surfaces cannot disagree.
 */

import * as React from 'react';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { localTodayDateStr } from '@/convex/_helpers/documentStatus';
import { composeDocumentsViewModel, type DocumentsViewModel, type EntityDocumentsList } from './driver-documents-model';

export interface DriverDocumentsState extends DocumentsViewModel {
  loading: boolean;
  canEdit: boolean;
  types: EntityDocumentsList['types'];
  documents: EntityDocumentsList['documents'];
  today: string;
}

const EMPTY: DocumentsViewModel = {
  rows: [],
  archived: [],
  counts: { total: 0, onFile: 0, valid: 0, expiring: 0, expired: 0, missing: 0 },
  attention: 0,
};

export function useDriverDocuments(driverId: string | undefined): DriverDocumentsState {
  const data = useAuthQuery(
    api.entityDocuments.listForEntity,
    driverId ? { entity: 'driver', entityId: driverId } : 'skip',
  );
  // Local calendar day, refreshed when the component re-renders; the
  // page re-mounts daily in practice, and a stale "today" only shifts a
  // chip by a day at midnight.
  const today = React.useMemo(() => localTodayDateStr(), []);

  const vm = React.useMemo(
    () => (data ? composeDocumentsViewModel(data.types, data.documents, today) : EMPTY),
    [data, today],
  );

  return {
    ...vm,
    loading: data === undefined,
    canEdit: data?.canEdit ?? false,
    types: data?.types ?? [],
    documents: data?.documents ?? [],
    today,
  };
}
