import { QueryCtx, MutationCtx } from '../_generated/server';
import { Doc } from '../_generated/dataModel';

/**
 * Parses stop date and time strings into a Unix timestamp.
 * Handles both ISO 8601 format and split date/time strings.
 *
 * @param dateStr - Date string (e.g., "2025-01-15")
 * @param timeStr - Time string (e.g., "09:00:00-05:00" or full ISO)
 * @returns Unix timestamp in milliseconds, or null if parsing fails
 */
export function parseStopDateTime(dateStr: string, timeStr: string): number | null {
  try {
    // If timeStr already contains "T", it's a full ISO string - use as-is
    const combined = timeStr.includes('T') ? timeStr : `${dateStr}T${timeStr}`;
    const timestamp = new Date(combined).getTime();

    // Validate the result is a valid number
    if (isNaN(timestamp)) return null;

    return timestamp;
  } catch {
    return null;
  }
}

/**
 * Calculates the time range for a dispatch leg based on its start and end stops.
 * Used for conflict detection when assigning drivers.
 *
 * @param ctx - Convex query or mutation context
 * @param leg - The dispatch leg document
 * @returns Object with start and end timestamps, or null if stops are missing/invalid
 */
export async function getLegTimeRange(
  ctx: QueryCtx | MutationCtx,
  leg: Doc<'dispatchLegs'>
): Promise<{ start: number; end: number } | null> {
  const [startStop, endStop] = await Promise.all([
    ctx.db.get(leg.startStopId),
    ctx.db.get(leg.endStopId),
  ]);

  if (!startStop || !endStop) return null;

  const start = parseStopDateTime(startStop.windowBeginDate, startStop.windowBeginTime);
  const end = parseStopDateTime(endStop.windowEndDate, endStop.windowEndTime);

  // Return null if either timestamp failed to parse
  if (start === null || end === null) return null;

  return { start, end };
}

/**
 * Checks if two time ranges overlap.
 * Overlap formula: (StartA < EndB) && (EndA > StartB)
 *
 * @param rangeA - First time range
 * @param rangeB - Second time range
 * @returns true if ranges overlap
 */
export function doTimeRangesOverlap(
  rangeA: { start: number; end: number },
  rangeB: { start: number; end: number }
): boolean {
  return rangeA.start < rangeB.end && rangeA.end > rangeB.start;
}
