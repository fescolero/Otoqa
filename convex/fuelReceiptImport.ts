'use node';
import { v } from 'convex/values';
import { action, internalAction } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';

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
  sourcePage: v.optional(extractedFieldValidator),
  sourceTableIndex: v.optional(extractedFieldValidator),
  sourceRowIndex: v.optional(extractedFieldValidator),
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
  sourcePage?: ExtractedField<number | null>;
  sourceTableIndex?: ExtractedField<number | null>;
  sourceRowIndex?: ExtractedField<number | null>;
};

type MarkdownTable = {
  headers: string[];
  rows: string[][];
};

type ChunkedMarkdownTable = {
  headers: string[];
  rows: string[][];
  rowOffset: number;
};

type FuelReasonerTask = {
  pageNumber: number;
  tableIndex: number;
  rowOffset: number;
  headers: string[];
  rows: string[][];
  contextLabel: string;
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
22. Include sourcePage, sourceTableIndex, and sourceRowIndex whenever a row comes from a parsed markdown table.

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
- sourcePage: page number of the OCR source row when available
- sourceTableIndex: 1-based table index on that page when available
- sourceRowIndex: 1-based row index within that source table when available

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

function parseMarkdownTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let i = 0;

  while (i < lines.length) {
    const headerLine = lines[i]?.trim() ?? '';
    const separatorLine = lines[i + 1]?.trim() ?? '';
    const isHeader = headerLine.startsWith('|') && headerLine.endsWith('|');
    const isSeparator = /^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(separatorLine);

    if (!isHeader || !isSeparator) {
      i += 1;
      continue;
    }

    const headers = headerLine
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);

    const rows: string[][] = [];
    i += 2;

    while (i < lines.length) {
      const rowLine = lines[i]?.trim() ?? '';
      if (!rowLine.startsWith('|') || !rowLine.endsWith('|')) break;

      const split = rowLine.split('|').map((cell) => cell.trim());
      const row = split.slice(1, split.length - 1);
      if (row.length > 0) rows.push(row);
      i += 1;
    }

    if (headers.length > 0 && rows.length > 0) {
      tables.push({ headers, rows });
    }
  }

  return tables;
}

function chunkMarkdownTable(table: MarkdownTable, chunkSize = 10): ChunkedMarkdownTable[] {
  const chunks: ChunkedMarkdownTable[] = [];

  for (let i = 0; i < table.rows.length; i += chunkSize) {
    chunks.push({
      headers: table.headers,
      rows: table.rows.slice(i, i + chunkSize),
      rowOffset: i,
    });
  }

  return chunks;
}

function buildReasonerTasks(pageMarkdowns: string[]): FuelReasonerTask[] {
  const tasks: FuelReasonerTask[] = [];

  for (let pageIndex = 0; pageIndex < pageMarkdowns.length; pageIndex++) {
    const pageMarkdown = pageMarkdowns[pageIndex];
    if (!pageMarkdown.trim()) continue;

    const tables = parseMarkdownTables(pageMarkdown);
    if (tables.length === 0) {
      tasks.push({
        pageNumber: pageIndex + 1,
        tableIndex: 0,
        rowOffset: 0,
        headers: [],
        rows: [],
        contextLabel: `page ${pageIndex + 1}`,
      });
      continue;
    }

    for (let tableIndex = 0; tableIndex < tables.length; tableIndex++) {
      const table = tables[tableIndex];
      const chunks = chunkMarkdownTable(table, 10);
      for (const chunk of chunks) {
        tasks.push({
          pageNumber: pageIndex + 1,
          tableIndex: tableIndex + 1,
          rowOffset: chunk.rowOffset,
          headers: chunk.headers,
          rows: chunk.rows,
          contextLabel: `page ${pageIndex + 1} table ${tableIndex + 1} rows ${chunk.rowOffset + 1}-${chunk.rowOffset + chunk.rows.length}`,
        });
      }
    }
  }

  return tasks;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractMarkdownPages(
  pages: Array<{ imageUrl: string; pageText?: string }>,
): Promise<{ markdownPages: string[]; error?: string }> {
  const modalUrl = process.env.MODAL_OCR_URL;
  if (!modalUrl) {
    return { markdownPages: [], error: 'MODAL_OCR_URL environment variable is not set' };
  }

  const base64Images = pages.map((p) => p.imageUrl.split(',')[1] || p.imageUrl);

  try {
    const modalResponse = await fetch(modalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        images_base64: base64Images,
        prompt:
          'Extract all text and tables from this document exactly as it appears. Preserve all line items, columns, headers, and rows perfectly. Output in Markdown format.',
      }),
    });

    if (!modalResponse.ok) {
      throw new Error(`Modal API returned ${modalResponse.status}: ${await modalResponse.text()}`);
    }

    const modalData = await modalResponse.json();
    if (modalData.error) {
      throw new Error(`Modal OCR Error: ${modalData.error}`);
    }
    return { markdownPages: modalData.texts || [] };
  } catch (error) {
    return {
      markdownPages: [],
      error: `Failed to extract text via Modal GLM-OCR: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function reasonOverMarkdown(
  apiKey: string,
  prompt: string,
  fullMarkdown: string,
  contextLabel = 'unknown',
): Promise<{ entries: ExtractedFuelEntry[]; error?: string }> {
  try {
    let response: Response | null = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[FuelOCR][Reasoner] ${contextLabel} attempt ${attempt} starting`);
      try {
        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'X-Title': 'Otoqa Fuel OCR',
          },
          body: JSON.stringify({
            model: 'qwen/qwen3.5-397b-a17b',
            reasoning: { enabled: false },
            messages: [
              { role: 'system', content: prompt },
              {
                role: 'user',
                content: `Here is the precise Markdown extracted from the fuel invoices/statements:\n\n${fullMarkdown}\n\nExtract all diesel fuel purchase transactions. Return one entry per visible transaction line item. Respect column semantics exactly: QUANTITY means gallons, PRICE means pricePerGallon, and AMT EXCP CODE means totalCost. Return ONLY valid JSON with this exact shape: {"entries":[...]} and no markdown fences.`,
              },
            ],
            response_format: { type: 'json_object' },
            max_tokens: 2500,
            temperature: 0,
          }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[FuelOCR][Reasoner] ${contextLabel} attempt ${attempt} fetch exception: ${message}`);
        if (attempt === 3) {
          return { entries: [], error: `Together fetch failed after ${attempt} attempts: ${message}` };
        }
        await sleep(attempt * 1500);
        continue;
      }

      console.log(`[FuelOCR][Reasoner] ${contextLabel} attempt ${attempt} status ${response.status}`);

      if (response.ok || ![429, 503, 504].includes(response.status) || attempt === 3) {
        break;
      }

      await sleep(attempt * 1500);
    }

    if (!response) {
      return { entries: [], error: 'OpenRouter API request did not produce a response' };
    }

    if (!response.ok) {
      const responseText = await response.text();
      console.error(
        `[FuelOCR][Reasoner] ${contextLabel} non-200 response ${response.status}: ${responseText.slice(0, 1000)}`,
      );
      return {
        entries: [],
        error: `OpenRouter API error ${response.status}: ${responseText}`,
      };
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
      error?: { message?: string };
    };

    if (payload.error?.message) {
      console.error(`[FuelOCR][Reasoner] ${contextLabel} payload error: ${payload.error.message}`);
      return { entries: [], error: `OpenRouter API error: ${payload.error.message}` };
    }

    const rawContent = payload.choices?.[0]?.message?.content as unknown;
    let content: string | null = null;
    if (typeof rawContent === 'string') {
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      const parts: unknown[] = rawContent;
      content = parts
        .map((part: unknown) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && 'text' in part) {
            return String((part as { text?: unknown }).text ?? '');
          }
          return '';
        })
        .join('');
    }
    if (!content) {
      console.error(
        `[FuelOCR][Reasoner] ${contextLabel} empty content. finish_reason=${payload.choices?.[0]?.finish_reason ?? 'unknown'}`,
      );
      return {
        entries: [],
        error: `No response content from Reasoner API. Finish reason: ${payload.choices?.[0]?.finish_reason ?? 'unknown'}`,
      };
    }

    const cleaned = content
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    const parsed =
      payload.choices?.[0]?.finish_reason === 'length' ? repairTruncatedJson(cleaned) : JSON.parse(cleaned);
    if (!parsed || !Array.isArray(parsed.entries)) {
      console.error(
        `[FuelOCR][Reasoner] ${contextLabel} invalid entries array. finish_reason=${payload.choices?.[0]?.finish_reason ?? 'unknown'} content_preview=${cleaned.slice(0, 500)}`,
      );
      return { entries: [], error: `Reasoner response did not contain a valid entries array` };
    }

    console.log(
      `[FuelOCR][Reasoner] ${contextLabel} success with ${parsed.entries.length} entries. finish_reason=${payload.choices?.[0]?.finish_reason ?? 'unknown'}`,
    );

    return {
      entries: parsed.entries
        .filter((entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
        .map(normalizeEntry),
    };
  } catch (error) {
    console.error(
      `[FuelOCR][Reasoner] ${contextLabel} parse failure: ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
    return {
      entries: [],
      error: `Failed to parse data via Reasoner API: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function reasonOverTable(
  apiKey: string,
  prompt: string,
  pageNumber: number,
  tableIndex: number,
  rowOffset: number,
  table: MarkdownTable,
): Promise<{ entries: ExtractedFuelEntry[]; error?: string }> {
  const tableMarkdown = [
    `| ${table.headers.join(' | ')} |`,
    `| ${table.headers.map(() => '---').join(' | ')} |`,
    ...table.rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');

  return await reasonOverMarkdown(
    apiKey,
    prompt,
    `--- PAGE ${pageNumber} TABLE ${tableIndex} ROWS ${rowOffset + 1}-${rowOffset + table.rows.length} ---\n${tableMarkdown}\n\nUse the table headers exactly as written. Preserve every non-summary transaction row from this table. Do not collapse, summarize, or skip repeated-looking rows unless they are clearly totals/subtotals. For every returned entry from this table set sourcePage=${pageNumber}, sourceTableIndex=${tableIndex}, and sourceRowIndex to the 1-based original row number from this table chunk. The first row in this chunk corresponds to original sourceRowIndex=${rowOffset + 1}.`,
    `page ${pageNumber} table ${tableIndex} rows ${rowOffset + 1}-${rowOffset + table.rows.length}`,
  );
}

export const startFuelReceiptExtractionJob = action({
  args: {
    totalPages: v.number(),
    vendorNames: v.array(v.string()),
  },
  returns: v.object({ jobId: v.id('fuelOcrJobs') }),
  handler: async (ctx, args): Promise<{ jobId: Id<'fuelOcrJobs'> }> => {
    const now = Date.now();
    const jobId: Id<'fuelOcrJobs'> = await ctx.runMutation(internal.fuelReceiptImportState.createFuelReceiptJob, {
      totalPages: args.totalPages,
      vendorNames: args.vendorNames,
      createdAt: now,
    });
    return { jobId };
  },
});

export const processFuelReceiptPage = action({
  args: {
    jobId: v.id('fuelOcrJobs'),
    pageIndex: v.number(),
    page: v.object({
      imageUrl: v.string(),
      pageText: v.optional(v.string()),
    }),
  },
  returns: v.object({ ok: v.boolean(), error: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.fuelReceiptImportState.markFuelReceiptJobProcessingPages, {
      jobId: args.jobId,
    });

    const markdownResult = await extractMarkdownPages([args.page]);
    if (markdownResult.error) {
      await ctx.runMutation(internal.fuelReceiptImportState.failFuelReceiptJob, {
        jobId: args.jobId,
        error: markdownResult.error,
      });
      return { ok: false, error: markdownResult.error };
    }

    await ctx.runMutation(internal.fuelReceiptImportState.storeFuelReceiptPageMarkdown, {
      jobId: args.jobId,
      pageIndex: args.pageIndex,
      markdown: markdownResult.markdownPages[0] ?? '',
    });

    return { ok: true };
  },
});

export const previewFuelEntriesFromTable = action({
  args: {
    vendorNames: v.array(v.string()),
    pageNumber: v.number(),
    tableIndex: v.number(),
    headers: v.array(v.string()),
    rows: v.array(v.array(v.string())),
  },
  returns: v.object({
    entries: v.array(extractedFuelEntryValidator),
    error: v.optional(v.string()),
  }),
  handler: async (_ctx, args) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return { entries: [], error: 'OPENROUTER_API_KEY environment variable is not set' };
    }

    const prompt = buildPrompt(args.vendorNames);
    const result = await reasonOverTable(apiKey, prompt, args.pageNumber, args.tableIndex, 0, {
      headers: args.headers,
      rows: args.rows,
    });

    return result;
  },
});

export const runFuelReceiptReasoner = internalAction({
  args: { jobId: v.id('fuelOcrJobs') },
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.fuelReceiptImportState.getFuelReceiptJobInternal, {
      jobId: args.jobId,
    });
    if (!job) return;

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      await ctx.runMutation(internal.fuelReceiptImportState.failFuelReceiptJob, {
        jobId: args.jobId,
        error: 'OPENROUTER_API_KEY environment variable is not set',
      });
      return;
    }

    const tasks = buildReasonerTasks(job.pageMarkdowns);
    const cursor = job.reasonerCursor ?? 0;

    if (tasks.length === 0) {
      await ctx.runMutation(internal.fuelReceiptImportState.completeFuelReceiptJob, {
        jobId: args.jobId,
        entriesJson: job.entriesJson ?? '[]',
      });
      return;
    }

    if (cursor >= tasks.length) {
      await ctx.runMutation(internal.fuelReceiptImportState.completeFuelReceiptJob, {
        jobId: args.jobId,
        entriesJson: job.entriesJson ?? '[]',
      });
      return;
    }

    const prompt = buildPrompt(job.vendorNames);
    const task = tasks[cursor];

    let result: { entries: ExtractedFuelEntry[]; error?: string };
    if (task.tableIndex > 0) {
      result = await reasonOverTable(apiKey, prompt, task.pageNumber, task.tableIndex, task.rowOffset, {
        headers: task.headers,
        rows: task.rows,
      });
    } else {
      result = await reasonOverMarkdown(
        apiKey,
        prompt,
        `--- PAGE ${task.pageNumber} ---\n${job.pageMarkdowns[task.pageNumber - 1]}`,
        task.contextLabel,
      );
    }

    if (result.error) {
      await ctx.runMutation(internal.fuelReceiptImportState.failFuelReceiptJob, {
        jobId: args.jobId,
        error: `Reasoner failed on ${task.contextLabel}: ${result.error}`,
      });
      return;
    }

    const existingEntriesRaw = job.entriesJson ? (JSON.parse(job.entriesJson) as unknown[]) : [];
    const existingEntries = existingEntriesRaw
      .filter((entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map(normalizeEntry);

    const deduped = new Map<string, ExtractedFuelEntry>();
    for (const entry of [...existingEntries, ...result.entries]) {
      const key = buildEntryKey(entry);
      if (!deduped.has(key)) {
        deduped.set(key, entry);
      }
    }

    const nextEntries = Array.from(deduped.values());
    const nextCursor = cursor + 1;

    await ctx.runMutation(internal.fuelReceiptImportState.updateFuelReceiptReasonerProgress, {
      jobId: args.jobId,
      entriesJson: JSON.stringify(nextEntries),
      reasonerCursor: nextCursor,
      reasonerTotalChunks: tasks.length,
    });

    if (nextCursor >= tasks.length) {
      await ctx.runMutation(internal.fuelReceiptImportState.completeFuelReceiptJob, {
        jobId: args.jobId,
        entriesJson: JSON.stringify(nextEntries),
      });
      return;
    }

    await ctx.scheduler.runAfter(0, internal.fuelReceiptImport.runFuelReceiptReasoner, {
      jobId: args.jobId,
    });
  },
});

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
  const sourcePage = entry.sourcePage as Record<string, unknown> | undefined;
  const sourceTableIndex = entry.sourceTableIndex as Record<string, unknown> | undefined;
  const sourceRowIndex = entry.sourceRowIndex as Record<string, unknown> | undefined;

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
    sourcePage: wrap(toNumberOrNull(sourcePage?.value), normalizeConfidence(sourcePage?.confidence)),
    sourceTableIndex: wrap(toNumberOrNull(sourceTableIndex?.value), normalizeConfidence(sourceTableIndex?.confidence)),
    sourceRowIndex: wrap(toNumberOrNull(sourceRowIndex?.value), normalizeConfidence(sourceRowIndex?.confidence)),
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
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return { entries: [], error: 'OPENROUTER_API_KEY environment variable is not set' };
    }

    // Switch to Together AI endpoint for the Reasoner pass
    const prompt = buildPrompt(args.vendorNames);

    try {
      const markdownResult = await extractMarkdownPages(args.pages);
      if (markdownResult.error) {
        return { entries: [], error: markdownResult.error };
      }

      const fullMarkdown = markdownResult.markdownPages
        .map((text: string, i: number) => `--- PAGE ${i + 1} ---\n${text}`)
        .join('\n\n');
      const result = await reasonOverMarkdown(apiKey, prompt, fullMarkdown);

      if (result.error) {
        return result;
      }

      const deduped = new Map<string, ExtractedFuelEntry>();
      for (const entry of result.entries) {
        const key = buildEntryKey(entry);
        if (!deduped.has(key)) {
          deduped.set(key, entry);
        }
      }

      const entries = Array.from(deduped.values());

      if (entries.length === 0) {
        return {
          entries: [],
          error: 'No diesel transactions were detected. Try a clearer file or use CSV import instead.',
        };
      }

      return { entries };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown extraction error';
      return { entries: [], error: message };
    }
  },
});
