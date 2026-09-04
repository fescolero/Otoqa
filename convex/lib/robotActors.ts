/**
 * Who counts as "the robot" in the audit trail.
 *
 * The auto-assignment paths write one of these identities on the load's
 * driver_assigned / carrier_assigned audit row. A load whose most recent
 * assignment row carries one of them was placed by auto-assignment and
 * not touched by a person since — the same fact provenance records for
 * loads assigned after provenance existed (see routeRotation.ts). This is
 * the fallback for the ones from before.
 *
 * Known gap, deliberate: a load created by hand and auto-assigned on
 * creation carries the creator's identity (loads.ts passes createdBy into
 * the trigger) and reads as human here.
 */
export const SYSTEM_ACTORS = new Set(['system', 'fourkites-sync', 'recurring-generator']);
export const SYSTEM_NAMES = new Set([
  'Auto-Assignment System',
  'Scheduled Auto-Assignment',
  'FourKites Sync',
  'FourKites Sync (Promotion)',
  'Recurring Load Generator',
  'Route re-sync',
]);

export function isRobotActor(row: { performedBy: string; performedByName?: string }): boolean {
  return (
    SYSTEM_ACTORS.has(row.performedBy) ||
    (row.performedByName !== undefined && SYSTEM_NAMES.has(row.performedByName))
  );
}

/** The audit actions that decide who currently holds a load. */
export const ASSIGNMENT_ACTIONS = new Set([
  'driver_assigned',
  'carrier_assigned',
  'resource_unassigned',
  'auto_assign_rotated',
]);
