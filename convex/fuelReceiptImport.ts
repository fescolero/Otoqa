'use node';

import OpenAI from 'openai';
import { v } from 'convex/values';
import { action } from './_generated/server';

const confidenceValidator = v.union(v.literal('high'), v.literal('medium'), v.literal('low'));

const extractedFieldValidator = v.object({
  value: v.any(),
  confidence: confidenceValidator,
});

const extractedFuelEntryValidator = v.object({
  entryDate: extractedFieldValidator,
  vendorName: extractedFieldValidator,
  gallons: extractedFieldValidator,
  pricePerGallon: extractedFieldValidator,
  fuelType: v.optional(extractedFieldValidator),
  totalCost: v.optional(extractedFieldValidator),
  odometerReading: v.optional(extractedFieldValidator),
  city: v.optional(extractedFieldValidator),
  state: v.optional(extractedFieldValidator),
  fuelCardNumber: v.optional(extractedFieldValidator),
  receiptNumber: v.optional(extractedFieldValidator),
  paymentMethod: v.optional(extractedFieldValidator),
  driverName: v.optional(extractedFieldValidator),
  carrierName: v.optional(extractedFieldValidator),
  truckUnit: v.optional(extractedFieldValidator),
  notes: v.optional(extractedFieldValidator),
});

type Confidence = 'high' | 'medium' | 'low';

type ExtractedField<T = string | number | null> = {
  value: T;
  confidence: Confidence;
};

type ExtractedFuelEntry = {
  entryDate: ExtractedField<string | null>;
  vendorName: ExtractedField<string | null>;
  gallons: ExtractedField<number | null>;
  pricePerGallon: ExtractedField<number | null>;
  fuelType?: ExtractedField<string | null>;
  totalCost?: ExtractedField<number | null>;
  odometerReading?: ExtractedField<number | null>;
  city?: ExtractedField<string | null>;
  state?: ExtractedField<string | null>;
  fuelCardNumber?: ExtractedField<string | null>;
  receiptNumber?: ExtractedField<string | null>;
  paymentMethod?: ExtractedField<string | null>;
  driverName?: ExtractedField<string | null>;
  carrierName?: ExtractedField<string | null>;
  truckUnit?: ExtractedField<string | null>;
  notes?: ExtractedField<string | null>;
};

function wrap<T>(value: T, confidence: Confidence = 'high'): ExtractedField<T> {
  return { value, confidence };
}

function normalizePaymentMethod(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  const map: Record<string, string> = {
    'fuel_card': 'FUEL_CARD',
    'fuel card': 'FUEL_CARD',
    'fuelcard': 'FUEL_CARD',
    'cash': 'CASH',
    'check': 'CHECK',
    'credit card': 'CREDIT_CARD',
    'credit_card': 'CREDIT_CARD',
    'credit-card': 'CREDIT_CARD',
    'cc': 'CREDIT_CARD',
    'efs': 'EFS',
    'comdata': 'COMDATA',
  };

  return map[normalized] || value.toString().trim().toUpperCase() || null;
}

function normalizeConfidence(value: unknown): Confidence {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;

  const cleaned = value.replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function buildPrompt(vendorNames: string[]) {
  const vendorSection = vendorNames.length
    ? `\nKnown vendor names for this organization: ${vendorNames.join(', ')}. If a receipt clearly matches one of these, return that exact vendor name.`
    : '';

  return `You are an OCR extraction assistant for diesel fuel imports in a transportation system.

The uploaded files may be phone photos, scans, PDFs, fuel receipts, emailed invoices, or multi-page vendor statements. Vendor layouts vary widely. There is NO standard template, so rely on labels, line items, headers, tables, totals, card data, and surrounding context.${vendorSection}

OCR context / terminology:
- Prod = Product
- DSL = Diesel
- ULSD = Ultra Low Sulfur Diesel
- AGO = Automotive Gas Oil / Diesel
- GSL = Gasoline
- REG = Regular Gasoline
- UNL = Unleaded Gasoline
- PREM = Premium Gasoline
- MID = Midgrade Gasoline
- DEF = Diesel Exhaust Fluid
- Price = Price/Gal
- Quantity = Gallons
- Amt Excp Code = line-item total amount

Extract every distinct diesel or fuel purchase transaction visible across all pages.

Rules:
1. Return ONLY valid JSON. No markdown.
2. Use this exact shape: {"entries":[...]}.
3. Each entry must map to one actual fuel purchase transaction line item, never a statement summary or rolled-up daily/monthly total.
4. If the same transaction appears on multiple pages, return it once.
5. Ignore non-fuel merchandise, loyalty messages, footer text, and non-transaction summary sections.
6. Ignore DEF-only purchases.
7. If a field is missing, use null.
8. Do not guess. Low-quality or ambiguous values should still be returned if visible, but with lower confidence.
9. Numeric fields must be numbers only.
10. paymentMethod must be one of: FUEL_CARD, CASH, CHECK, CREDIT_CARD, EFS, COMDATA, or null.
11. If the document is a statement with a summary total and transaction detail rows, extract the detail rows only.
12. If a single page shows multiple transaction lines, return one entry per line.
13. Keep column meanings strict. Do not swap quantity, unit price, and total.
14. If a table uses QUANTITY, map it to gallons.
15. If a table uses PRICE, PRICE/GAL, UNIT PRICE, or similar, map it to pricePerGallon.
16. If a table uses AMT, AMOUNT, AMT EXCP CODE, EXT AMOUNT, LINE TOTAL, or similar, map it to totalCost.
17. If a row contains both gallons and total but the price is missing, do not copy the total into pricePerGallon.
18. If a value is ambiguous between total and price, prefer null over guessing.
19. Some statements contain grouped sections where the header appears once and later rows continue under the same column positions after a visual break.
20. If a group of rows continues after a blank line, driver section, or subtotal without a repeated header, keep using the same prior column mapping.
21. Do not remap columns after section breaks unless a clearly new header row appears.

Fields to extract for each entry:
- entryDate: purchase date as shown on document
- vendorName: merchant/vendor/fuel stop name
- gallons: fuel quantity purchased
- pricePerGallon: price per gallon / unit price
- fuelType: fuel product/type/code when shown (examples: DSL, DIESEL, ULSD, AGO, GSL, REG, UNL, DEF)
- totalCost: transaction total if shown
- odometerReading: odometer / mileage reading
- city: city if shown
- state: state if shown
- fuelCardNumber: fuel card number or masked card number if shown
- receiptNumber: receipt, invoice, transaction, or ticket number if shown
- paymentMethod: normalized payment method enum
- driverName: driver name if shown
- carrierName: carrier name if shown and the fuel is tied to a carrier rather than a driver
- truckUnit: truck/unit/tractor number if shown
- notes: short note only when useful for context or ambiguity

Important mapping checks:
- gallons should usually be the QUANTITY field and often contains values like 10.0, 57.43, 126.44
- pricePerGallon should usually be a smaller per-unit number like 2.99, 3.419, 4.12
- totalCost should usually equal or closely match gallons x pricePerGallon
- never place a line total into gallons or pricePerGallon
- when provided extracted page text, treat each text line as a candidate table row and preserve the same column meaning across later grouped sections

Each field must be an object shaped like:
{"value": <value-or-null>, "confidence": "high"|"medium"|"low"}

Example:
{
  "entries": [
    {
      "entryDate": {"value": "03/11/2026", "confidence": "high"},
      "vendorName": {"value": "Love's Travel Stop", "confidence": "high"},
      "gallons": {"value": 126.44, "confidence": "high"},
      "pricePerGallon": {"value": 3.419, "confidence": "high"},
      "fuelType": {"value": "DSL", "confidence": "high"},
      "totalCost": {"value": 432.32, "confidence": "high"},
      "odometerReading": {"value": 401122, "confidence": "medium"},
      "city": {"value": "Amarillo", "confidence": "medium"},
      "state": {"value": "TX", "confidence": "medium"},
      "fuelCardNumber": {"value": "****1234", "confidence": "medium"},
      "receiptNumber": {"value": "948221", "confidence": "high"},
      "paymentMethod": {"value": "COMDATA", "confidence": "medium"},
      "driverName": {"value": "John Smith", "confidence": "low"},
      "carrierName": {"value": null, "confidence": "low"},
      "truckUnit": {"value": "T-204", "confidence": "medium"},
      "notes": {"value": "Transaction appears in statement detail table", "confidence": "low"}
    }
  ]
}`;
}

function repairTruncatedJson(raw: string): { entries?: unknown[] } | null {
  try {
    return JSON.parse(raw);
  } catch {
    // Try partial recovery.
  }

  try {
    const entriesIndex = raw.indexOf('"entries"');
    if (entriesIndex === -1) return null;

    const arrayStart = raw.indexOf('[', entriesIndex);
    if (arrayStart === -1) return null;

    let depth = 0;
    let lastValidEnd = -1;
    for (let i = arrayStart + 1; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      if (raw[i] === '}') {
        depth--;
        if (depth === 0) lastValidEnd = i;
      }
    }

    if (lastValidEnd === -1) return null;
    return JSON.parse(`${raw.slice(0, lastValidEnd + 1)}]}`);
  } catch {
    return null;
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function buildEntryKey(entry: ExtractedFuelEntry): string {
  return [
    entry.entryDate.value ?? '',
    entry.vendorName.value ?? '',
    entry.receiptNumber?.value ?? '',
    entry.driverName?.value ?? '',
    entry.carrierName?.value ?? '',
    entry.truckUnit?.value ?? '',
    entry.gallons.value ?? '',
    entry.pricePerGallon.value ?? '',
    entry.totalCost?.value ?? '',
  ]
    .map((value) => String(value).trim().toLowerCase())
    .join('|');
}

async function extractChunk(
  openai: OpenAI,
  prompt: string,
  pages: Array<{ imageUrl: string; pageText?: string }>,
  chunkLabel: string,
  instruction?: string,
): Promise<{ entries: ExtractedFuelEntry[]; error?: string }> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: [
          ...pages.map((page) => ({
            type: 'image_url' as const,
            image_url: { url: page.imageUrl, detail: 'high' as const },
          })),
          ...pages
            .filter((page) => !!page.pageText?.trim())
            .map((page, index) => ({
              type: 'text' as const,
              text: `Extracted text for ${chunkLabel}${pages.length > 1 ? ` item ${index + 1}` : ''}:\n${page.pageText}`,
            })),
          {
            type: 'text' as const,
            text:
              instruction ??
              `Extract all diesel fuel purchase transactions from ${chunkLabel}. Return one entry per visible transaction line item.`,
          },
        ],
      },
    ],
    max_tokens: 16000,
    temperature: 0,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return { entries: [], error: `No response content from OpenAI for ${chunkLabel}` };
  }

  const parsed = response.choices[0]?.finish_reason === 'length' ? repairTruncatedJson(content) : JSON.parse(content);
  if (!parsed || !Array.isArray(parsed.entries)) {
    return { entries: [], error: `OpenAI response did not contain a valid entries array for ${chunkLabel}` };
  }

  return {
    entries: parsed.entries
      .filter((entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map(normalizeEntry),
  };
}

async function extractChunkWithAudit(
  openai: OpenAI,
  prompt: string,
  pages: Array<{ imageUrl: string; pageText?: string }>,
  chunkLabel: string,
): Promise<{ entries: ExtractedFuelEntry[]; error?: string }> {
  const primary = await extractChunk(
    openai,
    prompt,
    pages,
    chunkLabel,
    `Extract all diesel fuel purchase transactions from ${chunkLabel}. Return one entry per visible transaction line item. Be exhaustive and include every row in dense statement tables. Respect column semantics exactly: QUANTITY means gallons, PRICE means pricePerGallon, and AMT EXCP CODE means totalCost for that line item. If grouped rows continue after a visual break without a repeated header, keep using the same column mapping from the prior header.`,
  );

  if (primary.error) return primary;

  const knownEntries = primary.entries.map((entry) => ({
    entryDate: entry.entryDate.value,
    vendorName: entry.vendorName.value,
    gallons: entry.gallons.value,
    pricePerGallon: entry.pricePerGallon.value,
    totalCost: entry.totalCost?.value ?? null,
    receiptNumber: entry.receiptNumber?.value ?? null,
    driverName: entry.driverName?.value ?? null,
    carrierName: entry.carrierName?.value ?? null,
    truckUnit: entry.truckUnit?.value ?? null,
  }));

  const audit = await extractChunk(
    openai,
    prompt,
    pages,
    chunkLabel,
    `Review ${chunkLabel} again for missed transaction rows. Dense tables often contain more line items than the first pass catches. Already extracted rows: ${JSON.stringify(knownEntries)}. Return only additional missing transaction line items not already listed. While auditing, keep field mapping strict: QUANTITY -> gallons, PRICE -> pricePerGallon, AMT EXCP CODE -> totalCost. If later row groups do not repeat the header, continue using the same prior column mapping.`,
  );

  if (audit.error) return primary;

  const deduped = new Map<string, ExtractedFuelEntry>();
  for (const entry of [...primary.entries, ...audit.entries]) {
    deduped.set(buildEntryKey(entry), entry);
  }

  return { entries: Array.from(deduped.values()) };
}

function normalizeEntry(entry: Record<string, unknown>): ExtractedFuelEntry {
  const entryDate = entry.entryDate as Record<string, unknown> | undefined;
  const vendorName = entry.vendorName as Record<string, unknown> | undefined;
  const gallons = entry.gallons as Record<string, unknown> | undefined;
  const pricePerGallon = entry.pricePerGallon as Record<string, unknown> | undefined;
  const fuelType = entry.fuelType as Record<string, unknown> | undefined;
  const totalCost = entry.totalCost as Record<string, unknown> | undefined;
  const odometerReading = entry.odometerReading as Record<string, unknown> | undefined;
  const city = entry.city as Record<string, unknown> | undefined;
  const state = entry.state as Record<string, unknown> | undefined;
  const fuelCardNumber = entry.fuelCardNumber as Record<string, unknown> | undefined;
  const receiptNumber = entry.receiptNumber as Record<string, unknown> | undefined;
  const paymentMethod = entry.paymentMethod as Record<string, unknown> | undefined;
  const driverName = entry.driverName as Record<string, unknown> | undefined;
  const carrierName = entry.carrierName as Record<string, unknown> | undefined;
  const truckUnit = entry.truckUnit as Record<string, unknown> | undefined;
  const notes = entry.notes as Record<string, unknown> | undefined;

  return {
    entryDate: wrap(toStringOrNull(entryDate?.value), normalizeConfidence(entryDate?.confidence)),
    vendorName: wrap(toStringOrNull(vendorName?.value), normalizeConfidence(vendorName?.confidence)),
    gallons: wrap(toNumberOrNull(gallons?.value), normalizeConfidence(gallons?.confidence)),
    pricePerGallon: wrap(toNumberOrNull(pricePerGallon?.value), normalizeConfidence(pricePerGallon?.confidence)),
    fuelType: wrap(toStringOrNull(fuelType?.value), normalizeConfidence(fuelType?.confidence)),
    totalCost: wrap(toNumberOrNull(totalCost?.value), normalizeConfidence(totalCost?.confidence)),
    odometerReading: wrap(toNumberOrNull(odometerReading?.value), normalizeConfidence(odometerReading?.confidence)),
    city: wrap(toStringOrNull(city?.value), normalizeConfidence(city?.confidence)),
    state: wrap(toStringOrNull(state?.value), normalizeConfidence(state?.confidence)),
    fuelCardNumber: wrap(toStringOrNull(fuelCardNumber?.value), normalizeConfidence(fuelCardNumber?.confidence)),
    receiptNumber: wrap(toStringOrNull(receiptNumber?.value), normalizeConfidence(receiptNumber?.confidence)),
    paymentMethod: wrap(normalizePaymentMethod(paymentMethod?.value), normalizeConfidence(paymentMethod?.confidence)),
    driverName: wrap(toStringOrNull(driverName?.value), normalizeConfidence(driverName?.confidence)),
    carrierName: wrap(toStringOrNull(carrierName?.value), normalizeConfidence(carrierName?.confidence)),
    truckUnit: wrap(toStringOrNull(truckUnit?.value), normalizeConfidence(truckUnit?.confidence)),
    notes: wrap(toStringOrNull(notes?.value), normalizeConfidence(notes?.confidence)),
  };
}

export const extractFuelEntriesFromReceipts = action({
  args: {
    pages: v.array(
      v.object({
        imageUrl: v.string(),
        pageText: v.optional(v.string()),
      }),
    ),
    vendorNames: v.array(v.string()),
  },
  returns: v.object({
    entries: v.array(extractedFuelEntryValidator),
    error: v.optional(v.string()),
  }),
  handler: async (_ctx, args) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { entries: [], error: 'OPENAI_API_KEY environment variable is not set' };
    }

    const openai = new OpenAI({ apiKey });
    const prompt = buildPrompt(args.vendorNames);
    const pageChunks = chunkArray(args.pages, 1);

    try {
      const chunkResults = await Promise.all(
        pageChunks.map((chunk, index) =>
          extractChunkWithAudit(
            openai,
            prompt,
            chunk,
            pageChunks.length === 1 ? 'these documents' : `page ${index + 1}`,
          ),
        ),
      );

      const errors = chunkResults.map((result) => result.error).filter((error): error is string => !!error);
      const deduped = new Map<string, ExtractedFuelEntry>();

      for (const result of chunkResults) {
        for (const entry of result.entries) {
          const key = buildEntryKey(entry);
          if (!deduped.has(key)) {
            deduped.set(key, entry);
          }
        }
      }

      const entries = Array.from(deduped.values());

      if (entries.length === 0) {
        return {
          entries: [],
          error: errors[0] || 'No diesel transactions were detected. Try a clearer file or use CSV import instead.',
        };
      }

      return {
        entries,
        ...(errors.length > 0
          ? {
              error: `Extracted ${entries.length} transaction(s), but some page passes had issues: ${errors.join('; ')}`,
            }
          : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown extraction error';
      return { entries: [], error: message };
    }
  },
});
