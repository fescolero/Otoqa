'use node';

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

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildRowOcrPrompt() {
  return [
    'Extract this fuel statement page as visible text rows in reading order.',
    'Do not reconstruct a markdown table.',
    'Do not infer columns.',
    'Preserve each visible transaction row as its own line.',
    'Keep headers and section labels when helpful, but preserve row text exactly as seen.',
    'Stop at totals/subtotals and do not continue or repeat the last row.',
  ].join(' ');
}

function parsePageContext(markdown: string, vendorNames: string[]) {
  let invoiceNumber: string | null = null;
  let vendorName: string | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const invoiceMatch = line.match(/Invoice No:\s*(\S+)/i);
    if (invoiceMatch) invoiceNumber = invoiceMatch[1];

    if (!vendorName) {
      const exactVendor = vendorNames.find((vendor) => vendor.toLowerCase() === line.toLowerCase());
      if (exactVendor) vendorName = exactVendor;
      else if (line.toUpperCase() === 'SC FUELS') vendorName = 'SC FUELS';
    }
  }

  return { invoiceNumber, vendorName };
}

function splitVehicleSections(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const sections: Array<{ label: string; lines: string[] }> = [];
  let current: string[] = [];
  let currentLabel: string | null = null;
  let headerLine: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.toUpperCase().includes('DATE TIME DRIVER')) {
      headerLine = rawLine;
      continue;
    }

    if (/^Total for Vehicle\s+/i.test(line)) {
      if (current.length > 0 && headerLine) {
        current.push(rawLine);
        sections.push({ label: currentLabel ?? `section-${sections.length + 1}`, lines: [headerLine, ...current] });
      }
      current = [];
      currentLabel = null;
      continue;
    }

    if (/^\d{3,6}$/.test(line)) {
      if (current.length > 0 && headerLine) {
        sections.push({ label: currentLabel ?? `section-${sections.length + 1}`, lines: [headerLine, ...current] });
        current = [];
      }
      currentLabel = line;
      continue;
    }

    if (currentLabel && headerLine) {
      current.push(rawLine);
    }
  }

  if (current.length > 0 && headerLine) {
    sections.push({ label: currentLabel ?? `section-${sections.length + 1}`, lines: [headerLine, ...current] });
  }

  return sections;
}

function isTransactionLine(line: string) {
  return /^\d{2}\/\d{2}\/\d{2}\s+\d{1,2}:\d{2}[AP]/.test(line.trim());
}

function parseFuelRow(
  row: string,
  context: { vendorName: string | null; invoiceNumber: string | null },
): ExtractedFuelEntry | null {
  const tokens = row.trim().split(/\s+/);
  if (tokens.length < 8) return null;

  const entryDate = tokens[0];
  const timeValue = tokens[1];

  const productIndex = tokens.findIndex((token) =>
    ['DSL', 'DEF', 'ULSD', 'AGO', 'GSL', 'REG', 'UNL', 'PREM', 'MID'].includes(token),
  );
  if (productIndex === -1) return null;

  const preProduct = tokens.slice(2, productIndex);
  const postProduct = tokens.slice(productIndex + 1).filter((token) => token !== '-');
  const fuelType = tokens[productIndex];
  if (preProduct.length < 3 || postProduct.length < 2) return null;

  const odometerToken = preProduct.at(-2) ?? null;
  const siteToken = preProduct.at(-1) ?? null;
  const left = preProduct.slice(0, -2);

  let misc: string | null = null;
  let driverTokens = left;
  const cardIndex = left.findIndex((token) => token === 'CARD');
  if (cardIndex >= 0) {
    driverTokens = left.slice(0, cardIndex);
    misc = left.slice(cardIndex).join(' ');
  } else if (left.length > 0 && /\d/.test(left[left.length - 1])) {
    misc = left[left.length - 1];
    driverTokens = left.slice(0, -1);
  }

  const driverName = driverTokens.join(' ').trim() || null;
  const numericTokens = postProduct.filter((token) => /^-?\d+(?:\.\d+)?$/.test(token));
  if (numericTokens.length < 2) return null;

  const pricePerGallon = Number(numericTokens[0]);
  const totalCost = Number(numericTokens[numericTokens.length - 1]);

  // Statement rows vary, but when the source follows the documented header,
  // QUANTITY is usually the token right before FET/SET/MEF blocks. In practice,
  // this is often the 3rd numeric token if present, otherwise fall back to the
  // numeric token right before the final total.
  const gallonsCandidate = numericTokens.length >= 3 ? numericTokens[2] : numericTokens[numericTokens.length - 2];
  const gallons = gallonsCandidate ? Number(gallonsCandidate) : null;

  return {
    entryDate: wrap(entryDate),
    vendorName: wrap(context.vendorName, context.vendorName ? 'medium' : 'low'),
    gallons: wrap(gallons),
    pricePerGallon: wrap(pricePerGallon),
    fuelType: wrap(fuelType),
    totalCost: wrap(totalCost),
    odometerReading: wrap(odometerToken ? toNumberOrNull(odometerToken) : null, 'medium'),
    city: wrap(null, 'low'),
    state: wrap(null, 'low'),
    fuelCardNumber: wrap(misc, misc ? 'medium' : 'low'),
    receiptNumber: wrap(context.invoiceNumber, context.invoiceNumber ? 'medium' : 'low'),
    paymentMethod: wrap(misc && misc.includes('CARD') ? 'FUEL_CARD' : null, misc ? 'medium' : 'low'),
    driverName: wrap(driverName, driverName ? 'high' : 'low'),
    carrierName: wrap(null, 'low'),
    truckUnit: wrap(null, 'low'),
    notes: wrap(`Time: ${timeValue}${siteToken ? `; Site: ${siteToken}` : ''}`, 'medium'),
  };
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

async function extractRowsViaModal(pages: Array<{ imageUrl: string; pageText?: string }>) {
  const modalUrl = process.env.MODAL_OCR_URL;
  if (!modalUrl) {
    return { texts: [] as string[], error: 'MODAL_OCR_URL environment variable is not set' };
  }

  const results: string[] = [];
  for (const page of pages) {
    const imageBase64 = page.imageUrl.includes(',') ? page.imageUrl.split(',')[1] : page.imageUrl;
    const response = await fetch(modalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_base64: imageBase64,
        prompt: buildRowOcrPrompt(),
      }),
    });

    if (!response.ok) {
      return { texts: [], error: `Modal OCR error ${response.status}: ${await response.text()}` };
    }

    const payload = (await response.json()) as { text?: string; texts?: string[]; error?: string };
    if (payload.error) {
      return { texts: [], error: payload.error };
    }

    results.push(payload.text ?? payload.texts?.[0] ?? '');
  }

  return { texts: results };
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
    entryDate: wrap(
      typeof entryDate?.value === 'string' ? entryDate.value : null,
      (entryDate?.confidence as Confidence) ?? 'medium',
    ),
    vendorName: wrap(
      typeof vendorName?.value === 'string' ? vendorName.value : null,
      (vendorName?.confidence as Confidence) ?? 'medium',
    ),
    gallons: wrap(toNumberOrNull(gallons?.value), (gallons?.confidence as Confidence) ?? 'medium'),
    pricePerGallon: wrap(toNumberOrNull(pricePerGallon?.value), (pricePerGallon?.confidence as Confidence) ?? 'medium'),
    fuelType: wrap(
      typeof fuelType?.value === 'string' ? fuelType.value : null,
      (fuelType?.confidence as Confidence) ?? 'medium',
    ),
    totalCost: wrap(toNumberOrNull(totalCost?.value), (totalCost?.confidence as Confidence) ?? 'medium'),
    odometerReading: wrap(
      toNumberOrNull(odometerReading?.value),
      (odometerReading?.confidence as Confidence) ?? 'medium',
    ),
    city: wrap(typeof city?.value === 'string' ? city.value : null, (city?.confidence as Confidence) ?? 'medium'),
    state: wrap(typeof state?.value === 'string' ? state.value : null, (state?.confidence as Confidence) ?? 'medium'),
    fuelCardNumber: wrap(
      typeof fuelCardNumber?.value === 'string' ? fuelCardNumber.value : null,
      (fuelCardNumber?.confidence as Confidence) ?? 'medium',
    ),
    receiptNumber: wrap(
      typeof receiptNumber?.value === 'string' ? receiptNumber.value : null,
      (receiptNumber?.confidence as Confidence) ?? 'medium',
    ),
    paymentMethod: wrap(
      typeof paymentMethod?.value === 'string' ? paymentMethod.value : null,
      (paymentMethod?.confidence as Confidence) ?? 'medium',
    ),
    driverName: wrap(
      typeof driverName?.value === 'string' ? driverName.value : null,
      (driverName?.confidence as Confidence) ?? 'medium',
    ),
    carrierName: wrap(
      typeof carrierName?.value === 'string' ? carrierName.value : null,
      (carrierName?.confidence as Confidence) ?? 'medium',
    ),
    truckUnit: wrap(
      typeof truckUnit?.value === 'string' ? truckUnit.value : null,
      (truckUnit?.confidence as Confidence) ?? 'medium',
    ),
    notes: wrap(typeof notes?.value === 'string' ? notes.value : null, (notes?.confidence as Confidence) ?? 'medium'),
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
    try {
      const ocr = await extractRowsViaModal(args.pages);
      if (ocr.error) {
        return { entries: [], error: ocr.error };
      }

      const deduped = new Map<string, ExtractedFuelEntry>();

      for (const pageText of ocr.texts) {
        const context = parsePageContext(pageText, args.vendorNames);
        const sections = splitVehicleSections(pageText);

        for (const section of sections) {
          for (const rawLine of section.lines) {
            const line = rawLine.trim();
            if (!line || /^Total for Vehicle\s+/i.test(line) || !isTransactionLine(line)) {
              continue;
            }

            const parsed = parseFuelRow(line, context);
            if (!parsed) continue;

            const key = buildEntryKey(parsed);
            if (!deduped.has(key)) {
              deduped.set(key, normalizeEntry(parsed as unknown as Record<string, unknown>));
            }
          }
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
