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
          'board_summary',
          'alerts_summary',
          'unknown',
        ],
      },
      loadRef: {
        type: 'string',
        description: 'Load / trip number or HCR exactly as spoken, e.g. "1001", "L-1001", "HCR75960".',
      },
      driverQuery: { type: 'string', description: 'Driver name as spoken (assign only).' },
      hour: { type: 'integer', description: '24h hour for move_window (0-23).' },
      minute: { type: 'integer', description: 'Minute for move_window (0-59).' },
    },
    required: ['kind'],
  },
} as const;

export const HAIKU_SYSTEM = `You parse voice commands for a truck-dispatch app into the set_intent tool.
Commands you may see: assigning a load to a driver ("assign", "give", "put ... on"), moving an appointment window to a time, accepting or declining a broker offer, asking what's on the board, asking about alerts/exceptions.
Rules:
- loadRef: the load/trip number or HCR code as spoken, digits preferred ("load ten oh one" → "1001").
- driverQuery: the driver's name only, no titles.
- move_window: hour is 24-hour; a bare 1-7 with no am/pm means afternoon (add 12).
- accept_offer/decline_offer: loadRef may be omitted when no number was said.
- Anything else, or anything you are unsure about: kind "unknown". Never invent numbers or names.`;

/** Client-facing intent — mirrors apps/dispatch/lib/voice/parser.ts. */
export type CoercedIntent =
  | { kind: 'assign'; loadRef: string; driverQuery: string }
  | { kind: 'move_window'; loadRef: string; time: { hour: number; minute: number } }
  | { kind: 'accept_offer'; loadRef: string | null }
  | { kind: 'decline_offer'; loadRef: string | null }
  | { kind: 'board_summary' }
  | { kind: 'alerts_summary' };

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
      const driverQuery = str(r.driverQuery);
      return loadRef && driverQuery ? { kind: 'assign', loadRef, driverQuery } : null;
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
    case 'board_summary':
      return { kind: 'board_summary' };
    case 'alerts_summary':
      return { kind: 'alerts_summary' };
    default:
      return null;
  }
}
