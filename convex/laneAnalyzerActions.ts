import { v } from 'convex/values';
import { action, internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal, api } from './_generated/api';

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

    // 4. Run the full calculation engine (per-lane costs, HOS analysis)
    await ctx.runMutation(internal.laneAnalyzerCalculations.runFullAnalysis, {
      sessionId: args.sessionId,
    });

    // 5. Run Python OR-Tools solver for optimal shift assignments
    const solverUrl = process.env.SOLVER_API_URL;
    console.log('SOLVER_API_URL:', solverUrl ?? 'NOT SET');
    if (solverUrl) {
      try {
        console.log('Calling external solver...');
        await ctx.runAction(internal.laneAnalyzerActions.runExternalSolver, {
          sessionId: args.sessionId,
          solverUrl,
        });
        console.log('External solver completed successfully');
      } catch (e) {
        console.warn('External solver failed, persisting status:', String(e));
        await ctx.runMutation(internal.laneAnalyzerActions.storeSolverStatus, {
          sessionId: args.sessionId,
          status: 'failed',
          error: String(e),
          source: 'weekly_solver_v4',
        });
      }
    } else {
      console.log('No SOLVER_API_URL configured, skipping external solver');
    }

    // 6. Run base optimization (deadhead analysis)
    await ctx.runMutation(internal.laneAnalyzerOptimization.optimizeBases, {
      sessionId: args.sessionId,
    });

    // 7. Find lane pairing opportunities
    await ctx.runMutation(internal.laneAnalyzerOptimization.findLaneCombinations, {
      sessionId: args.sessionId,
    });

    return { success: true };
  },
});

// ---- INTERNAL HELPERS ----
// These are internal functions needed by the actions above.

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

// ==========================================
// External Python OR-Tools Solver Integration
// ==========================================

/**
 * Call the external Python solver and store results.
 */
export const runExternalSolver = internalAction({
  args: {
    sessionId: v.id('laneAnalysisSessions'),
    solverUrl: v.string(),
  },
  handler: async (ctx, args) => {
    // 1. Read lane data
    const data = await ctx.runQuery(api.laneAnalyzer.exportEntriesForSolver, {
      sessionId: args.sessionId,
    });

    if (!data || !data.entries || data.entries.length === 0) {
      console.warn('No entries to solve');
      return;
    }

    // 2. Read session config
    const session = await ctx.runQuery(internal.laneAnalyzerActions.getSessionConfig, {
      sessionId: args.sessionId,
    });

    // 3. Call the weekly solver API (10h off-duty + full HOS compliance)
    // No target_drivers — solver finds the minimum automatically
    const payload = JSON.stringify({
      lanes: data.entries,
      config: {
        max_wait: session?.maxWaitHours ?? 2,
        max_legs: session?.maxChainingLegs ?? 8,
        max_deadhead: session?.maxDeadheadMiles ?? 75,
        hourly_rate: session?.defaultDriverPayRate ?? 31.2,
        fuel_price: session?.defaultFuelPricePerGallon ?? 7.70,
        mpg_hwy: session?.defaultMpgHighway ?? 6,
        mpg_city: session?.defaultMpgCity ?? 10,
        pre_post_hours: session?.prePostTripMinutes != null ? session.prePostTripMinutes / 60 : 1.0,
        max_gap_hours: (session as any)?.maxGapHours ?? 3.0,
        drive_buffer_hours: (session as any)?.driveBufferHours ?? 1.5,
        target_drivers: session?.targetDriverCount ?? undefined,
        enable_local_optimize: true,
        best_of_n: 3,
        // v5_hybrid is opt-in per-session via session.solverVersion field.
        // Default is v4 (proven, consistent). v5_hybrid beats v4 on 917DK
        // but needs validation on 2+ more contracts before becoming default.
        solver_version: (session as any)?.solverVersion ?? 'v4',
        bases: data.bases,
      },
    });

    console.log(`Calling weekly solver at ${args.solverUrl}/solve-weekly with ${data.entries.length} lanes, ${data.bases.length} base(s)...`);

    const response = await fetch(`${args.solverUrl}/solve-weekly`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });

    if (!response.ok) {
      throw new Error(`Solver API returned ${response.status}: ${await response.text()}`);
    }

    const result = await response.json() as {
      success: boolean;
      driverCount: number;
      hosCompliant: boolean;
      weeklySchedule?: Array<{
        driverId: number;
        days: Record<string, {
          legs: string[]; legNames: string[]; legCount: number;
          driveHours: number; dutyHours: number;
          miles: number; deadheadMiles: number;
          startTime: number | null; endTime: number | null;
          isExact?: boolean;
          legGaps?: Array<{ miles: number; driveHours: number; waitHours: number | null; prevEndTime: number | null; nextStartTime: number | null; earliestArrival: number | null }>;
        }>;
        totalDriveHours: number;
        totalDutyHours: number;
        totalMiles: number;
        totalDeadheadMiles: number;
        daysWorked: number;
      }>;
      constraints?: { offDutyHours: number; maxWeeklyDuty: number; maxDailyDrive: number; maxDailyDuty: number };
      hosViolations?: string[];
      allExact?: boolean;
      minLegalDriverCount?: number;
      recommendedDriverCount?: number;
      minDispatchableDriverCount?: number;
      qualitySummary?: { exactDayCount: number; estimatedDayCount: number; maxDeadheadDayMiles: number };
      error?: string;
    };

    if (!result.success) {
      throw new Error(`Solver failed: ${result.error || 'unknown'}`);
    }

    console.log(`Weekly solver: ${result.driverCount} drivers, HOS compliant: ${result.hosCompliant}`);

    // 4. Store solver results — trim schedule + compute quality metrics
    const trimmedSchedule = result.weeklySchedule?.map((driver) => ({
      driverId: driver.driverId,
      days: Object.fromEntries(
        Object.entries(driver.days).map(([dayName, dayData]) => [
          dayName,
          {
            legs: dayData.legs,
            driveHours: dayData.driveHours,
            dutyHours: dayData.dutyHours,
            miles: dayData.miles ?? 0,
            deadheadMiles: dayData.deadheadMiles ?? 0,
            startTime: dayData.startTime,
            endTime: dayData.endTime,
            isExact: dayData.isExact ?? false,
            legGaps: dayData.legGaps ?? [],
          },
        ]),
      ),
    }));

    // Compute quality metrics from the schedule
    let maxDailyDrive = 0;
    let maxDailyDuty = 0;
    let maxDailySpan = 0;
    let maxDailyDeadhead = 0;
    let totalDrive = 0;
    let totalDuty = 0;
    let totalMiles = 0;
    let totalDeadheadMiles = 0;
    let driverDaysUsed = 0;
    for (const driver of result.weeklySchedule ?? []) {
      for (const dayData of Object.values(driver.days) as Array<{
        driveHours: number; dutyHours: number; miles?: number; deadheadMiles?: number;
        startTime?: number | null; endTime?: number | null;
      }>) {
        driverDaysUsed++;
        if (dayData.driveHours > maxDailyDrive) maxDailyDrive = dayData.driveHours;
        if (dayData.dutyHours > maxDailyDuty) maxDailyDuty = dayData.dutyHours;
        const dh = dayData.deadheadMiles ?? 0;
        if (dh > maxDailyDeadhead) maxDailyDeadhead = dh;
        totalDrive += dayData.driveHours;
        totalDuty += dayData.dutyHours;
        totalMiles += dayData.miles ?? 0;
        totalDeadheadMiles += dh;
        if (dayData.startTime != null && dayData.endTime != null) {
          const span = dayData.endTime - dayData.startTime;
          if (span > maxDailySpan) maxDailySpan = span;
        }
      }
    }

    await ctx.runMutation(internal.laneAnalyzerActions.storeSolverResults, {
      sessionId: args.sessionId,
      driverCount: result.driverCount,
      weeklySchedule: trimmedSchedule ?? [],
      hosCompliant: result.hosCompliant ?? true,
      hosViolations: result.hosViolations ?? [],
      allExact: result.allExact ?? false,
      minLegalDriverCount: result.minLegalDriverCount ?? result.driverCount,
      recommendedDriverCount: result.recommendedDriverCount ?? result.driverCount,
      minDispatchableDriverCount: result.minDispatchableDriverCount ?? result.driverCount,
      constraints: result.constraints ?? null,
      qualitySummary: result.qualitySummary ?? null,
      quality: {
        maxDailyDrive: Math.round(maxDailyDrive * 10) / 10,
        maxDailyDuty: Math.round(maxDailyDuty * 10) / 10,
        maxDailySpan: Math.round(maxDailySpan * 10) / 10,
        maxDailyDeadhead: Math.round(maxDailyDeadhead),
        totalDeadheadMiles: Math.round(totalDeadheadMiles),
        totalMiles: Math.round(totalMiles),
        deadheadPercent: totalMiles > 0 ? Math.round(totalDeadheadMiles / totalMiles * 1000) / 10 : 0,
        avgDriveUtilization: totalDuty > 0 ? Math.round(totalDrive / totalDuty * 100) : 0,
        driverDaysUsed,
      },
    });
  },
});

export const getSessionConfig = internalQuery({
  args: { sessionId: v.id('laneAnalysisSessions') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sessionId);
  },
});

export const storeSolverResults = internalMutation({
  args: {
    sessionId: v.id('laneAnalysisSessions'),
    driverCount: v.number(),
    weeklySchedule: v.array(v.any()),
    hosCompliant: v.boolean(),
    hosViolations: v.array(v.string()),
    allExact: v.boolean(),
    minLegalDriverCount: v.number(),
    recommendedDriverCount: v.number(),
    minDispatchableDriverCount: v.number(),
    constraints: v.any(),
    qualitySummary: v.any(),
    quality: v.object({
      maxDailyDrive: v.number(),
      maxDailyDuty: v.number(),
      maxDailySpan: v.number(),
      maxDailyDeadhead: v.number(),
      totalDeadheadMiles: v.number(),
      totalMiles: v.number(),
      deadheadPercent: v.number(),
      avgDriveUtilization: v.number(),
      driverDaysUsed: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const aggregateResult = await ctx.db
      .query('laneAnalysisResults')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .filter((q) => q.eq(q.field('resultType'), 'AGGREGATE'))
      .first();

    if (aggregateResult) {
      const existing = aggregateResult.hosAnalysis ? JSON.parse(aggregateResult.hosAnalysis) : {};

      existing.solver = {
        status: 'success' as const,
        driverCount: args.driverCount,
        minLegalDriverCount: args.minLegalDriverCount,
        recommendedDriverCount: args.recommendedDriverCount,
        minDispatchableDriverCount: args.minDispatchableDriverCount,
        weeklySchedule: args.weeklySchedule,
        hosCompliant: args.hosCompliant,
        hosViolations: args.hosViolations,
        allExact: args.allExact,
        constraints: args.constraints,
        quality: args.quality,
        qualitySummary: args.qualitySummary,
        source: 'weekly_solver_v4',
        solvedAt: Date.now(),
      };

      await ctx.db.patch(aggregateResult._id, {
        minDriverCount: args.minLegalDriverCount,
        realisticDriverCount: args.recommendedDriverCount,
        hosAnalysis: JSON.stringify(existing),
      });
    }
  },
});

export const storeSolverStatus = internalMutation({
  args: {
    sessionId: v.id('laneAnalysisSessions'),
    status: v.string(),
    error: v.string(),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const aggregateResult = await ctx.db
      .query('laneAnalysisResults')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .filter((q) => q.eq(q.field('resultType'), 'AGGREGATE'))
      .first();

    if (aggregateResult) {
      const existing = aggregateResult.hosAnalysis ? JSON.parse(aggregateResult.hosAnalysis) : {};

      existing.solver = {
        status: args.status,
        error: args.error,
        source: args.source,
        solvedAt: Date.now(),
      };

      await ctx.db.patch(aggregateResult._id, {
        hosAnalysis: JSON.stringify(existing),
      });
    }
  },
});
