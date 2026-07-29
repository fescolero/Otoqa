/**
 * Voice-command parser (Phase 3 voice agent) — deterministic, on-device,
 * zero network. Grammar over the four v8 command families:
 *
 *   assign    "assign load 1001 to Marcus [Vega]"
 *   move      "move load 1001 to 3 pm" / "push 1001's appointment to 15:30"
 *   offers    "accept [the] offer [for load] 1001" / "decline offer 1001"
 *   summaries "what's on the board" / "any alerts?"
 *
 * Pure functions only — the screen resolves refs against live query data
 * with the match helpers below. Ambiguity is a first-class result (the
 * agent asks, never guesses), matching the §4.6 never-clobber posture.
 */

export type VoiceIntent =
  | { kind: 'assign'; loadRef: string; driverQuery: string }
  | { kind: 'move_window'; loadRef: string; time: SpokenTime }
  | { kind: 'accept_offer'; loadRef: string | null }
  | { kind: 'decline_offer'; loadRef: string | null }
  | { kind: 'driver_history'; driverQuery: string; date: string | null }
  | { kind: 'board_summary' }
  | { kind: 'alerts_summary' }
  | { kind: 'unknown'; text: string };

/** Local calendar date as YYYY-MM-DD (NOT UTC — dispatch days are local). */
export const localDateStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface SpokenTime {
  hour: number; // 0-23
  minute: number; // 0-59
}

const clean = (s: string) => s.trim().replace(/[.,!?]+$/g, '').trim();

/** Reference normalizer: "L-1001", "load #1001", "1001." all key alike. */
export const normalizeRef = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * "3 pm" / "3:30pm" / "15:45" / "noon" / "midnight" → SpokenTime.
 * Bare hours without am/pm below 8 are read as PM (dispatch daytime
 * assumption — "move it to 3" means 15:00, not 03:00); 8-23 read as-is.
 */
export function parseSpokenTime(raw: string): SpokenTime | null {
  const s = clean(raw).toLowerCase();
  if (/\bnoon\b/.test(s)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(s)) return { hour: 0, minute: 0 };
  const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  if (hour > 23 || minute > 59) return null;
  const meridiem = m[3]?.replace(/\./g, '');
  if (meridiem === 'pm' && hour < 12) hour += 12;
  else if (meridiem === 'am' && hour === 12) hour = 0;
  else if (!meridiem && hour >= 1 && hour < 8) hour += 12;
  return { hour, minute };
}

const REF = String.raw`(?:load\s+)?(?:number\s+|#\s*)?([\w-]+)`;

export function parseCommand(text: string, now: Date = new Date()): VoiceIntent {
  const s = clean(text);

  const assign = s.match(new RegExp(String.raw`\b(?:assign|give|send|put)\b\s+${REF}\s+to\s+(.+)$`, 'i'));
  if (assign) return { kind: 'assign', loadRef: assign[1], driverQuery: clean(assign[2]) };

  const move = s.match(
    new RegExp(
      String.raw`\b(?:move|push|change|reschedule)\b\s+${REF}(?:'s)?(?:\s+(?:appointment|window|pickup|delivery|stop))?\s+to\s+(.+)$`,
      'i',
    ),
  );
  if (move) {
    const time = parseSpokenTime(move[2]);
    if (time) return { kind: 'move_window', loadRef: move[1], time };
  }

  const accept = s.match(new RegExp(String.raw`\baccept\b(?:\s+(?:the\s+)?offer)?(?:\s+(?:for\s+)?${REF})?`, 'i'));
  if (accept && /\baccept\b/i.test(s)) {
    return { kind: 'accept_offer', loadRef: accept[1] && accept[1].toLowerCase() !== 'offer' ? accept[1] : null };
  }
  const decline = s.match(
    new RegExp(String.raw`\b(?:decline|reject)\b(?:\s+(?:the\s+)?offer)?(?:\s+(?:for\s+)?${REF})?`, 'i'),
  );
  if (decline && /\b(?:decline|reject)\b/i.test(s)) {
    return { kind: 'decline_offer', loadRef: decline[1] && decline[1].toLowerCase() !== 'offer' ? decline[1] : null };
  }

  // Driver history — "what loads did Jorge Romero have yesterday",
  // "loads for Jorge today". Must run BEFORE the board keyword sweep or
  // the word "loads" swallows it into board_summary.
  const history =
    s.match(/\bloads?\s+(?:did|does|has|is)\s+(.+?)\s+(?:have|had|got|get|run|running|do|doing|on)\b/i) ??
    s.match(/\bloads?\s+for\s+(.+?)(?:\s+(?:yesterday|today))?$/i);
  if (history) {
    const dayWord = s.match(/\b(yesterday|today)\b/i)?.[1]?.toLowerCase() ?? 'today';
    const d = new Date(now);
    if (dayWord === 'yesterday') d.setDate(d.getDate() - 1);
    const driverQuery = clean(history[1]).replace(/\b(yesterday|today)\b/gi, '').trim();
    if (driverQuery) return { kind: 'driver_history', driverQuery, date: localDateStr(d) };
  }

  if (/\b(alerts?|exceptions?|problems?|attention|wrong)\b/i.test(s)) return { kind: 'alerts_summary' };
  if (/\b(board|rolling|active|loads|moving|happening)\b/i.test(s)) return { kind: 'board_summary' };

  return { kind: 'unknown', text: s };
}

// ── Resolution helpers (screen feeds live query data) ────────────────

export type RefMatch<T> = { match: T } | { ambiguous: T[] } | null;

/**
 * Match a spoken load ref against rows: exact normalized id first, then
 * suffix ("1001" hits "L-1001"), then substring. One hit wins; several
 * are ambiguous; none is null.
 */
export function matchByRef<T>(rows: T[], getRef: (r: T) => string | null | undefined, spoken: string): RefMatch<T> {
  const target = normalizeRef(spoken);
  if (!target) return null;
  const norm = rows.map((r) => ({ r, ref: normalizeRef(getRef(r) ?? '') })).filter((x) => x.ref);
  for (const pass of [
    (x: { ref: string }) => x.ref === target,
    (x: { ref: string }) => x.ref.endsWith(target),
    (x: { ref: string }) => x.ref.includes(target),
  ]) {
    const hits = norm.filter(pass);
    if (hits.length === 1) return { match: hits[0].r };
    if (hits.length > 1) return { ambiguous: hits.map((h) => h.r) };
  }
  return null;
}

/**
 * Match a spoken driver query against the fleet: full-name exact, then
 * full-name prefix ("marcus v"), then first- or last-name equality.
 */
export function matchDriver<T extends { firstName: string; lastName: string }>(
  drivers: T[],
  spokenQuery: string,
): RefMatch<T> {
  const q = clean(spokenQuery).toLowerCase().replace(/\s+/g, ' ');
  if (!q) return null;
  const norm = drivers.map((d) => ({
    d,
    full: `${d.firstName} ${d.lastName}`.toLowerCase(),
    first: d.firstName.toLowerCase(),
    last: d.lastName.toLowerCase(),
  }));
  for (const pass of [
    (x: (typeof norm)[number]) => x.full === q,
    (x: (typeof norm)[number]) => x.full.startsWith(q),
    (x: (typeof norm)[number]) => x.first === q || x.last === q,
  ]) {
    const hits = norm.filter(pass);
    if (hits.length === 1) return { match: hits[0].d };
    if (hits.length > 1) return { ambiguous: hits.map((h) => h.d) };
  }
  return null;
}

/** Next wall-clock occurrence of a spoken time: today if still ahead, else tomorrow. */
export function nextOccurrence(time: SpokenTime, now: Date): Date {
  const d = new Date(now);
  d.setHours(time.hour, time.minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}
