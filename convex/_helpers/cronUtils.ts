export function minutesToMs(minutes: number): number {
  return minutes * 60 * 1000;
}

export function shouldRunInterval(args: {
  nowMs: number;
  lastRunAtMs?: number;
  intervalMinutes?: number;
  defaultIntervalMinutes?: number;
}): boolean {
  const effectiveInterval =
    args.intervalMinutes ?? args.defaultIntervalMinutes ?? 0;

  if (effectiveInterval <= 0) return true;
  if (args.lastRunAtMs == null) return true;

  return args.nowMs - args.lastRunAtMs >= minutesToMs(effectiveInterval);
}

export function getUtcDateStringFromMs(timestampMs: number): string {
  return new Date(timestampMs).toISOString().split('T')[0];
}

export function addDaysToUtcDateString(dateString: string, days: number): string {
  const base = new Date(`${dateString}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().split('T')[0];
}

export function isTimeOnOrAfterUtc(timestampMs: number, timeHHMM: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(timeHHMM);
  if (!match) return true;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) return true;

  const now = new Date(timestampMs);
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const targetMinutes = hours * 60 + minutes;

  return nowMinutes >= targetMinutes;
}

export function filterLoadsBySource<T extends { externalSource?: string | null }>(
  loads: T[],
  loadSourceFilter?: string
): T[] {
  if (!loadSourceFilter) return loads;
  return loads.filter((load) => load.externalSource === loadSourceFilter);
}
