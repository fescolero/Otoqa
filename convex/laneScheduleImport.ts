import { v } from 'convex/values';
import { action } from './_generated/server';
import OpenAI from 'openai';
import { requireCallerOrgId } from './lib/auth';

// ==========================================
// LANE SCHEDULE OCR IMPORT
// Extracts contracted lane data from bid packages,
// schedules, and route documents using GPT-4o-mini vision.
// ==========================================

// Extracted lane entry with confidence scoring
export interface ExtractedLaneEntry {
  laneName: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  originCity: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  originState: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  originZip: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  originAddress: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  destinationCity: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  destinationState: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  destinationZip: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  destinationAddress: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  miles: { value: number | null; confidence: 'high' | 'medium' | 'low' };
  rateType: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  rate: { value: number | null; confidence: 'high' | 'medium' | 'low' };
  frequency: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  activeDays: { value: number[] | null; confidence: 'high' | 'medium' | 'low' };
  excludeHolidays: { value: boolean | null; confidence: 'high' | 'medium' | 'low' };
  equipmentType: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  equipmentSize: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  contractStart: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  contractEnd: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  hcr: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  tripNumber: { value: string | null; confidence: 'high' | 'medium' | 'low' };
  isRoundTrip: { value: boolean | null; confidence: 'high' | 'medium' | 'low' };
  notes: { value: string | null; confidence: 'high' | 'medium' | 'low' };
}

function buildLaneExtractionPrompt(): string {
  return `You are a transportation logistics document parser specializing in contracted lane schedules and bid packages.

Extract every distinct contracted lane/route from the document. Each lane represents a recurring freight route with a schedule.

Common document formats include:
- Bid packages with lane tables (origin, destination, frequency, rate)
- Route schedules with day-of-week assignments
- Contract lane summaries with HCR/trip identifiers
- Multi-page spreadsheet exports of lane data

Terminology:
- HCR = Haul Contract Route (a route identifier like "917DK")
- Trip = Trip number within an HCR (like "1", "2", "A", "B")
- Lane = A specific origin → destination route
- Frequency = How often the lane runs (daily, Mon/Wed/Fri, etc.)
- APPT = Appointment, FCFS = First Come First Served, Live = Live load/unload

Rules:
1. Return ONLY valid JSON. No markdown, no explanation.
2. Use this exact shape: {"entries":[...]}.
3. Each entry represents one distinct lane/route, not a single trip or shipment.
4. If a lane has multiple stops, use the first pickup as origin and last delivery as destination.
5. Parse schedule/frequency into activeDays as day-of-week numbers: 0=Sunday, 1=Monday, ..., 6=Saturday.
  - "Daily" = [0,1,2,3,4,5,6]
  - "Daily except Sunday" = [1,2,3,4,5,6]
  - "Mon-Fri" or "Weekdays" = [1,2,3,4,5]
  - "Mon/Wed/Fri" = [1,3,5]
  - "Tue/Thu" = [2,4]
  - If frequency says "except holidays" or "no holidays", set excludeHolidays to true.
6. Rate should be the per-run or per-mile rate. Note the rateType: "Flat Rate", "Per Mile", or "Per Stop".
7. Equipment types: "Dry Van", "Refrigerated", "Flatbed", "Tanker", "Bobtail"
8. Equipment sizes: "53ft", "48ft", "45ft"
9. If a lane shows both outbound and return legs as separate entries, extract each as a separate lane.
10. If a lane explicitly states round-trip, set isRoundTrip to true.
11. Dates should be in YYYY-MM-DD format for contractStart and contractEnd.
12. If a field is not visible or cannot be determined, use null.
13. Do not guess values. Ambiguous fields should have lower confidence.
14. Numeric fields must be numbers only, not strings.

Fields to extract for each lane:
- laneName: descriptive name (e.g., "Detroit MI → Chicago IL Daily")
- originCity: origin city name
- originState: origin state abbreviation (2-letter)
- originZip: origin ZIP code if shown
- originAddress: full origin address if shown
- destinationCity: destination city name
- destinationState: destination state abbreviation (2-letter)
- destinationZip: destination ZIP code if shown
- destinationAddress: full destination address if shown
- miles: route miles/distance if shown
- rateType: "Flat Rate", "Per Mile", or "Per Stop"
- rate: the rate amount (per run for flat, per mile for per-mile, per stop for per-stop)
- frequency: original frequency text as shown (e.g., "Mon-Fri except holidays")
- activeDays: parsed day-of-week array [0-6]
- excludeHolidays: whether holidays are excluded from schedule
- equipmentType: equipment class if shown
- equipmentSize: trailer size if shown
- contractStart: contract start date in YYYY-MM-DD if shown
- contractEnd: contract end date in YYYY-MM-DD if shown
- hcr: HCR/route identifier if shown
- tripNumber: trip number if shown
- isRoundTrip: whether the lane is explicitly a round-trip
- notes: any relevant notes or special instructions

Each field must be an object: {"value": <value-or-null>, "confidence": "high"|"medium"|"low"}

Example:
{
  "entries": [
    {
      "laneName": {"value": "Detroit MI → Chicago IL Mon-Fri", "confidence": "high"},
      "originCity": {"value": "Detroit", "confidence": "high"},
      "originState": {"value": "MI", "confidence": "high"},
      "originZip": {"value": "48201", "confidence": "medium"},
      "originAddress": {"value": "1234 Industrial Blvd, Detroit, MI 48201", "confidence": "medium"},
      "destinationCity": {"value": "Chicago", "confidence": "high"},
      "destinationState": {"value": "IL", "confidence": "high"},
      "destinationZip": {"value": "60601", "confidence": "medium"},
      "destinationAddress": {"value": "5678 Warehouse Dr, Chicago, IL 60601", "confidence": "medium"},
      "miles": {"value": 282, "confidence": "high"},
      "rateType": {"value": "Flat Rate", "confidence": "high"},
      "rate": {"value": 850.00, "confidence": "high"},
      "frequency": {"value": "Mon-Fri except federal holidays", "confidence": "high"},
      "activeDays": {"value": [1,2,3,4,5], "confidence": "high"},
      "excludeHolidays": {"value": true, "confidence": "high"},
      "equipmentType": {"value": "Dry Van", "confidence": "high"},
      "equipmentSize": {"value": "53ft", "confidence": "medium"},
      "contractStart": {"value": "2027-01-01", "confidence": "high"},
      "contractEnd": {"value": "2027-12-31", "confidence": "high"},
      "hcr": {"value": "917DK", "confidence": "high"},
      "tripNumber": {"value": "1", "confidence": "high"},
      "isRoundTrip": {"value": false, "confidence": "high"},
      "notes": {"value": "Must arrive by 06:00 AM", "confidence": "medium"}
    }
  ]
}`;
}

/**
 * Extract lane entries from bid package pages using GPT-4o-mini vision.
 */
export const extractLanesFromDocument = action({
  args: {
    pages: v.array(
      v.object({
        imageUrl: v.string(),
        pageText: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ entries: ExtractedLaneEntry[]; error?: string }> => {
    await requireCallerOrgId(ctx);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { entries: [], error: 'OPENAI_API_KEY not configured' };
    }

    const openai = new OpenAI({ apiKey });

    try {
      const allEntries: ExtractedLaneEntry[] = [];

      // Process pages in chunks (up to 4 pages per chunk for context)
      const chunkSize = 4;
      for (let i = 0; i < args.pages.length; i += chunkSize) {
        const chunk = args.pages.slice(i, i + chunkSize);

        const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

        for (const page of chunk) {
          content.push({
            type: 'image_url',
            image_url: { url: page.imageUrl, detail: 'high' },
          });
          if (page.pageText) {
            content.push({
              type: 'text',
              text: `Extracted page text:\n${page.pageText}`,
            });
          }
        }

        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: buildLaneExtractionPrompt() },
            { role: 'user', content },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 16000,
          temperature: 0,
        });

        const raw = response.choices[0]?.message?.content;
        if (!raw) continue;

        let parsed: { entries?: unknown[] } | null = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Try to repair truncated JSON
          parsed = repairTruncatedJson(raw);
        }

        if (parsed?.entries && Array.isArray(parsed.entries)) {
          for (const entry of parsed.entries) {
            allEntries.push(normalizeExtractedLane(entry as Record<string, unknown>));
          }
        }
      }

      // Deduplicate by origin+destination+frequency
      const seen = new Set<string>();
      const deduped = allEntries.filter((entry) => {
        const key = [
          entry.originCity.value,
          entry.originState.value,
          entry.destinationCity.value,
          entry.destinationState.value,
          entry.frequency.value,
        ].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return { entries: deduped };
    } catch (error) {
      console.error('Lane extraction error:', error);
      return { entries: [], error: String(error) };
    }
  },
});

// ---- HELPERS ----

function repairTruncatedJson(raw: string): { entries?: unknown[] } | null {
  try {
    return JSON.parse(raw);
  } catch {
    // Try closing open arrays/objects
    let attempt = raw;
    const openBrackets = (attempt.match(/\[/g) || []).length - (attempt.match(/\]/g) || []).length;
    const openBraces = (attempt.match(/\{/g) || []).length - (attempt.match(/\}/g) || []).length;
    attempt += '}]'.repeat(Math.max(0, Math.min(openBrackets, openBraces)));
    attempt += ']'.repeat(Math.max(0, openBrackets - openBraces));
    attempt += '}'.repeat(Math.max(0, openBraces - openBrackets));

    try {
      return JSON.parse(attempt);
    } catch {
      return null;
    }
  }
}

function toConfidenceField<T>(
  obj: Record<string, unknown>,
  key: string,
  transform?: (v: unknown) => T | null,
): { value: T | null; confidence: 'high' | 'medium' | 'low' } {
  const field = obj[key] as { value?: unknown; confidence?: string } | undefined;
  if (!field || typeof field !== 'object') {
    return { value: null, confidence: 'low' };
  }
  const rawValue = field.value ?? null;
  const confidence = (['high', 'medium', 'low'].includes(field.confidence as string)
    ? field.confidence
    : 'low') as 'high' | 'medium' | 'low';
  const value = transform ? transform(rawValue) : (rawValue as T | null);
  return { value, confidence };
}

function normalizeExtractedLane(raw: Record<string, unknown>): ExtractedLaneEntry {
  return {
    laneName: toConfidenceField(raw, 'laneName', (v) => (typeof v === 'string' ? v.trim() : null)),
    originCity: toConfidenceField(raw, 'originCity', (v) => (typeof v === 'string' ? v.trim() : null)),
    originState: toConfidenceField(raw, 'originState', (v) => (typeof v === 'string' ? v.trim().toUpperCase() : null)),
    originZip: toConfidenceField(raw, 'originZip', (v) => (typeof v === 'string' ? v.trim() : null)),
    originAddress: toConfidenceField(raw, 'originAddress', (v) => (typeof v === 'string' ? v.trim() : null)),
    destinationCity: toConfidenceField(raw, 'destinationCity', (v) => (typeof v === 'string' ? v.trim() : null)),
    destinationState: toConfidenceField(raw, 'destinationState', (v) => (typeof v === 'string' ? v.trim().toUpperCase() : null)),
    destinationZip: toConfidenceField(raw, 'destinationZip', (v) => (typeof v === 'string' ? v.trim() : null)),
    destinationAddress: toConfidenceField(raw, 'destinationAddress', (v) => (typeof v === 'string' ? v.trim() : null)),
    miles: toConfidenceField(raw, 'miles', (v) => (typeof v === 'number' ? v : null)),
    rateType: toConfidenceField(raw, 'rateType', (v) => {
      if (typeof v !== 'string') return null;
      const normalized = v.trim();
      if (['Flat Rate', 'Per Mile', 'Per Stop'].includes(normalized)) return normalized;
      if (normalized.toLowerCase().includes('flat')) return 'Flat Rate';
      if (normalized.toLowerCase().includes('mile')) return 'Per Mile';
      if (normalized.toLowerCase().includes('stop')) return 'Per Stop';
      return normalized;
    }),
    rate: toConfidenceField(raw, 'rate', (v) => (typeof v === 'number' ? v : null)),
    frequency: toConfidenceField(raw, 'frequency', (v) => (typeof v === 'string' ? v.trim() : null)),
    activeDays: toConfidenceField(raw, 'activeDays', (v) => {
      if (Array.isArray(v) && v.every((d) => typeof d === 'number')) return v as number[];
      return null;
    }),
    excludeHolidays: toConfidenceField(raw, 'excludeHolidays', (v) => (typeof v === 'boolean' ? v : null)),
    equipmentType: toConfidenceField(raw, 'equipmentType', (v) => (typeof v === 'string' ? v.trim() : null)),
    equipmentSize: toConfidenceField(raw, 'equipmentSize', (v) => (typeof v === 'string' ? v.trim() : null)),
    contractStart: toConfidenceField(raw, 'contractStart', (v) => (typeof v === 'string' ? v.trim() : null)),
    contractEnd: toConfidenceField(raw, 'contractEnd', (v) => (typeof v === 'string' ? v.trim() : null)),
    hcr: toConfidenceField(raw, 'hcr', (v) => (typeof v === 'string' ? v.trim() : null)),
    tripNumber: toConfidenceField(raw, 'tripNumber', (v) => (typeof v === 'string' ? v.trim() : String(v))),
    isRoundTrip: toConfidenceField(raw, 'isRoundTrip', (v) => (typeof v === 'boolean' ? v : null)),
    notes: toConfidenceField(raw, 'notes', (v) => (typeof v === 'string' ? v.trim() : null)),
  };
}
