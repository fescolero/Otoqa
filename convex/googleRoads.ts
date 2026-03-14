'use node';

import { v } from 'convex/values';
import { action } from './_generated/server';

// ============================================
// MAP MATCHING APIs
// Transforms raw GPS coordinates into road-following paths
// - Mapbox Map Matching: Best for tracking (what route was taken)
// - Google Directions: For routing (what route should be taken)
// ============================================

const GOOGLE_ROADS_API_URL = 'https://roads.googleapis.com/v1/snapToRoads';
const GOOGLE_DIRECTIONS_API_URL = 'https://maps.googleapis.com/maps/api/directions/json';
const MAPBOX_MATCHING_API_URL = 'https://api.mapbox.com/matching/v5/mapbox/driving';
const MAX_POINTS_PER_REQUEST = 100; // Google Roads API limit
const MAX_WAYPOINTS_PER_DIRECTIONS = 25; // Directions API limit
const MAX_MAPBOX_COORDINATES = 100; // Mapbox limit per request

interface SnappedPoint {
  latitude: number;
  longitude: number;
  originalIndex?: number;
  placeId?: string;
}

/**
 * Snap GPS coordinates to the nearest road segments
 * Uses Google Roads API for accurate road-following paths
 */
export const snapToRoads = action({
  args: {
    coordinates: v.array(
      v.object({
        latitude: v.float64(),
        longitude: v.float64(),
        recordedAt: v.optional(v.float64()),
      })
    ),
    interpolate: v.optional(v.boolean()), // Fill gaps between points
  },
  returns: v.array(
    v.object({
      latitude: v.float64(),
      longitude: v.float64(),
      originalIndex: v.optional(v.number()),
    })
  ),
  handler: async (ctx, args) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    
    if (!apiKey) {
      console.warn('[GoogleRoads] API key not configured, returning original coordinates');
      return args.coordinates.map((c, i) => ({
        latitude: c.latitude,
        longitude: c.longitude,
        originalIndex: i,
      }));
    }

    if (args.coordinates.length === 0) {
      return [];
    }

    // If only 1-2 points, no need to snap
    if (args.coordinates.length < 3) {
      return args.coordinates.map((c, i) => ({
        latitude: c.latitude,
        longitude: c.longitude,
        originalIndex: i,
      }));
    }

    try {
      // Process in batches if more than 100 points
      const allSnappedPoints: SnappedPoint[] = [];
      
      for (let i = 0; i < args.coordinates.length; i += MAX_POINTS_PER_REQUEST - 10) {
        // Overlap batches slightly for continuity
        const batchEnd = Math.min(i + MAX_POINTS_PER_REQUEST, args.coordinates.length);
        const batch = args.coordinates.slice(i, batchEnd);
        
        // Format path for API
        const pathString = batch
          .map((c) => `${c.latitude},${c.longitude}`)
          .join('|');

        const url = new URL(GOOGLE_ROADS_API_URL);
        url.searchParams.set('path', pathString);
        url.searchParams.set('interpolate', args.interpolate !== false ? 'true' : 'false');
        url.searchParams.set('key', apiKey);

        console.log(`[GoogleRoads] Requesting snap for ${batch.length} points...`);
        const response = await fetch(url.toString());
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error('[GoogleRoads] API error:', response.status, errorText);
          console.error('[GoogleRoads] Make sure Roads API is enabled in Google Cloud Console');
          // Fall back to original coordinates for this batch
          batch.forEach((c, idx) => {
            allSnappedPoints.push({
              latitude: c.latitude,
              longitude: c.longitude,
              originalIndex: i + idx,
            });
          });
          continue;
        }

        const data = await response.json();
        
        if (data.snappedPoints && data.snappedPoints.length > 0) {
          // Skip overlapping points from previous batch
          const startIdx = i === 0 ? 0 : 5;
          data.snappedPoints.slice(startIdx).forEach((point: any) => {
            allSnappedPoints.push({
              latitude: point.location.latitude,
              longitude: point.location.longitude,
              originalIndex: point.originalIndex !== undefined ? i + point.originalIndex : undefined,
              placeId: point.placeId,
            });
          });
        } else {
          // No snapped points returned, use original
          batch.forEach((c, idx) => {
            allSnappedPoints.push({
              latitude: c.latitude,
              longitude: c.longitude,
              originalIndex: i + idx,
            });
          });
        }
      }

      console.log(`[GoogleRoads] Snapped ${args.coordinates.length} points to ${allSnappedPoints.length} road points`);
      
      return allSnappedPoints.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
        originalIndex: p.originalIndex,
      }));
    } catch (error) {
      console.error('[GoogleRoads] Snap to roads failed:', error);
      // Return original coordinates on error
      return args.coordinates.map((c, i) => ({
        latitude: c.latitude,
        longitude: c.longitude,
        originalIndex: i,
      }));
    }
  },
});

/**
 * Match GPS coordinates to roads using Mapbox Map Matching API
 * BEST FOR TRACKING - determines what route was actually taken
 * Unlike Directions API, this doesn't invent detours
 */
export const mapMatchRoute = action({
  args: {
    coordinates: v.array(
      v.object({
        latitude: v.float64(),
        longitude: v.float64(),
        timestamp: v.optional(v.float64()),
      })
    ),
  },
  returns: v.object({
    encodedPolyline: v.optional(v.string()),
    confidence: v.number(),
    matchedPoints: v.number(),
    decodedPath: v.array(
      v.object({
        latitude: v.float64(),
        longitude: v.float64(),
      })
    ),
    fallbackPoints: v.array(
      v.object({
        latitude: v.float64(),
        longitude: v.float64(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    const accessToken = process.env.MAPBOX_ACCESS_TOKEN;
    
    if (!accessToken) {
      console.warn('[MapboxMatching] Access token not configured, returning raw coordinates');
      return {
        encodedPolyline: undefined,
        confidence: 0,
        matchedPoints: 0,
        decodedPath: [],
        fallbackPoints: args.coordinates.map(c => ({ latitude: c.latitude, longitude: c.longitude })),
      };
    }

    if (args.coordinates.length < 2) {
      return {
        encodedPolyline: undefined,
        confidence: 0,
        matchedPoints: 0,
        decodedPath: [],
        fallbackPoints: args.coordinates.map(c => ({ latitude: c.latitude, longitude: c.longitude })),
      };
    }

    try {
      // Collect all decoded path points from all matchings across all batches.
      // Mapbox returns multiple matchings when there are gaps in the GPS data
      // (e.g., app was backgrounded). We decode and concatenate them all so
      // the route vector is continuous.
      const allPathPoints: Array<{ latitude: number; longitude: number }> = [];
      let firstEncodedPolyline: string | undefined;
      let totalConfidence = 0;
      let totalMatched = 0;
      let batchCount = 0;

      for (let i = 0; i < args.coordinates.length; i += MAX_MAPBOX_COORDINATES - 5) {
        const batchEnd = Math.min(i + MAX_MAPBOX_COORDINATES, args.coordinates.length);
        const batch = args.coordinates.slice(i, batchEnd);
        
        if (batch.length < 2) continue;

        const coordString = batch
          .map(c => `${c.longitude},${c.latitude}`)
          .join(';');

        const url = new URL(`${MAPBOX_MATCHING_API_URL}/${coordString}`);
        url.searchParams.set('access_token', accessToken);
        url.searchParams.set('geometries', 'polyline6');
        url.searchParams.set('overview', 'full');
        url.searchParams.set('tidy', 'true');
        
        if (batch[0].timestamp && batch.every(c => c.timestamp)) {
          const timestamps = batch.map(c => Math.floor((c.timestamp || 0) / 1000)).join(';');
          url.searchParams.set('timestamps', timestamps);
        }

        const radiuses = batch.map(() => '50').join(';');
        url.searchParams.set('radiuses', radiuses);

        console.log(`[MapboxMatching] Matching ${batch.length} coordinates...`);
        const response = await fetch(url.toString());

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[MapboxMatching] API error:', response.status, errorText);
          continue;
        }

        const data = await response.json();

        if (data.code !== 'Ok' || !data.matchings || data.matchings.length === 0) {
          console.warn('[MapboxMatching] No match found:', data.code);
          continue;
        }

        // Collect ALL matchings (Mapbox splits into multiple when there are gaps)
        for (const matching of data.matchings) {
          if (matching.geometry) {
            if (!firstEncodedPolyline) {
              firstEncodedPolyline = matching.geometry;
            }
            const decoded = decodePolyline6(matching.geometry);
            allPathPoints.push(...decoded);
            totalConfidence += matching.confidence || 0;
            batchCount++;
          }
        }
        totalMatched += batch.length;
      }

      if (allPathPoints.length === 0) {
        console.warn('[MapboxMatching] No matches found, returning raw coordinates');
        return {
          encodedPolyline: undefined,
          confidence: 0,
          matchedPoints: 0,
          decodedPath: [],
          fallbackPoints: args.coordinates.map(c => ({ latitude: c.latitude, longitude: c.longitude })),
        };
      }

      const avgConfidence = batchCount > 0 ? totalConfidence / batchCount : 0;
      
      console.log(`[MapboxMatching] Matched ${totalMatched}/${args.coordinates.length} points → ${allPathPoints.length} path points across ${batchCount} segments (${(avgConfidence * 100).toFixed(1)}% confidence)`);
      
      return {
        encodedPolyline: firstEncodedPolyline,
        confidence: avgConfidence,
        matchedPoints: totalMatched,
        decodedPath: allPathPoints,
        fallbackPoints: [],
      };
    } catch (error) {
      console.error('[MapboxMatching] Failed:', error);
      return {
        encodedPolyline: undefined,
        confidence: 0,
        matchedPoints: 0,
        decodedPath: [],
        fallbackPoints: args.coordinates.map(c => ({ latitude: c.latitude, longitude: c.longitude })),
      };
    }
  },
});

/**
 * Decode Mapbox polyline6 format (precision 1e6)
 */
function decodePolyline6(encoded: string): Array<{ latitude: number; longitude: number }> {
  const points: Array<{ latitude: number; longitude: number }> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    points.push({
      latitude: lat / 1e6,
      longitude: lng / 1e6,
    });
  }

  return points;
}

/**
 * Diagnostic variant of mapMatchRoute that also returns per-point tracepoint data.
 * Used by the GPS Logs debugging page to show match status, snapped coordinates,
 * road names, drift distance, and batch boundaries for every raw GPS point.
 */
export const mapMatchRouteWithDiagnostics = action({
  args: {
    coordinates: v.array(
      v.object({
        latitude: v.float64(),
        longitude: v.float64(),
        timestamp: v.optional(v.float64()),
      })
    ),
  },
  returns: v.object({
    encodedPolyline: v.optional(v.string()),
    confidence: v.number(),
    matchedPoints: v.number(),
    fallbackPoints: v.array(
      v.object({
        latitude: v.float64(),
        longitude: v.float64(),
      })
    ),
    tracepoints: v.array(
      v.object({
        originalIndex: v.number(),
        matched: v.boolean(),
        snappedLat: v.optional(v.float64()),
        snappedLng: v.optional(v.float64()),
        roadName: v.optional(v.string()),
        driftMeters: v.optional(v.float64()),
        batchIndex: v.number(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    const accessToken = process.env.MAPBOX_ACCESS_TOKEN;

    const emptyResult = {
      encodedPolyline: undefined as string | undefined,
      confidence: 0,
      matchedPoints: 0,
      fallbackPoints: args.coordinates.map(c => ({ latitude: c.latitude, longitude: c.longitude })),
      tracepoints: args.coordinates.map((_, i) => ({
        originalIndex: i,
        matched: false,
        snappedLat: undefined as number | undefined,
        snappedLng: undefined as number | undefined,
        roadName: undefined as string | undefined,
        driftMeters: undefined as number | undefined,
        batchIndex: 0,
      })),
    };

    if (!accessToken) {
      console.warn('[MapboxDiag] Access token not configured');
      return emptyResult;
    }

    if (args.coordinates.length < 2) {
      return emptyResult;
    }

    try {
      const allEncodedSegments: string[] = [];
      const allTracepoints: Array<{
        originalIndex: number;
        matched: boolean;
        snappedLat?: number;
        snappedLng?: number;
        roadName?: string;
        driftMeters?: number;
        batchIndex: number;
      }> = [];
      let totalConfidence = 0;
      let totalMatched = 0;
      let batchCount = 0;
      let batchIndex = 0;

      const BATCH_OVERLAP = 5;

      for (let i = 0; i < args.coordinates.length; i += MAX_MAPBOX_COORDINATES - BATCH_OVERLAP) {
        const batchEnd = Math.min(i + MAX_MAPBOX_COORDINATES, args.coordinates.length);
        const batch = args.coordinates.slice(i, batchEnd);

        if (batch.length < 2) continue;

        const coordString = batch
          .map(c => `${c.longitude},${c.latitude}`)
          .join(';');

        const url = new URL(`${MAPBOX_MATCHING_API_URL}/${coordString}`);
        url.searchParams.set('access_token', accessToken);
        url.searchParams.set('geometries', 'polyline6');
        url.searchParams.set('overview', 'full');
        url.searchParams.set('tidy', 'true');

        if (batch[0].timestamp && batch.every(c => c.timestamp)) {
          const timestamps = batch.map(c => Math.floor((c.timestamp || 0) / 1000)).join(';');
          url.searchParams.set('timestamps', timestamps);
        }

        const radiuses = batch.map(() => '50').join(';');
        url.searchParams.set('radiuses', radiuses);

        console.log(`[MapboxDiag] Batch ${batchIndex}: matching ${batch.length} coordinates (indices ${i}-${batchEnd - 1})...`);
        const response = await fetch(url.toString());

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[MapboxDiag] API error:', response.status, errorText);
          for (let j = 0; j < batch.length; j++) {
            const globalIdx = i + j;
            if (i > 0 && j < BATCH_OVERLAP) continue;
            allTracepoints.push({
              originalIndex: globalIdx,
              matched: false,
              batchIndex,
            });
          }
          batchIndex++;
          continue;
        }

        const data = await response.json();

        if (data.code !== 'Ok' || !data.matchings || data.matchings.length === 0) {
          console.warn('[MapboxDiag] No match found:', data.code);
          for (let j = 0; j < batch.length; j++) {
            const globalIdx = i + j;
            if (i > 0 && j < BATCH_OVERLAP) continue;
            allTracepoints.push({
              originalIndex: globalIdx,
              matched: false,
              batchIndex,
            });
          }
          batchIndex++;
          continue;
        }

        const matching = data.matchings[0];
        if (matching.geometry) {
          allEncodedSegments.push(matching.geometry);
          totalConfidence += matching.confidence || 0;
          batchCount++;
        }

        const tracepoints: Array<any> = data.tracepoints || [];
        let matchedInBatch = 0;

        for (let j = 0; j < batch.length; j++) {
          const globalIdx = i + j;
          if (i > 0 && j < BATCH_OVERLAP) continue;

          const tp = tracepoints[j];
          const raw = batch[j];

          if (tp && tp.location) {
            const snappedLng = tp.location[0];
            const snappedLat = tp.location[1];
            const drift = haversineDistance(raw.latitude, raw.longitude, snappedLat, snappedLng) * 1000;

            allTracepoints.push({
              originalIndex: globalIdx,
              matched: true,
              snappedLat,
              snappedLng,
              roadName: tp.name || undefined,
              driftMeters: Math.round(drift * 10) / 10,
              batchIndex,
            });
            matchedInBatch++;
          } else {
            allTracepoints.push({
              originalIndex: globalIdx,
              matched: false,
              batchIndex,
            });
          }
        }

        totalMatched += matchedInBatch;
        batchIndex++;
      }

      if (allEncodedSegments.length === 0) {
        console.warn('[MapboxDiag] No matches found, returning raw coordinates');
        return {
          ...emptyResult,
          tracepoints: allTracepoints,
        };
      }

      const avgConfidence = batchCount > 0 ? totalConfidence / batchCount : 0;

      console.log(`[MapboxDiag] Matched ${totalMatched}/${args.coordinates.length} points across ${batchIndex} batches (${(avgConfidence * 100).toFixed(1)}% confidence)`);

      return {
        encodedPolyline: allEncodedSegments[0],
        confidence: avgConfidence,
        matchedPoints: totalMatched,
        fallbackPoints: [],
        tracepoints: allTracepoints,
      };
    } catch (error) {
      console.error('[MapboxDiag] Failed:', error);
      return {
        encodedPolyline: undefined,
        confidence: 0,
        matchedPoints: 0,
        fallbackPoints: args.coordinates.map(c => ({ latitude: c.latitude, longitude: c.longitude })),
        tracepoints: args.coordinates.map((_, i) => ({
          originalIndex: i,
          matched: false,
          snappedLat: undefined as number | undefined,
          snappedLng: undefined as number | undefined,
          roadName: undefined as string | undefined,
          driftMeters: undefined as number | undefined,
          batchIndex: 0,
        })),
      };
    }
  },
});

/**
 * Get road-following path between GPS points using Directions API
 * Makes individual API calls for each pair of consecutive points
 * This ensures the path follows the actual roads between sparse GPS pings
 * @deprecated Use mapMatchRoute instead for tracking
 */
export const getRoutePath = action({
  args: {
    coordinates: v.array(
      v.object({
        latitude: v.float64(),
        longitude: v.float64(),
      })
    ),
  },
  returns: v.object({
    encodedPolylines: v.array(v.string()), // Compact encoded strings
    fallbackPoints: v.array(              // Raw points if API fails
      v.object({
        latitude: v.float64(),
        longitude: v.float64(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    
    if (!apiKey) {
      console.warn('[GoogleDirections] API key not configured');
      return { encodedPolylines: [], fallbackPoints: args.coordinates };
    }

    if (args.coordinates.length < 2) {
      return { encodedPolylines: [], fallbackPoints: args.coordinates };
    }

    try {
      const encodedPolylines: string[] = [];
      const fallbackPoints: Array<{ latitude: number; longitude: number }> = [];
      
      // Process each PAIR of consecutive points individually
      // This ensures we get the road path between each GPS ping
      const requests: Promise<void>[] = [];
      const results: Array<{ index: number; polyline?: string; fallback?: Array<{ latitude: number; longitude: number }> }> = [];
      
      for (let i = 0; i < args.coordinates.length - 1; i++) {
        const origin = args.coordinates[i];
        const destination = args.coordinates[i + 1];
        
        // Create request for this segment
        const requestPromise = (async () => {
          const url = new URL(GOOGLE_DIRECTIONS_API_URL);
          url.searchParams.set('origin', `${origin.latitude},${origin.longitude}`);
          url.searchParams.set('destination', `${destination.latitude},${destination.longitude}`);
          url.searchParams.set('key', apiKey);

          try {
            const response = await fetch(url.toString());
            
            if (!response.ok) {
              results.push({ 
                index: i, 
                fallback: [origin, destination] 
              });
              return;
            }

            const data = await response.json();
            
            if (data.status !== 'OK' || !data.routes?.[0]?.overview_polyline?.points) {
              results.push({ 
                index: i, 
                fallback: [origin, destination] 
              });
              return;
            }

            results.push({ 
              index: i, 
              polyline: data.routes[0].overview_polyline.points 
            });
          } catch {
            results.push({ 
              index: i, 
              fallback: [origin, destination] 
            });
          }
        })();
        
        requests.push(requestPromise);
        
        // Batch requests in groups of 10 to avoid rate limiting
        if (requests.length >= 10 || i === args.coordinates.length - 2) {
          await Promise.all(requests);
          requests.length = 0;
          
          // Small delay between batches to avoid rate limits
          if (i < args.coordinates.length - 2) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }

      // Sort results by index and collect polylines
      results.sort((a, b) => a.index - b.index);
      
      for (const result of results) {
        if (result.polyline) {
          encodedPolylines.push(result.polyline);
        } else if (result.fallback) {
          result.fallback.forEach(p => fallbackPoints.push(p));
        }
      }

      console.log(`[GoogleDirections] Got ${encodedPolylines.length} segments from ${args.coordinates.length} GPS points`);
      return { encodedPolylines, fallbackPoints };
    } catch (error) {
      console.error('[GoogleDirections] Failed:', error);
      return { encodedPolylines: [], fallbackPoints: args.coordinates };
    }
  },
});

/**
 * Simplify path by keeping points at regular intervals
 * Uses distance-based sampling to maintain route shape
 */
function simplifyPath(
  points: Array<{ latitude: number; longitude: number }>,
  maxPoints: number
): Array<{ latitude: number; longitude: number }> {
  if (points.length <= maxPoints) return points;

  const result: Array<{ latitude: number; longitude: number }> = [];
  
  // Always keep first point
  result.push(points[0]);
  
  // Calculate total path distance
  let totalDistance = 0;
  for (let i = 1; i < points.length; i++) {
    totalDistance += haversineDistance(
      points[i - 1].latitude,
      points[i - 1].longitude,
      points[i].latitude,
      points[i].longitude
    );
  }
  
  // Target distance between kept points
  const targetInterval = totalDistance / (maxPoints - 1);
  let accumulatedDistance = 0;
  let lastKeptIndex = 0;
  
  for (let i = 1; i < points.length - 1; i++) {
    accumulatedDistance += haversineDistance(
      points[i - 1].latitude,
      points[i - 1].longitude,
      points[i].latitude,
      points[i].longitude
    );
    
    if (accumulatedDistance >= targetInterval) {
      result.push(points[i]);
      accumulatedDistance = 0;
      lastKeptIndex = i;
    }
  }
  
  // Always keep last point
  result.push(points[points.length - 1]);
  
  return result;
}

/**
 * Calculate distance between two points in km (Haversine formula)
 */
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Decode Google's encoded polyline format
 */
function decodePolyline(encoded: string): Array<{ latitude: number; longitude: number }> {
  const points: Array<{ latitude: number; longitude: number }> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    points.push({
      latitude: lat / 1e5,
      longitude: lng / 1e5,
    });
  }

  return points;
}
