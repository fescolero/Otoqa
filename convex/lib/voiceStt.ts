/**
 * Voice STT + NLU helpers (Phase 3 voice agent, server upgrade) — pure
 * functions so the Deepgram URL contract and the Haiku intent coercion
 * are unit-testable without network.
 *
 * STT: Deepgram Nova-3 with
 *   - `numerals=true`   — spoken numbers come back as digits ("nine
 *     hundred" → "900"); trips are numeric and HCRs mix letters+digits.
 *   - Keyterm Prompting — per-request `keyterm` params carrying the
 *     org's driver and customer names so fleet vocabulary is recognized.
 *
 * NLU: Claude Haiku (tool-forced) maps a transcript to the SAME intent
 * shape the on-device parser produces — the app's confirm-card flow is
 * unchanged, and the deterministic parser stays as the fallback when
 * the key is missing or the call fails.
 */

export const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen';

/** Deepgram caps keyterm effectiveness well below URL limits — cap hard. */
export const MAX_KEYTERMS = 100;

export function buildDeepgramUrl(keyterms: string[]): string {
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en-US',
    numerals: 'true',
    punctuate: 'false',
  });
  const seen = new Set<string>();
  for (const raw of keyterms) {
    const term = raw.trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    params.append('keyterm', term);
    if (seen.size >= MAX_KEYTERMS) break;
  }
  return `${DEEPGRAM_LISTEN_URL}?${params.toString()}`;
}

/** The tool Haiku is forced to call — one flat shape, coerced below. */
export const INTENT_TOOL = {
  name: 'set_intent',
  description: 'Report the parsed dispatch voice command.',
  input_schema: {
    type: 'object' as const,
    properties: {
      kind: {
        type: 'string',
        enum: [
          'assign',
          'move_window',
          'accept_offer',
          'decline_offer',
          'driver_loads',
          'board_summary',
          'alerts_summary',
          'clarify',
          'unknown',
        ],
      },
      loadRef: {
        type: 'string',
        description: 'Load / trip number or HCR exactly as spoken, e.g. "1001", "L-1001", "HCR75960".',
      },
      hcr: {
        type: 'string',
        description:
          'assign only: HCR / contract number when the command names a route ("HCR 96036", "contract 96036").',
      },
      trip: {
        type: 'string',
        description:
          'assign only: single trip number ("trip 5"). Prefer trips when more than one is named. With hcr/trip/trips set, leave loadRef empty.',
      },
      trips: {
        type: 'array',
        items: { type: 'string' },
        description:
          'assign only: EVERY trip number named ("trip 5 and 6" → ["5","6"]). One entry per trip.',
      },
      dates: {
        type: 'array',
        items: { type: 'string' },
        description:
          'assign only: service dates YYYY-MM-DD ("tomorrow and Saturday" → both, resolved from today). Omit when no day was spoken (means today).',
      },
      driverQuery: { type: 'string', description: 'Driver name as spoken (assign / driver_loads).' },
      hour: { type: 'integer', description: '24h hour for move_window (0-23).' },
      minute: { type: 'integer', description: 'Minute for move_window (0-59).' },
      date: {
        type: 'string',
        description: 'YYYY-MM-DD for driver_loads: the single day, or the first day of a range.',
      },
      dateEnd: {
        type: 'string',
        description: 'YYYY-MM-DD, driver_loads only: last day (inclusive) when a RANGE was asked.',
      },
      question: {
        type: 'string',
        description: 'clarify only: one short question asking for the missing piece.',
      },
    },
    required: ['kind'],
  },
} as const;

export const haikuCommandSystem = (
  todayISO: string,
) => `You parse voice commands for a truck-dispatch app into the set_intent tool.
Today's date is ${todayISO}.
Commands you may see: assigning a load to a driver ("assign", "give", "put ... on"), moving an appointment window to a time, accepting or declining a broker offer, asking which loads a driver had or has on a day or across days (driver_loads), asking what's on the board, asking about alerts/exceptions.
The text is a SPEECH TRANSCRIPT and may contain recognition errors — interpret charitably ("have hit" is likely "have it", "for jorge" may arrive as "four jorge"). Ignore filler words and politeness.
Rules:
- loadRef: the load/trip number or HCR code as spoken, digits preferred ("load ten oh one" → "1001").
- assign BY ROUTE: when the command names trip(s) and/or an HCR/contract ("trip 5 HCR 96036 assign to Jorge", "put Marcus on contract 902 trip 12", "trips 5 and 6 contract 96036 to Jorge"), set trips (one entry per trip named) and/or hcr — NOT loadRef — plus driverQuery. Any spoken days ("tomorrow", "Saturday", "tomorrow and Saturday") become the dates array resolved from today's date; no day spoken = omit dates.
- driverQuery: the driver's name only — strip titles and words like "driver". "Jorge's loads" → driverQuery "Jorge".
- move_window: hour is 24-hour; a bare 1-7 with no am/pm means afternoon (add 12).
- accept_offer/decline_offer: loadRef may be omitted when no number was said.
- driver_loads single day: date resolved from context ("yesterday", "last Friday"); omit when no day was mentioned (means today).
- driver_loads range: set date AND dateEnd (inclusive). "this week" = Monday of the current week through today. "last week" = Monday through Sunday of the previous week. "last 3 days" = the 3 days ending today.
- clarify: when the command's INTENT is clear but a required piece is missing — move_window without a time, assign without a driver or without a load — set kind "clarify" and ask ONE short question for the missing piece (e.g. "What time should load 1001 move to?"). Do not clarify things you can resolve yourself.
Context rules (when "Recent conversation" is provided):
- Use it ONLY to resolve references in the NEW utterance — pronouns and elliptical follow-ups. After a driver-loads answer, "what about Sam" = the same question for Sam with the same day/range; "same for last week" = the previous command with the new dates; "it" / "that load" = the load number mentioned most recently.
- Parse only what the new utterance asks for. Never repeat an action that the conversation shows was already confirmed, executed, declined, or cancelled.
- If a follow-up cannot be resolved from the conversation, use clarify or unknown — never guess the referent.
- Anything else, or anything you are unsure about: kind "unknown". Never invent numbers, names, or dates.`;

// ── Conversational context (NLU v4) ─────────────────────────────────

export const MAX_HISTORY_TURNS = 8;
export const MAX_TURN_CHARS = 200;

export interface VoiceTurn {
  role: 'you' | 'agent';
  text: string;
}

/**
 * Render the NLU input: recent on-screen turns (capped and truncated —
 * context is a few hundred Haiku tokens, not a transcript dump), the
 * pending-clarification bridge when present, then the new utterance.
 * With no context at all, returns the bare transcript so single-shot
 * behavior (and its logs) stay byte-identical to v3.
 */
export function buildNluInput(
  transcript: string,
  history?: VoiceTurn[] | null,
  contextText?: string | null,
): string {
  const parts: string[] = [];
  const turns = (history ?? []).slice(-MAX_HISTORY_TURNS);
  if (turns.length > 0) {
    parts.push('Recent conversation (oldest first):');
    for (const t of turns) {
      const text =
        t.text.length > MAX_TURN_CHARS ? `${t.text.slice(0, MAX_TURN_CHARS)}…` : t.text;
      parts.push(`${t.role === 'you' ? 'Dispatcher' : 'Assistant'}: ${text}`);
    }
  }
  if (contextText) {
    parts.push(`Earlier command awaiting completion: "${contextText}"`);
  }
  if (parts.length === 0) return transcript;
  parts.push(`New dispatcher utterance: "${transcript}"`);
  return parts.join('\n');
}

/** Client-facing intent — mirrors apps/dispatch/lib/voice/parser.ts. */
export type CoercedIntent =
  | {
      kind: 'assign';
      loadRef: string | null;
      hcr: string | null;
      /** First trip — kept for older app bundles; trips is the full list. */
      trip: string | null;
      trips: string[] | null;
      dates: string[] | null;
      driverQuery: string;
    }
  | { kind: 'move_window'; loadRef: string; time: { hour: number; minute: number } }
  | { kind: 'accept_offer'; loadRef: string | null }
  | { kind: 'decline_offer'; loadRef: string | null }
  | { kind: 'driver_history'; driverQuery: string; date: string | null; dateEnd: string | null }
  | { kind: 'clarify'; question: string }
  | { kind: 'board_summary' }
  | { kind: 'alerts_summary' };

// ── Load dictation (§5.6 Phase 3) ────────────────────────────────────

/** The tool Haiku is forced to call for dictated load drafts. */
export const LOAD_DRAFT_TOOL = {
  name: 'set_load_draft',
  description: 'Report the load details extracted from a dispatcher dictation.',
  input_schema: {
    type: 'object' as const,
    properties: {
      customerName: { type: 'string', description: 'Customer/shipper name as spoken.' },
      commodity: { type: 'string', description: "What's on the trailer." },
      pickupAddress: { type: 'string', description: 'Pickup address or city/state as spoken.' },
      dropoffAddress: { type: 'string', description: 'Delivery address or city/state as spoken.' },
      pickupDate: { type: 'string', description: 'Pickup date YYYY-MM-DD, resolved from context.' },
      pickupHour: { type: 'integer', description: 'Pickup window start, 24h (0-23).' },
      dropoffDate: { type: 'string', description: 'Delivery date YYYY-MM-DD, resolved from context.' },
      dropoffHour: { type: 'integer', description: 'Delivery window start, 24h (0-23).' },
    },
    required: [],
  },
} as const;

export const haikuLoadSystem = (todayISO: string) =>
  `You extract load details from a truck dispatcher's dictation into the set_load_draft tool.
Today's date is ${todayISO}. Resolve relative dates ("tomorrow", "Friday") to YYYY-MM-DD.
Rules:
- Addresses exactly as spoken (a bare city/state is fine). First location mentioned is the pickup unless stated otherwise.
- Hours are 24-hour window STARTS; a bare 1-7 with no am/pm means afternoon (add 12).
- Only report what was actually said — omit anything not mentioned. Never invent details.`;

export interface LoadDraft {
  customerName: string | null;
  commodity: string | null;
  pickupAddress: string | null;
  dropoffAddress: string | null;
  pickupDate: string | null;
  pickupHour: number | null;
  dropoffDate: string | null;
  dropoffHour: number | null;
}

/**
 * Validate + reshape Haiku's load-draft tool input. Every field
 * optional; null when nothing usable was extracted. Never throws.
 */
export function coerceLoadDraft(raw: unknown): LoadDraft | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const hour = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23 ? v : null;
  const date = (v: unknown) => {
    const s = str(v);
    return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };
  const draft: LoadDraft = {
    customerName: str(r.customerName),
    commodity: str(r.commodity),
    pickupAddress: str(r.pickupAddress),
    dropoffAddress: str(r.dropoffAddress),
    pickupDate: date(r.pickupDate),
    pickupHour: hour(r.pickupHour),
    dropoffDate: date(r.dropoffDate),
    dropoffHour: hour(r.dropoffHour),
  };
  return Object.values(draft).some((v) => v !== null) ? draft : null;
}

/**
 * Validate + reshape Haiku's tool input. Returns null for anything
 * malformed or "unknown" — the caller then falls back to the
 * deterministic on-device parser. Never throws.
 */
export function coerceIntent(raw: unknown): CoercedIntent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  switch (r.kind) {
    case 'assign': {
      const loadRef = str(r.loadRef);
      const hcr = str(r.hcr);
      const driverQuery = str(r.driverQuery);
      // Trips: gather from trips[] and legacy trip, then split spoken
      // conjunctions ("5 and 6", "5, 6") the model may leave joined.
      const tripInputs = [
        ...(Array.isArray(r.trips) ? r.trips : []),
        r.trip,
      ].filter((t): t is string => typeof t === 'string');
      const trips = [
        ...new Set(
          tripInputs
            .flatMap((t) => t.split(/\s*(?:,|&|\band\b)\s*/i))
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ].slice(0, 10);
      // ISO dates only, deduped — bad entries drop silently (STT noise).
      const dates = Array.isArray(r.dates)
        ? [
            ...new Set(
              r.dates.filter(
                (d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d),
              ),
            ),
          ].slice(0, 7)
        : [];
      if (!driverQuery || (!loadRef && !hcr && trips.length === 0)) return null;
      return {
        kind: 'assign',
        loadRef,
        hcr,
        trip: trips[0] ?? null,
        trips: trips.length ? trips : null,
        dates: dates.length ? dates : null,
        driverQuery,
      };
    }
    case 'move_window': {
      const loadRef = str(r.loadRef);
      const hour = typeof r.hour === 'number' && Number.isInteger(r.hour) ? r.hour : null;
      const minute = typeof r.minute === 'number' && Number.isInteger(r.minute) ? r.minute : 0;
      if (!loadRef || hour === null || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
      return { kind: 'move_window', loadRef, time: { hour, minute } };
    }
    case 'accept_offer':
      return { kind: 'accept_offer', loadRef: str(r.loadRef) };
    case 'decline_offer':
      return { kind: 'decline_offer', loadRef: str(r.loadRef) };
    case 'driver_loads': {
      const driverQuery = str(r.driverQuery);
      if (!driverQuery) return null;
      const iso = (v: unknown) => {
        const s = str(v);
        return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
      };
      let date = iso(r.date);
      let dateEnd = iso(r.dateEnd);
      // A range needs a valid start; swap an inverted range rather than
      // failing the whole intent.
      if (dateEnd && !date) [date, dateEnd] = [dateEnd, null];
      if (date && dateEnd && dateEnd < date) [date, dateEnd] = [dateEnd, date];
      if (dateEnd === date) dateEnd = null;
      return { kind: 'driver_history', driverQuery, date, dateEnd };
    }
    case 'clarify': {
      const question = str(r.question);
      return question ? { kind: 'clarify', question } : null;
    }
    case 'board_summary':
      return { kind: 'board_summary' };
    case 'alerts_summary':
      return { kind: 'alerts_summary' };
    default:
      return null;
  }
}
