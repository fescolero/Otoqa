import { storage } from './storage';
import { trackPendingActionRecorded, trackPendingActionReconciled } from './analytics';

// ============================================
// PENDING ACTIONS
// Persists optimistic check-in/out state so it survives app restarts.
// Cleared automatically when server data confirms the action.
// ============================================

export interface PendingAction {
  type: 'in' | 'out';
  timestamp: string;
  driverTimestamp: string;
}

export type PendingActionsMap = Record<string, PendingAction>;

function getStorageKey(loadId: string): string {
  return `pending_actions_${loadId}`;
}

export async function loadPendingActions(loadId: string): Promise<PendingActionsMap> {
  try {
    const data = await storage.getString(getStorageKey(loadId));
    if (!data) return {};
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export async function savePendingActions(
  loadId: string,
  actions: PendingActionsMap
): Promise<void> {
  try {
    if (Object.keys(actions).length === 0) {
      await storage.delete(getStorageKey(loadId));
    } else {
      await storage.set(getStorageKey(loadId), JSON.stringify(actions));
    }
  } catch {
    console.error('[PendingActions] Failed to save');
  }
}

export async function addPendingAction(
  loadId: string,
  stopId: string,
  action: PendingAction
): Promise<void> {
  const current = await loadPendingActions(loadId);
  current[stopId] = action;
  await savePendingActions(loadId, current);
  trackPendingActionRecorded({ stopId, loadId, action: action.type });
}

export async function clearPendingAction(
  loadId: string,
  stopId: string
): Promise<void> {
  const current = await loadPendingActions(loadId);
  delete current[stopId];
  await savePendingActions(loadId, current);
}

/**
 * Reconcile pending actions against server data.
 * Removes any pending action where the server already has the confirmed value.
 */
export async function reconcilePendingActions(
  loadId: string,
  stops: Array<{ _id: string; checkedInAt?: string | number; checkedOutAt?: string | number }>
): Promise<PendingActionsMap> {
  const pending = await loadPendingActions(loadId);
  let changed = false;

  for (const stop of stops) {
    const action = pending[stop._id];
    if (!action) continue;

    const serverConfirmed =
      (action.type === 'in' && stop.checkedInAt) ||
      (action.type === 'out' && stop.checkedOutAt);

    if (serverConfirmed) {
      delete pending[stop._id];
      changed = true;
      trackPendingActionReconciled({ stopId: stop._id, loadId, action: action.type });
    }
  }

  if (changed) {
    await savePendingActions(loadId, pending);
  }

  return pending;
}
