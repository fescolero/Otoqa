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
        fallbackPoints: args.coordinates.map(c => ({ latitude: c.latitude, longitude: c.longitude })),
      };
    }

    if (args.coordinates.length < 2) {
      return {
        encodedPolyline: undefined,
        confidence: 0,
        matchedPoints: 0,
        fallbackPoints: args.coordinates.map(c => ({ latitude: c.latitude, longitude: c.longitude })),
      };
    }

    try {
      // Process in batches if more than 100 coordinates
      const allEncodedSegments: string[] = [];
      let totalConfidence = 0;
      let totalMatched = 0;
      let batchCount = 0;

      for (let i = 0; i < args.coordinates.length; i += MAX_MAPBOX_COORDINATES - 5) {
        // Overlap batches slightly for continuity
        const batchEnd = Math.min(i + MAX_MAPBOX_COORDINATES, args.coordinates.length);
        const batch = args.coordinates.slice(i, batchEnd);
        
        if (batch.length < 2) continue;

        // Format coordinates as lng,lat;lng,lat (Mapbox uses lng,lat order!)
        const coordString = batch
          .map(c => `${c.longitude},${c.latitude}`)
          .join(';');

        // Build URL with parameters
        const url = new URL(`${MAPBOX_MATCHING_API_URL}/${coordString}`);
        url.searchParams.set('access_token', accessToken);
        url.searchParams.set('geometries', 'polyline6'); // High precision polyline
        url.searchParams.set('overview', 'full'); // Full route geometry
        url.searchParams.set('tidy', 'true'); // Remove redundant coordinates
        
        // Add timestamps if available (improves matching accuracy)
        if (batch[0].timestamp && batch.every(c => c.timestamp)) {
          const timestamps = batch.map(c => Math.floor((c.timestamp || 0) / 1000)).join(';');
          url.searchParams.set('timestamps', timestamps);
        }

        // Add radiuses - how far from each point to search for roads (in meters)
        // Larger radius = more forgiving of GPS drift
        const radiuses = batch.map(() => '50').join(';'); // 50m search radius
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

        // Get the best matching
        const matching = data.matchings[0];
        if (matching.geometry) {
          allEncodedSegments.push(matching.geometry);
          totalConfidence += matching.confidence || 0;
          totalMatched += batch.length;
          batchCount++;
        }
      }

      if (allEncodedSegments.length === 0) {
        console.warn('[MapboxMatching] No matches found, returning raw coordinates');
        return {
          encodedPolyline: undefined,
          confidence: 0,
          matchedPoints: 0,
          fallbackPoints: args.coordinates.map(c => ({ latitude: c.latitude, longitude: c.longitude })),
        };
      }

      // If multiple segments, we need to combine them
      // For now, return the first segment's polyline (most common case)
      // TODO: Combine multiple polylines for very long routes
      const avgConfidence = batchCount > 0 ? totalConfidence / batchCount : 0;
      
      console.log(`[MapboxMatching] Matched ${totalMatched}/${args.coordinates.length} points with ${(avgConfidence * 100).toFixed(1)}% confidence`);
      
      return {
        encodedPolyline: allEncodedSegments[0],
        confidence: avgConfidence,
        matchedPoints: totalMatched,
        fallbackPoints: [],
      };
    } catch (error) {
      console.error('[MapboxMatching] Failed:', error);
      return {
        encodedPolyline: undefined,
        confidence: 0,
        matchedPoints: 0,
        fallbackPoints: args.coordinates.map(c => ({ latitude: c.latitude, longitude: c.longitude })),
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
