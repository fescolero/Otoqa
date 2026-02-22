'use node';

import { v } from 'convex/values';
import { action } from './_generated/server';
import OpenAI from 'openai';

const extractionConfigValidator = v.object({
  includeLogistics: v.boolean(),
  includeFinancial: v.boolean(),
  extractDates: v.boolean(),
  stopDetailLevel: v.union(
    v.literal('full'),
    v.literal('partial'),
    v.literal('none'),
  ),
  includeEquipment: v.boolean(),
  includeFuelSurcharge: v.boolean(),
});

const confidenceValidator = v.union(
  v.literal('high'),
  v.literal('medium'),
  v.literal('low'),
);

const extractedFieldValidator = v.object({
  value: v.any(),
  confidence: confidenceValidator,
});

const extractedStopValidator = v.object({
  address: v.object({ value: v.union(v.string(), v.null()), confidence: confidenceValidator }),
  city: v.object({ value: v.union(v.string(), v.null()), confidence: confidenceValidator }),
  state: v.object({ value: v.union(v.string(), v.null()), confidence: confidenceValidator }),
  zip: v.object({ value: v.union(v.string(), v.null()), confidence: confidenceValidator }),
  stopOrder: v.object({ value: v.number(), confidence: confidenceValidator }),
  stopType: v.object({ value: v.union(v.string(), v.null()), confidence: confidenceValidator }),
});

const extractedLaneValidator = v.object({
  hcr: extractedFieldValidator,
  tripNumber: extractedFieldValidator,
  contractName: extractedFieldValidator,
  contractPeriodStart: v.optional(extractedFieldValidator),
  contractPeriodEnd: v.optional(extractedFieldValidator),
  rate: v.optional(extractedFieldValidator),
  rateType: v.optional(extractedFieldValidator),
  currency: v.optional(extractedFieldValidator),
  minimumRate: v.optional(extractedFieldValidator),
  minimumQuantity: v.optional(extractedFieldValidator),
  fuelSurchargeType: v.optional(extractedFieldValidator),
  fuelSurchargeValue: v.optional(extractedFieldValidator),
  stops: v.optional(v.array(extractedStopValidator)),
  miles: v.optional(extractedFieldValidator),
  loadCommodity: v.optional(extractedFieldValidator),
  equipmentClass: v.optional(extractedFieldValidator),
  equipmentSize: v.optional(extractedFieldValidator),
  stopOffRate: v.optional(extractedFieldValidator),
  includedStops: v.optional(extractedFieldValidator),
  lanePriority: v.optional(extractedFieldValidator),
  subsidiary: v.optional(extractedFieldValidator),
});

type ExtractionConfig = {
  includeLogistics: boolean;
  includeFinancial: boolean;
  extractDates: boolean;
  stopDetailLevel: 'full' | 'partial' | 'none';
  includeEquipment: boolean;
  includeFuelSurcharge: boolean;
};

function buildExtractionPrompt(config: ExtractionConfig): string {
  let prompt = `You are an expert logistics contract document OCR system. Your task is to carefully read the provided schedule document image(s) and extract structured lane/route data with high precision.

CRITICAL RULES:
1. Read the document CAREFULLY. Zoom into each cell of the table mentally before transcribing.
2. Return valid JSON matching the schema below. No markdown, no extra text.
3. For every field, include a "confidence" rating: "high" (clearly legible), "medium" (partially legible or inferred from context), or "low" (guessing or unclear).
4. If a value is not clearly visible, set value to null and confidence to "low". NEVER fabricate or guess.
5. Each row in the document's table represents one contract lane/route.

COMMON OCR PITFALLS TO WATCH FOR:
- Letter O vs digit 0 (e.g. "925L0" not "925LO") -- HCR codes usually end in digits
- Letter l vs digit 1 (e.g. "210" not "2l0") -- trip numbers are numeric
- Dollar amounts: "$2.50" not "$250" -- look for decimal points carefully
- Zip codes are always 5 digits (US) -- "07054" not "7054"
- State abbreviations are always 2 uppercase letters: "CA", "TX", "NJ"
- Dates: verify month/day order -- US documents use MM/DD/YYYY
- Numbers with commas: "1,250" is one thousand two hundred fifty miles, not two separate values

DOCUMENT STRUCTURE:
- The document is a logistics schedule/contract, typically formatted as a table
- Column headers appear at the top (or may repeat on each page)
- HCR is sometimes labeled "Contract", "Route", "HCR Code", "Contract Number", "Ctr", or "HCR"
- Trip Number is sometimes labeled "Trip", "Trip #", "Trip No", "Schedule", "Run", or "Sched"
- Look for column headers first, then extract values row by row

OUTPUT SCHEMA:
{
  "lanes": [
    {
      "hcr": { "value": string | null, "confidence": "high" | "medium" | "low" },
      "tripNumber": { "value": string | null, "confidence": "high" | "medium" | "low" },
      "contractName": { "value": string | null, "confidence": "high" | "medium" | "low" },`;

  if (config.extractDates) {
    prompt += `
      "contractPeriodStart": { "value": "YYYY-MM-DD" | null, "confidence": "high" | "medium" | "low" },
      "contractPeriodEnd": { "value": "YYYY-MM-DD" | null, "confidence": "high" | "medium" | "low" },`;
  }

  if (config.includeFinancial) {
    prompt += `
      "rate": { "value": number | null, "confidence": "high" | "medium" | "low" },
      "rateType": { "value": "Per Mile" | "Flat Rate" | "Per Stop" | null, "confidence": "high" | "medium" | "low" },
      "currency": { "value": "USD" | "CAD" | "MXN" | null, "confidence": "high" | "medium" | "low" },
      "minimumRate": { "value": number | null, "confidence": "high" | "medium" | "low" },
      "minimumQuantity": { "value": number | null, "confidence": "high" | "medium" | "low" },
      "stopOffRate": { "value": number | null, "confidence": "high" | "medium" | "low" },
      "includedStops": { "value": number | null, "confidence": "high" | "medium" | "low" },`;
  }

  if (config.includeFuelSurcharge) {
    prompt += `
      "fuelSurchargeType": { "value": "PERCENTAGE" | "FLAT" | "DOE_INDEX" | null, "confidence": "high" | "medium" | "low" },
      "fuelSurchargeValue": { "value": number | null, "confidence": "high" | "medium" | "low" },`;
  }

  if (config.stopDetailLevel !== 'none') {
    prompt += `
      "stops": [
        {
          "address": { "value": string | null, "confidence": "high" | "medium" | "low" },
          "city": { "value": string | null, "confidence": "high" | "medium" | "low" },
          "state": { "value": string | null, "confidence": "high" | "medium" | "low" },
          "zip": { "value": string | null, "confidence": "high" | "medium" | "low" },
          "stopOrder": { "value": number, "confidence": "high" },
          "stopType": { "value": "Pickup" | "Delivery", "confidence": "high" | "medium" | "low" }
        }
      ],
      "miles": { "value": number | null, "confidence": "high" | "medium" | "low" },
      "loadCommodity": { "value": string | null, "confidence": "high" | "medium" | "low" },`;
  }

  if (config.includeEquipment) {
    prompt += `
      "equipmentClass": { "value": "Bobtail" | "Dry Van" | "Refrigerated" | "Flatbed" | "Tanker" | null, "confidence": "high" | "medium" | "low" },
      "equipmentSize": { "value": "53ft" | "48ft" | "45ft" | null, "confidence": "high" | "medium" | "low" },`;
  }

  prompt += `
    }
  ]
}`;

  prompt += `

FIELD-SPECIFIC GUIDANCE:`;

  if (config.extractDates) {
    prompt += `
- DATES: Look for "Effective Date", "Start Date", "Begin", "Period Start", "Valid From", or similar headers.
  Expiration: "End Date", "Expiration", "Period End", "Valid Through", "Valid To".
  Convert ALL date formats to YYYY-MM-DD. Example: "01/15/2026" becomes "2026-01-15".
  If a single date range appears as a document header (not per-row), apply it to every lane.`;
  }

  if (config.includeFinancial) {
    prompt += `
- RATES: Look for "Rate", "Price", "Cost", "Compensation", "Pay", or a dollar column.
  Read decimal values carefully: "$2.50" vs "$250" -- context matters (per-mile rates are typically $1-$10).
  Rate type: "/mi" or "per mile" = "Per Mile". Lump sum or "flat" = "Flat Rate". "/stop" = "Per Stop".
  If no currency symbol or label is visible, set currency to null.`;
  }

  if (config.includeFuelSurcharge) {
    prompt += `
- FSC: Look for "FSC", "Fuel", "Fuel Surcharge", "F/S".
  Percentage (e.g. "22%") = type "PERCENTAGE", value 22.
  Flat dollar amount = type "FLAT". DOE index reference = type "DOE_INDEX".`;
  }

  if (config.stopDetailLevel === 'full') {
    prompt += `
- STOPS: Origin/destination pairs or sequential locations.
  First stop is typically Pickup, last is Delivery. Intermediate stops could be either.
  Extract all visible address components. Verify zip codes are 5 digits.
  State codes must be standard 2-letter US state abbreviations.
- MILES: Look for "Miles", "Distance", "Mi", or numeric values in a distance column.
  Verify: typical US lane distances range from 50 to 3,000 miles.`;
  } else if (config.stopDetailLevel === 'partial') {
    prompt += `
- STOPS: This document likely only has city/state, not full addresses. Set address and zip to null.
  First stop is typically Pickup, last is Delivery.
  State codes must be standard 2-letter US state abbreviations.
- MILES: Look for "Miles", "Distance", "Mi". Typical range: 50 to 3,000 miles.`;
  }

  if (config.includeEquipment) {
    prompt += `
- EQUIPMENT: "DV" = "Dry Van", "RF"/"Reefer" = "Refrigerated", "FB" = "Flatbed", "BT" = "Bobtail".
  Size: "53'" or "53ft" = "53ft", "48'" = "48ft", "45'" = "45ft".`;
  }

  prompt += `

FINAL CHECK: Before returning, verify:
- All HCR values look like route codes (alphanumeric, e.g. "925L0", "917DK")
- All trip numbers are strings (they may contain "*" for wildcards)
- No rows were skipped or duplicated
- Numbers are reasonable for their field type (rates, miles, etc.)`;

  return prompt;
}

export const extractLanesFromSchedule = action({
  args: {
    imageUrls: v.array(v.string()),
    config: extractionConfigValidator,
  },
  returns: v.object({
    lanes: v.array(v.any()),
    error: v.optional(v.string()),
  }),
  handler: async (_ctx, args) => {
    const totalChars = args.imageUrls.reduce((sum, u) => sum + u.length, 0);
    console.log(`[extractLanes] ${args.imageUrls.length} images, ~${Math.round(totalChars / 1024)}KB total`);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { lanes: [], error: 'OPENAI_API_KEY environment variable is not set' };
    }

    const openai = new OpenAI({ apiKey });
    const systemPrompt = buildExtractionPrompt(args.config);

    const imageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
      args.imageUrls.map((url) => ({
        type: 'image_url' as const,
        image_url: { url, detail: 'auto' as const },
      }));

    try {
      console.log('[extractLanes] Calling OpenAI...');
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              ...imageContent,
              {
                type: 'text',
                text: 'Extract all contract lanes from the document image(s) above.',
              },
            ],
          },
        ],
        max_tokens: 16000,
        temperature: 0,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return { lanes: [], error: 'No response content from OpenAI' };
      }

      console.log(`[extractLanes] OpenAI responded, ${content.length} chars`);
      const parsed = JSON.parse(content);
      const lanes = parsed.lanes || [];

      for (const lane of lanes) {
        if (!lane.contractName || lane.contractName.value === null) {
          const hcr = lane.hcr?.value || 'Unknown';
          const trip = lane.tripNumber?.value || 'Unknown';
          lane.contractName = {
            value: `Lane: ${hcr}/${trip}`,
            confidence: 'high',
          };
        }
      }

      console.log(`[extractLanes] Extracted ${lanes.length} lanes`);
      return { lanes };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error during extraction';
      console.error(`[extractLanes] Error: ${message}`);
      return { lanes: [], error: message };
    }
  },
});

export const verifyAndEnrichStops = action({
  args: {
    lanes: v.array(v.any()),
  },
  returns: v.object({
    lanes: v.array(v.any()),
    error: v.optional(v.string()),
  }),
  handler: async (_ctx, args) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return { lanes: args.lanes, error: 'GOOGLE_MAPS_API_KEY not configured' };
    }

    const geocodeCache = new Map<
      string,
      {
        latitude: number;
        longitude: number;
        formattedAddress: string;
        city: string;
        state: string;
        zip: string;
      } | null
    >();

    async function geocode(addressStr: string) {
      if (geocodeCache.has(addressStr)) {
        return geocodeCache.get(addressStr)!;
      }

      try {
        const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
        url.searchParams.append('address', addressStr);
        url.searchParams.append('key', apiKey!);

        const response = await fetch(url.toString());
        if (!response.ok) {
          geocodeCache.set(addressStr, null);
          return null;
        }

        const data = await response.json();
        if (data.status !== 'OK' || !data.results?.length) {
          geocodeCache.set(addressStr, null);
          return null;
        }

        const result = data.results[0];
        const location = result.geometry.location;
        const components = result.address_components || [];

        let city = '';
        let state = '';
        let zip = '';
        for (const comp of components) {
          if (comp.types.includes('locality')) city = comp.long_name;
          if (comp.types.includes('administrative_area_level_1'))
            state = comp.short_name;
          if (comp.types.includes('postal_code')) zip = comp.long_name;
        }

        const geocoded = {
          latitude: location.lat,
          longitude: location.lng,
          formattedAddress: result.formatted_address,
          city,
          state,
          zip,
        };
        geocodeCache.set(addressStr, geocoded);
        return geocoded;
      } catch {
        geocodeCache.set(addressStr, null);
        return null;
      }
    }

    async function calculateDistance(
      stops: Array<{ latitude: number; longitude: number }>,
    ) {
      if (stops.length < 2) return null;

      let totalMeters = 0;
      for (let i = 0; i < stops.length - 1; i++) {
        const origin = stops[i];
        const dest = stops[i + 1];
        try {
          const url = new URL(
            'https://maps.googleapis.com/maps/api/distancematrix/json',
          );
          url.searchParams.append(
            'origins',
            `${origin.latitude},${origin.longitude}`,
          );
          url.searchParams.append(
            'destinations',
            `${dest.latitude},${dest.longitude}`,
          );
          url.searchParams.append('key', apiKey!);
          url.searchParams.append('units', 'imperial');

          const response = await fetch(url.toString());
          if (!response.ok) continue;

          const data = await response.json();
          const element = data.rows?.[0]?.elements?.[0];
          if (element?.status === 'OK') {
            totalMeters += element.distance.value;
          }
        } catch {
          continue;
        }
      }

      return totalMeters > 0
        ? Math.round(totalMeters * 0.000621371 * 100) / 100
        : null;
    }

    const enrichedLanes = [];
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 200;

    for (let i = 0; i < args.lanes.length; i++) {
      const lane = { ...args.lanes[i] };
      const stops = lane.stops || [];

      if (i > 0 && i % BATCH_SIZE === 0) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }

      const geocodedCoords: Array<{ latitude: number; longitude: number }> = [];

      for (const stop of stops) {
        const parts = [
          stop.address?.value,
          stop.city?.value,
          stop.state?.value,
          stop.zip?.value,
        ].filter(Boolean);

        if (parts.length === 0) {
          stop._verification = { status: 'not_found', suggestedCorrection: null };
          continue;
        }

        const addressStr = parts.join(', ');
        const geocoded = await geocode(addressStr);

        if (!geocoded) {
          stop._verification = { status: 'not_found', suggestedCorrection: null };
          continue;
        }

        geocodedCoords.push({
          latitude: geocoded.latitude,
          longitude: geocoded.longitude,
        });

        const cityMatch =
          !stop.city?.value ||
          geocoded.city.toLowerCase() === stop.city.value.toLowerCase();
        const stateMatch =
          !stop.state?.value ||
          geocoded.state.toLowerCase() === stop.state.value.toLowerCase();
        const zipMatch =
          !stop.zip?.value ||
          geocoded.zip === stop.zip.value;

        if (cityMatch && stateMatch && zipMatch) {
          stop._verification = { status: 'verified', suggestedCorrection: null };
        } else {
          stop._verification = {
            status: 'mismatch',
            suggestedCorrection: {
              address: geocoded.formattedAddress,
              city: geocoded.city,
              state: geocoded.state,
              zip: geocoded.zip,
            },
          };
        }
      }

      if (geocodedCoords.length >= 2) {
        const calculatedMiles = await calculateDistance(geocodedCoords);
        lane._calculatedMiles = calculatedMiles;
      }

      lane.stops = stops;
      enrichedLanes.push(lane);
    }

    return { lanes: enrichedLanes };
  },
});

export const applyChatCorrection = action({
  args: {
    lanes: v.array(v.any()),
    userMessage: v.string(),
    conversationHistory: v.array(
      v.object({
        role: v.union(v.literal('user'), v.literal('assistant')),
        content: v.string(),
      }),
    ),
    activeColumns: v.array(v.string()),
  },
  returns: v.object({
    lanes: v.array(v.any()),
    explanation: v.string(),
    changedCells: v.array(
      v.object({
        rowIndex: v.number(),
        field: v.string(),
      }),
    ),
    error: v.optional(v.string()),
  }),
  handler: async (_ctx, args) => {
    const inputSize = JSON.stringify(args.lanes).length;
    console.log(`[applyChatCorrection] ${args.lanes.length} lanes, ${inputSize} chars, message: "${args.userMessage}"`);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        lanes: args.lanes,
        explanation: '',
        changedCells: [],
        error: 'OPENAI_API_KEY environment variable is not set',
      };
    }

    const openai = new OpenAI({ apiKey });

    const MAX_ROWS_IN_CONTEXT = 50;
    let lanesForContext = args.lanes;
    let truncated = false;

    if (args.lanes.length > MAX_ROWS_IN_CONTEXT) {
      lanesForContext = args.lanes.slice(0, MAX_ROWS_IN_CONTEXT);
      truncated = true;
    }

    const systemPrompt = `You are a data correction assistant for a logistics contract lane import tool.

The user has a table of extracted contract lanes with these active columns: ${args.activeColumns.join(', ')}.

The current table data is provided as a JSON array of compact objects. Each object has plain field values (not wrapped in confidence objects).

Your job is to interpret the user's correction and return the updated lanes array.

RULES:
- Return valid JSON: { "lanes": [...], "explanation": "brief description of what changed", "changedCells": [{"rowIndex": N, "field": "fieldName"}, ...] }
- Each lane is a plain object like {"hcr": "925L0", "tripNumber": "210", "rate": 2.50, ...}. Return the same format.
- Only modify fields the user asks to change. Keep everything else exactly as-is.
- If the user refers to rows by number, use 0-based indexing matching the array order.
- If the user refers to a specific HCR or trip number, find the matching row(s).
- For bulk changes ("change all X to Y"), apply to every matching row.
- If the correction is ambiguous, explain what you understood and what you changed.
- Keep your response concise. Do NOT add commentary inside the JSON.
${truncated ? `\nNOTE: Only the first ${MAX_ROWS_IN_CONTEXT} of ${args.lanes.length} total rows are shown. If the user's correction should apply to all rows, indicate this in your explanation and apply it to the rows shown. The client will apply the pattern to remaining rows.` : ''}`;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...args.conversationHistory.map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
      {
        role: 'user',
        content: `Current table data (${lanesForContext.length} rows):\n${JSON.stringify(lanesForContext)}\n\nUser correction: ${args.userMessage}`,
      },
    ];

    try {
      console.log(`[applyChatCorrection] Calling OpenAI with ${messages.length} messages...`);
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages,
        max_tokens: 16000,
        temperature: 0,
      });

      const content = response.choices[0]?.message?.content;
      console.log(`[applyChatCorrection] OpenAI responded, ${content?.length || 0} chars`);

      if (!content) {
        return {
          lanes: args.lanes,
          explanation: 'No response from AI',
          changedCells: [],
          error: 'No response content',
        };
      }

      const parsed = JSON.parse(content);
      let updatedLanes = parsed.lanes || lanesForContext;

      if (truncated && args.lanes.length > MAX_ROWS_IN_CONTEXT) {
        updatedLanes = [
          ...updatedLanes,
          ...args.lanes.slice(MAX_ROWS_IN_CONTEXT),
        ];
      }

      console.log(`[applyChatCorrection] Success: ${parsed.changedCells?.length || 0} cells changed`);
      return {
        lanes: updatedLanes,
        explanation: parsed.explanation || 'Changes applied.',
        changedCells: parsed.changedCells || [],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      console.error(`[applyChatCorrection] Error: ${message}`);
      return {
        lanes: args.lanes,
        explanation: '',
        changedCells: [],
        error: message,
      };
    }
  },
});
