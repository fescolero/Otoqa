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
  const includeStops = config.includeLogistics && config.stopDetailLevel !== 'none';

  const baseInstructions = `You are an expert data extraction assistant. Extract ALL transportation contract trips from the provided images into structured JSON.

CRITICAL RULES:
1. Ignore Watermarks: Completely ignore any large diagonal watermark (e.g. "LOGISTICS APPROVED").
2. Extract EVERY trip: Documents may contain many trips (20+). You MUST extract ALL of them. Do not stop early.
3. Cross-Reference lookup tables: Match Frequency Codes and Vehicle Codes from the trip schedule to their definition tables on subsequent pages.
4. Data Cleaning:
   - Times: HH:MM:SS format. Strip "PT" (e.g., "00:10:00 PT" → "00:10:00").
   - Durations: Strip "min", return integer (e.g., "10 min" → 10).
   - Dates: MM/DD/YYYY format.
5. If a field is blank or not present, output null.
6. Output ONLY valid JSON. No markdown formatting, no conversational text.`;

  const facilityInstructions = includeStops
    ? `\n7. Facilities: Cross-reference the NASS Code for each stop with the Facility Address table (usually on subsequent pages). Inject the full address, city, state, and zip into each stop.`
    : '';

  let tripSchema: string;

  if (includeStops) {
    tripSchema = `{
      "trip_id": "String",
      "vehicle_code": "String",
      "vehicle_description": "String (from Vehicle Requirements table)",
      "frequency_code": "String",
      "frequency_days": "Number",
      "frequency_description": "String (from Frequency Description table)",
      "effective_date": "String (MM/DD/YYYY)",
      "expiration_date": "String (MM/DD/YYYY)",
      "trip_miles": "Number",
      "stops": [
        {
          "stop_number": "Integer",
          "arrive_time": "String (HH:MM:SS)",
          "depart_time": "String (HH:MM:SS)",
          "load_unload_minutes": "Integer",
          "nass_code": "String",
          "facility_name": "String",
          "address": "String (from NASS table)",
          "city": "String (from NASS table)",
          "state": "String (from NASS table)",
          "zip": "String (from NASS table)"
        }
      ]
    }`;
  } else {
    tripSchema = `{
      "trip_id": "String",
      "vehicle_code": "String",
      "vehicle_description": "String (from Vehicle Requirements table)",
      "frequency_code": "String",
      "frequency_days": "Number",
      "frequency_description": "String (from Frequency Description table)",
      "effective_date": "String (MM/DD/YYYY)",
      "expiration_date": "String (MM/DD/YYYY)",
      "trip_miles": "Number"
    }`;
  }

  return `${baseInstructions}${facilityInstructions}

JSON SCHEMA:
{
  "hcr_number": "String",
  "total_trip_count": "Integer (the total number of trips you found in the document)",
  "trips": [
    ${tripSchema}
  ]
}

IMPORTANT: All pages belong to the same contract. Extract EVERY trip row — do not summarize or skip any. The "total_trip_count" must equal the length of the "trips" array.`;
}

type OcrTrip = {
  trip_id: string;
  vehicle_code?: string;
  vehicle_description?: string;
  frequency_code?: string;
  frequency_days?: number;
  frequency_description?: string;
  effective_date?: string;
  expiration_date?: string;
  trip_miles?: number;
  trip_summary?: { trip_miles?: number; trip_hrs?: number; drive_time?: number };
  stops?: Array<{
    stop_number?: number;
    arrive_time?: string;
    depart_time?: string;
    load_unload_minutes?: number;
    nass_code?: string;
    facility_name?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    facility?: {
      nass_code?: string;
      facility_name?: string;
      address?: string;
      city?: string;
      state?: string;
      zip?: string;
      phone?: string;
    };
  }>;
};

type OcrResult = {
  hcr_number?: string;
  total_trip_count?: number;
  trips?: OcrTrip[];
  contract_header?: {
    hcr_number?: string;
  };
};

function hi(val: unknown) {
  return { value: val ?? null, confidence: 'high' as const };
}

function parseDate(dateStr: string | undefined | null): string | null {
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  }
  return dateStr;
}

function convertOcrToExtractedLanes(ocr: OcrResult) {
  const hcr = ocr.hcr_number || ocr.contract_header?.hcr_number || null;
  const trips = ocr.trips || [];

  return trips.map((trip) => {
    const stops = (trip.stops || []).map((s, idx) => ({
      address: hi(s.address || s.facility?.address || null),
      city: hi(s.city || s.facility?.city || null),
      state: hi(s.state || s.facility?.state || null),
      zip: hi(s.zip || s.facility?.zip || null),
      stopOrder: hi(idx + 1),
      stopType: hi(idx === 0 ? 'Pickup' : 'Delivery'),
    }));

    const miles = trip.trip_miles ?? trip.trip_summary?.trip_miles ?? null;

    const equipDesc = (trip.vehicle_description || trip.vehicle_code || '').toUpperCase();
    let equipmentSize: string | null = null;
    if (equipDesc.includes('53')) equipmentSize = '53ft';
    else if (equipDesc.includes('48')) equipmentSize = '48ft';
    else if (equipDesc.includes('45')) equipmentSize = '45ft';

    return {
      hcr: hi(hcr),
      tripNumber: hi(trip.trip_id),
      contractName: hi(hcr ? `Lane: ${hcr}/${trip.trip_id}` : null),
      contractPeriodStart: hi(parseDate(trip.effective_date)),
      contractPeriodEnd: hi(parseDate(trip.expiration_date)),
      stops,
      miles: hi(miles),
      equipmentClass: hi(null),
      equipmentSize: hi(equipmentSize),
      _selected: true,
      _tripMeta: {
        vehicleCode: trip.vehicle_code,
        vehicleDescription: trip.vehicle_description,
        frequencyCode: trip.frequency_code,
        frequencyDays: trip.frequency_days,
        frequencyDescription: trip.frequency_description,
        driveTime: trip.trip_summary?.drive_time,
        tripHours: trip.trip_summary?.trip_hrs,
      },
    };
  });
}

function repairTruncatedJson(raw: string): OcrResult | null {
  try {
    return JSON.parse(raw);
  } catch {
    // Response was cut off mid-JSON. Try to salvage the trips array.
  }

  try {
    // Find the last complete object in the trips array
    const tripsStart = raw.indexOf('"trips"');
    if (tripsStart === -1) return null;

    const arrayStart = raw.indexOf('[', tripsStart);
    if (arrayStart === -1) return null;

    // Walk backwards from end to find the last complete "}" for a trip object
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

    // Reconstruct valid JSON by closing the array and root object
    const repaired = raw.substring(0, lastValidEnd + 1) + ']}';
    return JSON.parse(repaired);
  } catch {
    return null;
  }
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

    const allTrips: OcrTrip[] = [];
    let hcrNumber: string | null = null;
    let expectedTripCount: number | null = null;
    const MAX_CONTINUATION_ROUNDS = 4;
    const RATE_LIMIT_RETRIES = 3;

    async function callWithRetry(
      createParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
      for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
        try {
          return await openai.chat.completions.create(createParams);
        } catch (err: unknown) {
          const isRateLimit =
            err instanceof Error &&
            (err.message.includes('429') || err.message.includes('Rate limit'));
          if (!isRateLimit || attempt === RATE_LIMIT_RETRIES) throw err;
          const delayMs = Math.min(2000 * Math.pow(2, attempt), 15000);
          console.log(`[extractLanes] Rate limited, retrying in ${delayMs}ms (attempt ${attempt + 1}/${RATE_LIMIT_RETRIES})...`);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      throw new Error('Unreachable');
    }

    try {
      console.log('[extractLanes] Calling OpenAI (initial)...');
      const response = await callWithRetry({
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
                text: 'Extract ALL trips from this contract document. Cross-reference frequency codes and vehicle codes from lookup tables.',
              },
            ],
          },
        ],
        max_tokens: 16384,
        temperature: 0,
      });

      const content = response.choices[0]?.message?.content;
      const finishReason = response.choices[0]?.finish_reason;

      if (!content) {
        return { lanes: [], error: 'No response content from OpenAI' };
      }

      console.log(`[extractLanes] Response: ${content.length} chars, finish_reason=${finishReason}`);

      let parsed: OcrResult | null;
      if (finishReason === 'length') {
        console.log('[extractLanes] Response truncated, attempting JSON repair...');
        parsed = repairTruncatedJson(content);
        if (!parsed) {
          return { lanes: [], error: 'Response was truncated and could not be repaired. Try fewer pages.' };
        }
        console.log(`[extractLanes] Repaired JSON: ${parsed.trips?.length || 0} trips recovered`);
      } else {
        parsed = JSON.parse(content);
      }

      hcrNumber = parsed!.hcr_number || parsed!.contract_header?.hcr_number || null;
      expectedTripCount = parsed!.total_trip_count || null;
      const initialTrips = parsed!.trips || [];
      allTrips.push(...initialTrips);

      console.log(`[extractLanes] HCR: ${hcrNumber}, Expected: ${expectedTripCount}, Got: ${initialTrips.length} trips`);

      // Continuation: if we got truncated or expected more trips, request remaining
      if (
        expectedTripCount &&
        allTrips.length < expectedTripCount &&
        allTrips.length > 0
      ) {
        for (let round = 0; round < MAX_CONTINUATION_ROUNDS; round++) {
          const remaining = expectedTripCount - allTrips.length;
          if (remaining <= 0) break;

          // Delay between requests to avoid rate limiting
          const delayMs = 2000 + round * 1000;
          console.log(`[extractLanes] Waiting ${delayMs}ms before continuation round ${round + 1}...`);
          await new Promise((r) => setTimeout(r, delayMs));

          const extractedIds = allTrips.map((t) => t.trip_id).join(', ');
          console.log(`[extractLanes] Continuation round ${round + 1}: need ${remaining} more trips`);

          const contResponse = await callWithRetry({
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
                    text: `You already extracted these trip IDs: ${extractedIds}. There are ${remaining} more trips in the document. Extract ONLY the remaining trips that are NOT in the list above. Return them in the same JSON schema with a "trips" array.`,
                  },
                ],
              },
            ],
            max_tokens: 16384,
            temperature: 0,
          });

          const contContent = contResponse.choices[0]?.message?.content;
          const contFinish = contResponse.choices[0]?.finish_reason;

          if (!contContent) break;

          console.log(`[extractLanes] Continuation: ${contContent.length} chars, finish_reason=${contFinish}`);

          let contParsed: OcrResult | null;
          if (contFinish === 'length') {
            contParsed = repairTruncatedJson(contContent);
          } else {
            try {
              contParsed = JSON.parse(contContent);
            } catch {
              contParsed = repairTruncatedJson(contContent);
            }
          }

          if (!contParsed?.trips?.length) break;

          const existingIds = new Set(allTrips.map((t) => t.trip_id));
          const newTrips = contParsed.trips.filter((t) => !existingIds.has(t.trip_id));

          if (newTrips.length === 0) break;

          allTrips.push(...newTrips);
          console.log(`[extractLanes] +${newTrips.length} new trips, total: ${allTrips.length}`);
        }
      }

      const fullResult: OcrResult = {
        hcr_number: hcrNumber || undefined,
        trips: allTrips,
      };

      const lanes = convertOcrToExtractedLanes(fullResult);
      console.log(`[extractLanes] Final: ${lanes.length} lanes extracted`);

      const warning =
        expectedTripCount && lanes.length < expectedTripCount
          ? `Extracted ${lanes.length} of ${expectedTripCount} expected trips. Some may have been missed.`
          : undefined;

      return { lanes, error: warning };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error during extraction';
      console.error(`[extractLanes] Error: ${message}`);

      if (allTrips.length > 0) {
        console.log(`[extractLanes] Returning ${allTrips.length} trips collected before error`);
        const partial: OcrResult = { hcr_number: hcrNumber || undefined, trips: allTrips };
        return {
          lanes: convertOcrToExtractedLanes(partial),
          error: `Partial extraction (${allTrips.length} trips): ${message}`,
        };
      }

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
