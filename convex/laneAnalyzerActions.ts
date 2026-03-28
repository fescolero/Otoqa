import { v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';

// ==========================================
// LANE ANALYZER — External API Actions
// Fuel prices (EIA), toll estimates (TollGuru),
// geocoding + route distance (Google Maps)
// ==========================================

/**
 * Fetch regional diesel fuel prices from EIA API.
 * Writes results to fuelPriceCache table.
 */
export const fetchFuelPrices = action({
  args: {},
  handler: async (ctx) => {
    const apiKey = process.env.EIA_API_KEY;

    // PADD region series IDs for weekly retail diesel prices
    const series: Record<string, string> = {
      US_AVERAGE: 'EMD_EPD2D_PTE_NUS_DPG',
      PADD1: 'EMD_EPD2D_PTE_R10_DPG',
      PADD2: 'EMD_EPD2D_PTE_R20_DPG',
      PADD3: 'EMD_EPD2D_PTE_R30_DPG',
      PADD4: 'EMD_EPD2D_PTE_R40_DPG',
      PADD5: 'EMD_EPD2D_PTE_R50_DPG',
    };

    const prices: Array<{ region: string; pricePerGallon: number }> = [];

    if (!apiKey) {
      console.warn('EIA_API_KEY not configured, skipping fuel price fetch');
      return { success: false, error: 'EIA_API_KEY not configured', prices: [] };
    }

    try {
      for (const [region, seriesId] of Object.entries(series)) {
        const url = new URL('https://api.eia.gov/v2/petroleum/pri/gnd/data/');
        url.searchParams.append('api_key', apiKey);
        url.searchParams.append('frequency', 'weekly');
        url.searchParams.append('data[0]', 'value');
        url.searchParams.append('facets[series][]', seriesId);
        url.searchParams.append('sort[0][column]', 'period');
        url.searchParams.append('sort[0][direction]', 'desc');
        url.searchParams.append('length', '1');

        const response = await fetch(url.toString());
        if (!response.ok) continue;

        const data = await response.json();
        const value = data?.response?.data?.[0]?.value;

        if (value && typeof value === 'number') {
          prices.push({ region, pricePerGallon: value });
        }
      }
    } catch (error) {
      console.error('EIA API error:', error);
      return { success: false, error: String(error), prices: [] };
    }

    // Write to cache via internal mutation
    const now = Date.now();
    for (const { region, pricePerGallon } of prices) {
      await ctx.runMutation(internal.laneAnalyzerActions.writeFuelPrice, {
        region,
        pricePerGallon,
        fetchedAt: now,
      });
    }

    return { success: true, prices };
  },
});

/**
 * Fetch toll estimate for a route using TollGuru API.
 */
export const fetchTollEstimate = action({
  args: {
    originLat: v.number(),
    originLng: v.number(),
    destinationLat: v.number(),
    destinationLng: v.number(),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.TOLLGURU_API_KEY;

    if (!apiKey) {
      console.warn('TOLLGURU_API_KEY not configured, skipping toll estimate');
      return { success: false, error: 'TOLLGURU_API_KEY not configured', tollCost: 0 };
    }

    try {
      const response = await fetch('https://apis.tollguru.com/toll/v2/origin-destination-waypoints', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          from: { lat: args.originLat, lng: args.originLng },
          to: { lat: args.destinationLat, lng: args.destinationLng },
          vehicleType: '5AxlesTruck',
          departure_time: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        return { success: false, error: `TollGuru API error: ${response.status}`, tollCost: 0 };
      }

      const data = await response.json();

      // TollGuru returns routes with toll costs — use the cheapest route
      const routes = data?.routes ?? [];
      let cheapestToll = 0;
      if (routes.length > 0) {
        cheapestToll = routes.reduce(
          (min: number, route: { costs?: { tag?: number; cash?: number } }) => {
            const cost = route.costs?.tag ?? route.costs?.cash ?? 0;
            return cost < min ? cost : min;
          },
          routes[0]?.costs?.tag ?? routes[0]?.costs?.cash ?? 0,
        );
      }

      // Cache the result
      const now = Date.now();
      const originHash = `${args.originLat.toFixed(2)},${args.originLng.toFixed(2)}`;
      const destHash = `${args.destinationLat.toFixed(2)},${args.destinationLng.toFixed(2)}`;

      await ctx.runMutation(internal.laneAnalyzerActions.writeTollEstimate, {
        originHash,
        destinationHash: destHash,
        tollCost: cheapestToll,
        fetchedAt: now,
        expiresAt: now + 30 * 24 * 60 * 60 * 1000, // 30 days
      });

      return { success: true, tollCost: cheapestToll };
    } catch (error) {
      console.error('TollGuru API error:', error);
      return { success: false, error: String(error), tollCost: 0 };
    }
  },
});

/**
 * Geocode entry addresses and calculate route distance using Google Maps.
 * Updates the entry with lat/lng, miles, and duration.
 */
export const geocodeAndCalculateRoute = action({
  args: {
    entryId: v.id('laneAnalysisEntries'),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return { success: false, error: 'Google Maps API key not configured' };
    }

    // Read the entry
    const entry = await ctx.runQuery(internal.laneAnalyzerActions.getEntryInternal, {
      id: args.entryId,
    });
    if (!entry) return { success: false, error: 'Entry not found' };

    try {
      // Geocode origin if needed
      let originLat = entry.originLat;
      let originLng = entry.originLng;
      if (!originLat || !originLng) {
        const originGeo = await geocodeAddress(
          `${entry.originAddress}, ${entry.originCity}, ${entry.originState} ${entry.originZip}`,
          apiKey,
        );
        originLat = originGeo.lat;
        originLng = originGeo.lng;
      }

      // Geocode destination if needed
      let destLat = entry.destinationLat;
      let destLng = entry.destinationLng;
      if (!destLat || !destLng) {
        const destGeo = await geocodeAddress(
          `${entry.destinationAddress}, ${entry.destinationCity}, ${entry.destinationState} ${entry.destinationZip}`,
          apiKey,
        );
        destLat = destGeo.lat;
        destLng = destGeo.lng;
      }

      // Build stops array for distance calculation
      const stops: Array<{ latitude: number; longitude: number }> = [
        { latitude: originLat, longitude: originLng },
      ];

      // Geocode intermediate stops if needed
      if (entry.intermediateStops) {
        for (const stop of entry.intermediateStops) {
          let lat = stop.lat;
          let lng = stop.lng;
          if (!lat || !lng) {
            const geo = await geocodeAddress(
              `${stop.address}, ${stop.city}, ${stop.state} ${stop.zip}`,
              apiKey,
            );
            lat = geo.lat;
            lng = geo.lng;
          }
          stops.push({ latitude: lat, longitude: lng });
        }
      }

      stops.push({ latitude: destLat, longitude: destLng });

      // Calculate route distance using Google Maps
      const routeResult = await calculateRouteDistanceFromStops(stops);

      // Update entry with geocoded coordinates and route metrics
      await ctx.runMutation(internal.laneAnalyzerActions.updateEntryRoute, {
        id: args.entryId,
        originLat,
        originLng,
        destinationLat: destLat,
        destinationLng: destLng,
        routeMiles: routeResult.miles,
        routeDurationHours: routeResult.durationHours,
      });

      return {
        success: true,
        miles: routeResult.miles,
        durationHours: routeResult.durationHours,
      };
    } catch (error) {
      console.error('Geocode/route calculation error:', error);
      return { success: false, error: String(error) };
    }
  },
});

/**
 * Run complete analysis for a session with external data.
 * Fetches fuel prices, toll estimates, then runs the calculation engine.
 */
export const runAnalysisWithExternalData = action({
  args: {
    sessionId: v.id('laneAnalysisSessions'),
  },
  handler: async (ctx, args) => {
    // 1. Fetch latest fuel prices and write to cache
    await fetchAndCacheFuelPrices(ctx);

    // 2. Get all entries for this session (mutable copy for in-place coord updates)
    const entries = (await ctx.runQuery(internal.laneAnalyzerActions.listEntriesInternal, {
      sessionId: args.sessionId,
    })).map((e) => ({ ...e }));

    // 2.5. Parallel batch geocode entries missing coordinates + route distance
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (apiKey) {
      // Filter to entries that actually need work
      const needsGeo = entries.filter((e) =>
        !e.originLat || !e.originLng || !e.destinationLat || !e.destinationLng || !e.routeMiles || !e.routeDurationHours
      );

      // Process in parallel batches of 10
      const BATCH_SIZE = 10;
      for (let b = 0; b < needsGeo.length; b += BATCH_SIZE) {
        const batch = needsGeo.slice(b, b + BATCH_SIZE);
        await Promise.all(batch.map(async (entry) => {
          try {
            let oLat = entry.originLat, oLng = entry.originLng;
            let dLat = entry.destinationLat, dLng = entry.destinationLng;

            // Geocode origin + dest in parallel
            const [originGeo, destGeo] = await Promise.all([
              (!oLat || !oLng)
                ? geocodeAddress([entry.originAddress, entry.originCity, entry.originState, entry.originZip].filter(Boolean).join(', '), apiKey)
                : null,
              (!dLat || !dLng)
                ? geocodeAddress([entry.destinationAddress, entry.destinationCity, entry.destinationState, entry.destinationZip].filter(Boolean).join(', '), apiKey)
                : null,
            ]);

            if (originGeo) { oLat = originGeo.lat; oLng = originGeo.lng; }
            if (destGeo) { dLat = destGeo.lat; dLng = destGeo.lng; }

            // Route distance
            let miles = entry.routeMiles, hours = entry.routeDurationHours;
            if ((!miles || !hours) && oLat && oLng && dLat && dLng) {
              try {
                const r = await calculateRouteDistanceFromStops([
                  { latitude: oLat, longitude: oLng },
                  { latitude: dLat, longitude: dLng },
                ]);
                miles = r.miles;
                hours = r.durationHours;
              } catch { /* skip */ }
            }

            await ctx.runMutation(internal.laneAnalyzerActions.updateEntryGeocode, {
              id: entry._id,
              originLat: oLat!, originLng: oLng!,
              destinationLat: dLat!, destinationLng: dLng!,
              routeMiles: miles ?? undefined,
              routeDurationHours: hours ?? undefined,
            });

            // Update local copy for toll check below
            entry.originLat = oLat; entry.originLng = oLng;
            entry.destinationLat = dLat; entry.destinationLng = dLng;
            if (miles) entry.routeMiles = miles;
            if (hours) entry.routeDurationHours = hours;
          } catch (err) {
            console.warn(`Geocoding failed for ${entry.name}: ${err}`);
          }
        }));
      }

      // Geocode bases in parallel too
      const baseDocs = await ctx.runQuery(internal.laneAnalyzerActions.listBasesInternal, {
        sessionId: args.sessionId,
      });
      const basesNeedGeo = baseDocs.filter((b) => !b.latitude || !b.longitude);
      if (basesNeedGeo.length > 0) {
        await Promise.all(basesNeedGeo.map(async (base) => {
          try {
            const geo = await geocodeAddress(
              [base.address, base.city, base.state, base.zip].filter(Boolean).join(', '), apiKey
            );
            await ctx.runMutation(internal.laneAnalyzerActions.updateBaseGeocode, {
              id: base._id, latitude: geo.lat, longitude: geo.lng,
            });
          } catch (err) {
            console.warn(`Base geocoding failed for ${base.name}: ${err}`);
          }
        }));
      }
    }

    // 3. Fetch toll estimates (skip if no coords — tolls are optional)
    const entriesWithCoords = entries.filter(
      (e) => e.originLat && e.originLng && e.destinationLat && e.destinationLng
    );
    // Parallel toll lookups in batches of 5
    for (let b = 0; b < entriesWithCoords.length; b += 5) {
      const batch = entriesWithCoords.slice(b, b + 5);
      await Promise.all(batch.map(async (entry) => {
        const originHash = `${entry.originLat!.toFixed(2)},${entry.originLng!.toFixed(2)}`;
        const destHash = `${entry.destinationLat!.toFixed(2)},${entry.destinationLng!.toFixed(2)}`;
        const cached = await ctx.runQuery(internal.laneAnalyzerActions.getCachedToll, {
          originHash, destinationHash: destHash,
        });
        if (!cached || cached.expiresAt < Date.now()) {
          try {
            const tollCost = await fetchTollCostFromApi(
              entry.originLat!, entry.originLng!, entry.destinationLat!, entry.destinationLng!,
            );
            await ctx.runMutation(internal.laneAnalyzerActions.writeTollEstimate, {
              originHash, destinationHash: destHash, tollCost,
              fetchedAt: Date.now(), expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
            });
          } catch { /* skip toll lookup failures */ }
        }
      }));
    }

    // 4. Run the full calculation engine
    await ctx.runMutation(internal.laneAnalyzerCalculations.runFullAnalysis, {
      sessionId: args.sessionId,
    });

    // 5. Run base optimization (deadhead analysis)
    await ctx.runMutation(internal.laneAnalyzerOptimization.optimizeBases, {
      sessionId: args.sessionId,
    });

    // 6. Find lane pairing opportunities
    await ctx.runMutation(internal.laneAnalyzerOptimization.findLaneCombinations, {
      sessionId: args.sessionId,
    });

    return { success: true };
  },
});

// ---- INTERNAL HELPERS ----
// These are internal functions needed by the actions above.

import { internalMutation, internalQuery } from './_generated/server';

export const writeFuelPrice = internalMutation({
  args: {
    region: v.string(),
    pricePerGallon: v.number(),
    fetchedAt: v.number(),
  },
  handler: async (ctx, args) => {
    // Upsert: delete old entry for this region, insert new one
    const existing = await ctx.db
      .query('fuelPriceCache')
      .withIndex('by_region', (q) => q.eq('region', args.region))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        pricePerGallon: args.pricePerGallon,
        fetchedAt: args.fetchedAt,
        source: 'EIA' as const,
      });
    } else {
      await ctx.db.insert('fuelPriceCache', {
        region: args.region,
        pricePerGallon: args.pricePerGallon,
        fetchedAt: args.fetchedAt,
        source: 'EIA',
      });
    }
  },
});

export const writeTollEstimate = internalMutation({
  args: {
    originHash: v.string(),
    destinationHash: v.string(),
    tollCost: v.number(),
    fetchedAt: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('tollEstimateCache')
      .withIndex('by_route', (q) =>
        q.eq('originHash', args.originHash).eq('destinationHash', args.destinationHash),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        tollCost: args.tollCost,
        fetchedAt: args.fetchedAt,
        expiresAt: args.expiresAt,
      });
    } else {
      await ctx.db.insert('tollEstimateCache', {
        originHash: args.originHash,
        destinationHash: args.destinationHash,
        tollCost: args.tollCost,
        provider: 'TOLLGURU',
        vehicleType: 'CLASS_8_TRUCK',
        fetchedAt: args.fetchedAt,
        expiresAt: args.expiresAt,
      });
    }
  },
});

export const getEntryInternal = internalQuery({
  args: { id: v.id('laneAnalysisEntries') },
  handler: async (ctx, args) => {
    return ctx.db.get(args.id);
  },
});

export const listEntriesInternal = internalQuery({
  args: { sessionId: v.id('laneAnalysisSessions') },
  handler: async (ctx, args) => {
    return ctx.db
      .query('laneAnalysisEntries')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();
  },
});

export const updateEntryGeocode = internalMutation({
  args: {
    id: v.id('laneAnalysisEntries'),
    originLat: v.number(),
    originLng: v.number(),
    destinationLat: v.number(),
    destinationLng: v.number(),
    routeMiles: v.optional(v.number()),
    routeDurationHours: v.optional(v.number()),
    intermediateStops: v.optional(v.array(v.object({
      address: v.string(),
      city: v.string(),
      state: v.string(),
      zip: v.string(),
      lat: v.optional(v.number()),
      lng: v.optional(v.number()),
      stopOrder: v.number(),
      stopType: v.union(v.literal('Pickup'), v.literal('Delivery')),
      type: v.union(v.literal('APPT'), v.literal('FCFS'), v.literal('Live')),
      arrivalTime: v.optional(v.string()),
      arrivalEndTime: v.optional(v.string()),
    }))),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    const patch: Record<string, unknown> = {
      originLat: updates.originLat,
      originLng: updates.originLng,
      destinationLat: updates.destinationLat,
      destinationLng: updates.destinationLng,
      updatedAt: Date.now(),
    };
    if (updates.routeMiles !== undefined) patch.routeMiles = updates.routeMiles;
    if (updates.routeDurationHours !== undefined) patch.routeDurationHours = updates.routeDurationHours;
    if (updates.intermediateStops !== undefined) patch.intermediateStops = updates.intermediateStops;
    await ctx.db.patch(id, patch);
  },
});

export const listBasesInternal = internalQuery({
  args: { sessionId: v.id('laneAnalysisSessions') },
  handler: async (ctx, args) => {
    return ctx.db
      .query('laneAnalysisBases')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();
  },
});

export const updateBaseGeocode = internalMutation({
  args: {
    id: v.id('laneAnalysisBases'),
    latitude: v.number(),
    longitude: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      latitude: args.latitude,
      longitude: args.longitude,
    });
  },
});

export const getCachedToll = internalQuery({
  args: {
    originHash: v.string(),
    destinationHash: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query('tollEstimateCache')
      .withIndex('by_route', (q) =>
        q.eq('originHash', args.originHash).eq('destinationHash', args.destinationHash),
      )
      .first();
  },
});

export const updateEntryRoute = internalMutation({
  args: {
    id: v.id('laneAnalysisEntries'),
    originLat: v.number(),
    originLng: v.number(),
    destinationLat: v.number(),
    destinationLng: v.number(),
    routeMiles: v.number(),
    routeDurationHours: v.number(),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    await ctx.db.patch(id, { ...updates, updatedAt: Date.now() });
  },
});

// Helper: fetch and cache fuel prices from EIA API
async function fetchAndCacheFuelPrices(ctx: { runMutation: Function }) {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    console.warn('EIA_API_KEY not configured, skipping fuel price fetch');
    return;
  }

  const series: Record<string, string> = {
    US_AVERAGE: 'EMD_EPD2D_PTE_NUS_DPG',
    PADD1: 'EMD_EPD2D_PTE_R10_DPG',
    PADD2: 'EMD_EPD2D_PTE_R20_DPG',
    PADD3: 'EMD_EPD2D_PTE_R30_DPG',
    PADD4: 'EMD_EPD2D_PTE_R40_DPG',
    PADD5: 'EMD_EPD2D_PTE_R50_DPG',
  };

  const now = Date.now();
  for (const [region, seriesId] of Object.entries(series)) {
    try {
      const url = new URL('https://api.eia.gov/v2/petroleum/pri/gnd/data/');
      url.searchParams.append('api_key', apiKey);
      url.searchParams.append('frequency', 'weekly');
      url.searchParams.append('data[0]', 'value');
      url.searchParams.append('facets[series][]', seriesId);
      url.searchParams.append('sort[0][column]', 'period');
      url.searchParams.append('sort[0][direction]', 'desc');
      url.searchParams.append('length', '1');

      const response = await fetch(url.toString());
      if (!response.ok) continue;

      const data = await response.json();
      const value = data?.response?.data?.[0]?.value;

      if (value && typeof value === 'number') {
        await ctx.runMutation(internal.laneAnalyzerActions.writeFuelPrice, {
          region,
          pricePerGallon: value,
          fetchedAt: now,
        });
      }
    } catch {
      // Skip failed regions
    }
  }
}

// Helper: fetch toll cost from TollGuru API
async function fetchTollCostFromApi(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number,
): Promise<number> {
  const apiKey = process.env.TOLLGURU_API_KEY;
  if (!apiKey) return 0;

  try {
    const response = await fetch('https://apis.tollguru.com/toll/v2/origin-destination-waypoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        from: { lat: originLat, lng: originLng },
        to: { lat: destLat, lng: destLng },
        vehicleType: '5AxlesTruck',
      }),
    });

    if (!response.ok) return 0;

    const data = await response.json();
    const routes = data?.routes ?? [];
    if (routes.length === 0) return 0;

    return routes.reduce(
      (min: number, route: { costs?: { tag?: number; cash?: number } }) => {
        const cost = route.costs?.tag ?? route.costs?.cash ?? 0;
        return cost < min ? cost : min;
      },
      routes[0]?.costs?.tag ?? routes[0]?.costs?.cash ?? 0,
    );
  } catch {
    return 0;
  }
}

// Helper: calculate route distance from stops using Google Maps API
async function calculateRouteDistanceFromStops(
  stops: Array<{ latitude: number; longitude: number }>,
): Promise<{ miles: number; durationHours: number }> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('Google Maps API key not configured');
  if (stops.length < 2) throw new Error('At least 2 stops required');

  let totalDistanceMeters = 0;
  let totalDurationSeconds = 0;

  for (let i = 0; i < stops.length - 1; i++) {
    const origin = stops[i];
    const dest = stops[i + 1];

    const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
    url.searchParams.append('origins', `${origin.latitude},${origin.longitude}`);
    url.searchParams.append('destinations', `${dest.latitude},${dest.longitude}`);
    url.searchParams.append('key', apiKey);
    url.searchParams.append('units', 'imperial');

    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`API request failed: ${response.status}`);

    const data = await response.json();
    if (data.status !== 'OK') throw new Error(`Distance Matrix API error: ${data.status}`);

    const element = data.rows[0]?.elements[0];
    if (!element || element.status !== 'OK') {
      throw new Error(`Failed to calculate segment ${i + 1}: ${element?.status}`);
    }

    totalDistanceMeters += element.distance.value;
    totalDurationSeconds += element.duration.value;
  }

  return {
    miles: Math.round(totalDistanceMeters * 0.000621371 * 100) / 100,
    durationHours: Math.round((totalDurationSeconds / 3600) * 100) / 100,
  };
}

// Helper: geocode an address string using Google Maps Geocoding API
async function geocodeAddress(
  address: string,
  apiKey: string,
): Promise<{ lat: number; lng: number }> {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.append('address', address);
  url.searchParams.append('key', apiKey);

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`Geocoding API error: ${response.status}`);

  const data = await response.json();
  if (data.status !== 'OK' || !data.results?.[0]) {
    throw new Error(`Geocoding failed for "${address}": ${data.status}`);
  }

  const location = data.results[0].geometry.location;
  return { lat: location.lat, lng: location.lng };
}
