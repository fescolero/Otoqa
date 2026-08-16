import type { Doc } from '../_generated/dataModel';

/**
 * One home for "is this job actually running?" — read by the console's jobs
 * board and by the alert evaluator, so a chip and an alert can never disagree.
 *
 * The gap this closes: `lastOutcome` only answers "did the last run succeed",
 * which stays 'ok' forever when a job STOPS FIRING. A missing job is not a
 * failing job, and it's the more dangerous of the two — nothing throws, nothing
 * logs, and the board stays green.
 */

/**
 * How late a job may be before it counts as stale: 3 missed cycles plus a
 * grace period. Convex interval scheduling drifts under load, and the 10s
 * jobs would flap on a 1× threshold.
 */
const MISSED_CYCLES = 3;
const GRACE_MS = 60_000;

/**
 * A run that claimed a start and never reported. Deliberately longer than any
 * legitimate job: the longest-running jobs here are S3 archive sweeps, which
 * self-reschedule in batches rather than blocking.
 */
const HUNG_AFTER_MS = 15 * 60 * 1000;

export type JobState = 'ok' | 'failing' | 'stale' | 'hung' | 'retired' | 'unknown';

export function stalenessThresholdMs(expectedIntervalMs: number): number {
  return expectedIntervalMs * MISSED_CYCLES + GRACE_MS;
}

export function jobState(job: Doc<'cronHealth'>, now: number): JobState {
  if (job.retiredAt !== undefined) return 'retired';

  // In-flight beyond the hang threshold: the action died without reporting.
  if (job.inFlightSince !== undefined && now - job.inFlightSince > HUNG_AFTER_MS) return 'hung';

  // Silence outranks the last outcome — a job that isn't running can't be 'ok'.
  if (job.expectedIntervalMs !== undefined) {
    const overdueBy = now - job.lastStartedAt - stalenessThresholdMs(job.expectedIntervalMs);
    if (overdueBy > 0) return 'stale';
  }

  if (job.consecutiveFailures > 0 || job.lastOutcome === 'error') return 'failing';
  if (job.expectedIntervalMs === undefined) return 'unknown'; // pre-upgrade row
  return 'ok';
}

/** Human-readable "how late", for alert messages and tooltips. */
export function overdueMs(job: Doc<'cronHealth'>, now: number): number | null {
  if (job.expectedIntervalMs === undefined) return null;
  const late = now - job.lastStartedAt - job.expectedIntervalMs;
  return late > 0 ? late : null;
}

export function formatDurationShort(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
