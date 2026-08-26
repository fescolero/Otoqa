/**
 * end-shift-reminder.ts — nudges a driver who rolls back into the yard they
 * started in without ending their shift.
 *
 * A forgotten shift is expensive: it is closed either by the 18-hour
 * auto-timeout sweep or, silently and worse, by the next morning's Start
 * Shift — which stamps yesterday's end at *now*, so a ~24-hour session bills
 * with no warning on it. Meanwhile the phone tracks all night against a
 * session nobody is working.
 *
 * The trigger is deliberately the narrowest one that works: coming back INTO
 * the fence the shift opened inside. Arming happens on the first fix rather
 * than at Start Shift, which means this module needs nothing plumbed through
 * the UI and recovers on its own if the app was restarted between the two.
 *
 * Firing posts the lock-screen notification (end-shift-notification.ts) and
 * emits `shift_reminder_fired` either way — the event records the decision,
 * not the delivery, so a shift where the OS refused to show anything is
 * still visible as a nudge that should have happened.
 *
 * The whole path is behind `shift_end_reminder_enabled`, off by default: a
 * reminder is only as good as the yard pins an org has drawn, so the
 * telemetry from a pilot org is what earns the flag flip.
 *
 * See docs/end-shift-reminder-spec.md.
 */

import { storage } from './storage';
import { log } from './log';
import { getCachedYardFences, type YardFence } from './yard-fences';
import { zoneFor, distanceMeters } from './yard-fence-math';
import {
  nextReminderState,
  decideArm,
  type ReminderZone,
} from './end-shift-reminder-logic';
import { getFlagBool, FLAG_SHIFT_END_REMINDER_ENABLED } from './feature-flags';
import {
  trackShiftReminderArmed,
  trackShiftReminderFired,
  trackShiftReminderSuppressed,
} from './analytics';
import { presentEndShiftReminder, dismissEndShiftReminder } from './end-shift-notification';

const lg = log('EndShiftReminder');

const STATE_KEY = 'end_shift_reminder_state';

type ReminderState = {
  sessionId: string;
  organizationId: string;
  /**
   * null = this shift has no anchor: it opened outside every fence, or no
   * fix landed before the window closed. Stored rather than left absent so
   * we stop re-arming on every subsequent ping.
   */
  fence: YardFence | null;
  zone: ReminderZone;
  remindedThisVisit: boolean;
};

export type ReminderFix = {
  organizationId: string;
  sessionId: string;
  /** When the shift's tracking started — the anchor for ARM_WINDOW_MS. */
  shiftStartedAt: number;
  latitude: number;
  longitude: number;
  recordedAt: number;
};

/** "7h 20m" / "45m" — the shift length, as a driver would say it. */
function formatElapsed(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function readState(): Promise<ReminderState | null> {
  try {
    const raw = await storage.getString(STATE_KEY);
    return raw ? (JSON.parse(raw) as ReminderState) : null;
  } catch (err) {
    lg.warn(`Failed to read reminder state: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function writeState(state: ReminderState): Promise<void> {
  try {
    await storage.set(STATE_KEY, JSON.stringify(state));
  } catch (err) {
    lg.warn(`Failed to persist reminder state: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Drop the state and take down any standing reminder. Called when tracking
 * stops — the shift is over, so a notification asking them to end it is
 * worse than none.
 */
export async function clearShiftReminder(): Promise<void> {
  void dismissEndShiftReminder();
  try {
    await storage.delete(STATE_KEY);
  } catch {
    // Non-critical: state is session-stamped, so a leftover copy is
    // re-armed rather than misapplied to the next shift.
  }
}

/**
 * Establish this shift's anchor from its first usable fix. Returns the
 * stored state, or null when the decision is "look again next fix".
 */
async function armFromFix(fix: ReminderFix): Promise<ReminderState | null> {
  const sinceShiftStartMs = fix.recordedAt - fix.shiftStartedAt;
  const fences = await getCachedYardFences(fix.organizationId);
  const decision = decideArm({
    sinceShiftStartMs,
    fences,
    latitude: fix.latitude,
    longitude: fix.longitude,
  });

  if (decision.kind === 'retry') return null;

  const fence = decision.kind === 'arm' ? decision.fence : null;
  const state: ReminderState = {
    sessionId: fix.sessionId,
    organizationId: fix.organizationId,
    fence,
    zone: fence ? 'inside' : 'unknown',
    remindedThisVisit: false,
  };
  await writeState(state);

  trackShiftReminderArmed({
    sessionId: fix.sessionId,
    armed: fence !== null,
    reason: decision.reason,
    fenceId: fence?.id,
    fenceCount: fences.length,
    sinceShiftStartMs,
  });
  if (fence) {
    lg.debug(`Armed on "${fence.name}" (${fences.length} fence(s) cached)`);
  }
  return state;
}

/**
 * Fold one accepted GPS fix into the reminder.
 *
 * Call on fixes that already cleared the tracker's accuracy and rate gates —
 * the same pings the server evaluates — so the two sides see the same
 * stream. Returns true when the driver has just returned to their start
 * yard; the notification hangs off that in the next step.
 *
 * Never throws: a reminder must not be able to break GPS capture.
 */
export async function evaluateShiftReminder(fix: ReminderFix): Promise<boolean> {
  try {
    if (!(await getFlagBool(FLAG_SHIFT_END_REMINDER_ENABLED, false))) return false;

    let state = await readState();

    // No state, or state from a previous shift — this fix arms the new one.
    if (!state || state.sessionId !== fix.sessionId) {
      state = await armFromFix(fix);
      return false; // Arming never nudges: we don't know they went anywhere.
    }

    if (!state.fence) return false; // Un-anchored shift; nothing to watch.

    const observed = zoneFor(state.fence, fix.latitude, fix.longitude);
    const next = nextReminderState(
      { zone: state.zone, remindedThisVisit: state.remindedThisVisit },
      observed,
    );
    // Most fixes change nothing — don't spend a write on them.
    if (!next.changed) return false;

    await writeState({
      ...state,
      zone: next.zone,
      remindedThisVisit: next.remindedThisVisit,
    });

    if (!next.fire) return false;

    const shiftElapsedMs = fix.recordedAt - fix.shiftStartedAt;
    trackShiftReminderFired({
      sessionId: fix.sessionId,
      fenceId: state.fence.id,
      shiftElapsedMs,
      distanceMeters: Math.round(
        distanceMeters(
          fix.latitude,
          fix.longitude,
          state.fence.latitude,
          state.fence.longitude,
        ),
      ),
    });

    const shown = await presentEndShiftReminder({
      sessionId: fix.sessionId,
      yardName: state.fence.name,
      shiftElapsedLabel: formatElapsed(shiftElapsedMs),
    });
    if (!shown) {
      trackShiftReminderSuppressed({
        sessionId: fix.sessionId,
        reason: 'permission_denied',
      });
    }

    lg.debug(`Back at "${state.fence.name}" — reminder fired (shown=${shown})`);
    return true;
  } catch (err) {
    lg.warn(`Reminder evaluation failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}
