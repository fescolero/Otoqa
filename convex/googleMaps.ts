import { v } from 'convex/values';
import { action } from './_generated/server';

/**
 * Calculate the total distance for a route using Google Maps Distance Matrix API
 * Sums the distances between sequential stops
 */
export const calculateRouteDistance = action({
  args: {
    stops: v.array(
      v.object({
        latitude: v.number(),
        longitude: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    
    if (!apiKey) {
      throw new Error('Google Maps API key not configured');
    }

    if (args.stops.length < 2) {
      throw new Error('At least 2 stops are required to calculate distance');
    }

    try {
      let totalDistanceMeters = 0;
      let totalDurationSeconds = 0;

      // Calculate distance between each consecutive pair of stops
      for (let i = 0; i < args.stops.length - 1; i++) {
        const origin = args.stops[i];
        const destination = args.stops[i + 1];

        const originStr = `${origin.latitude},${origin.longitude}`;
        const destinationStr = `${destination.latitude},${destination.longitude}`;

        // Call Google Maps Distance Matrix API
        const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
        url.searchParams.append('origins', originStr);
        url.searchParams.append('destinations', destinationStr);
        url.searchParams.append('key', apiKey);
        url.searchParams.append('units', 'imperial'); // Use miles

        const response = await fetch(url.toString());
        
        if (!response.ok) {
          throw new Error(`API request failed with status ${response.status}`);
        }

        const data = await response.json();

        // Check for API errors
        if (data.status !== 'OK') {
          throw new Error(`Distance Matrix API error: ${data.status} - ${data.error_message || 'Unknown error'}`);
        }

        // Extract distance from the response
        const element = data.rows[0]?.elements[0];
        
        if (!element || element.status !== 'OK') {
          throw new Error(`Failed to calculate distance for segment ${i + 1}: ${element?.status || 'Unknown error'}`);
        }

        totalDistanceMeters += element.distance.value;
        totalDurationSeconds += element.duration.value;
      }

      // Convert meters to miles (1 meter = 0.000621371 miles)
      const totalMiles = totalDistanceMeters * 0.000621371;
      const totalHours = totalDurationSeconds / 3600;

      return {
        miles: Math.round(totalMiles * 100) / 100, // Round to 2 decimal places
        kilometers: Math.round((totalDistanceMeters / 1000) * 100) / 100,
        durationHours: Math.round(totalHours * 100) / 100,
        segments: args.stops.length - 1,
      };
    } catch (error) {
      console.error('Error calculating route distance:', error);
      throw new Error(`Failed to calculate route distance: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },
});

/**
 * Geocode an address to get coordinates
 * Useful for addresses that don't have lat/lng yet
 */
export const geocodeAddress = action({
  args: {
    address: v.string(),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    
    if (!apiKey) {
      throw new Error('Google Maps API key not configured');
    }

    try {
      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.searchParams.append('address', args.address);
      url.searchParams.append('key', apiKey);

      const response = await fetch(url.toString());
      
      if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}`);
      }

      const data = await response.json();

      if (data.status !== 'OK' || !data.results || data.results.length === 0) {
        throw new Error(`Geocoding failed: ${data.status} - ${data.error_message || 'No results found'}`);
      }

      const location = data.results[0].geometry.location;
      
      return {
        latitude: location.lat,
        longitude: location.lng,
        formattedAddress: data.results[0].formatted_address,
      };
    } catch (error) {
      console.error('Error geocoding address:', error);
      throw new Error(`Failed to geocode address: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },
});
