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
  let prompt = `You are a logistics contract document parser. Extract structured lane/route data from the provided schedule document image(s).

RULES:
- Return valid JSON matching the schema below. No markdown, no commentary.
- For every field, include a "confidence" rating: "high", "medium", or "low".
- If a value is not clearly visible or you are uncertain, set the value to null and confidence to "low". NEVER fabricate or guess values.
- If a field is not present in the document at all, set it to null with confidence "low".
- Each row in the document represents one contract lane/route.
- HCR is sometimes labeled as "Contract", "Route", "HCR Code", "Contract Number", or "Ctr".
- Trip Number is sometimes labeled as "Trip", "Trip #", "Trip No", "Schedule", or "Run".

Return a JSON object with this structure:
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
}

FIELD EXTRACTION HINTS:`;

  if (config.extractDates) {
    prompt += `
- Effective/expiration dates may be labeled "Effective Date", "Start Date", "Begin", "Period Start", "Valid From" or similar.
- Expiration dates may be labeled "End Date", "Expiration", "Period End", "Valid Through", "Valid To" or similar.
- Dates may appear as a header applying to all lanes, or per-row. If a single date range applies to the whole document, use it for every lane.`;
  }

  if (config.includeFinancial) {
    prompt += `
- Rate may be labeled "Rate", "Price", "Cost", "Compensation", "Pay" or a dollar amount in a column.
- Rate type: if the rate appears alongside a "/mi" or "per mile" label, it is "Per Mile". If it is a lump sum, it is "Flat Rate". If labeled "per stop" or "/stop", it is "Per Stop".
- If no currency symbol or label is visible, set currency to null.
- Minimum rate/quantity may not be present -- set to null if not found.`;
  }

  if (config.includeFuelSurcharge) {
    prompt += `
- Fuel surcharge may be labeled "FSC", "Fuel", "Fuel Surcharge", or "F/S".
- If shown as a percentage (e.g. "22%"), type is "PERCENTAGE" and value is 22.
- If shown as a flat dollar amount, type is "FLAT".
- If referencing DOE index, type is "DOE_INDEX".`;
  }

  if (config.stopDetailLevel === 'full') {
    prompt += `
- Stops are typically listed as origin/destination pairs or as a sequence of locations.
- The first stop is usually a Pickup, the last is usually a Delivery. Intermediate stops could be either.
- Addresses may be full (street, city, state, zip) or partial. Extract whatever components are visible.
- Miles may be labeled "Miles", "Distance", "Mi", or appear as a number in a distance column.`;
  } else if (config.stopDetailLevel === 'partial') {
    prompt += `
- This document likely only contains city and state for stops, not full street addresses. Extract city and state. Set address and zip to null.
- The first stop is usually a Pickup, the last is usually a Delivery.
- Miles may be labeled "Miles", "Distance", "Mi", or appear as a number in a distance column.`;
  }

  if (config.includeEquipment) {
    prompt += `
- Equipment may be labeled "Equipment", "Trailer Type", "Type", or abbreviated as "DV" (Dry Van), "RF"/"Reefer" (Refrigerated), "FB" (Flatbed).
- Size is often "53'" or "48'" -- normalize to "53ft" or "48ft".`;
  }

  prompt += `

If the document contains multiple pages, combine all lanes from all pages into a single "lanes" array. Do not duplicate lanes that span page breaks.`;

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
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { lanes: [], error: 'OPENAI_API_KEY environment variable is not set' };
    }

    const openai = new OpenAI({ apiKey });
    const systemPrompt = buildExtractionPrompt(args.config);

    const imageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
      args.imageUrls.map((url) => ({
        type: 'image_url' as const,
        image_url: { url, detail: 'high' as const },
      }));

    try {
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

      return { lanes };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error during extraction';
      console.error('OCR extraction failed:', message);
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
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages,
        max_tokens: 16000,
        temperature: 0,
      });

      const content = response.choices[0]?.message?.content;
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

      return {
        lanes: updatedLanes,
        explanation: parsed.explanation || 'Changes applied.',
        changedCells: parsed.changedCells || [],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      return {
        lanes: args.lanes,
        explanation: '',
        changedCells: [],
        error: message,
      };
    }
  },
});
