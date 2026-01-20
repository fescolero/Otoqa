let autocompleteService: google.maps.places.AutocompleteService | null = null;
let placesService: google.maps.places.PlacesService | null = null;
let geocoder: google.maps.Geocoder | null = null;
let isLoaded = false;
let loadPromise: Promise<void> | null = null;

// Cache for timezone lookups to avoid redundant API calls
const timezoneCache: Map<string, string> = new Map();

/**
 * Initialize Google Maps API by loading the script tag
 */
async function loadGoogleMaps(): Promise<void> {
  // Return existing promise if already loading
  if (loadPromise) return loadPromise;
  if (isLoaded) return Promise.resolve();

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  
  console.log('🗺️ Google Maps API - Initializing...');
  console.log('🔑 API Key present:', apiKey ? `Yes (${apiKey.substring(0, 10)}...)` : 'No');
  
  if (!apiKey) {
    const error = 'Google Maps API key not configured. Please set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY in .env.local';
    console.error('❌', error);
    throw new Error(error);
  }

  // Check if already loaded
  if (window.google && window.google.maps && window.google.maps.places) {
    console.log('✅ Google Maps API already loaded!');
    isLoaded = true;
    return Promise.resolve();
  }

  loadPromise = new Promise<void>((resolve, reject) => {
    try {
      console.log('📚 Loading Google Maps script...');
      
      // Create and append the script tag
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&v=weekly`;
      script.async = true;
      script.defer = true;
      
      script.onload = () => {
        isLoaded = true;
        console.log('✅ Google Maps API loaded successfully!');
        resolve();
      };
      
      script.onerror = (error) => {
        console.error('❌ Failed to load Google Maps script:', error);
        loadPromise = null;
        reject(new Error('Failed to load Google Maps script'));
      };
      
      document.head.appendChild(script);
    } catch (error) {
      console.error('❌ Failed to load Google Maps API:', error);
      loadPromise = null;
      reject(error);
    }
  });

  return loadPromise;
}

/**
 * Get autocomplete predictions for an address input
 */
export async function getAddressPredictions(
  input: string,
  options?: {
    types?: string[];
    componentRestrictions?: google.maps.places.ComponentRestrictions;
  }
): Promise<google.maps.places.AutocompletePrediction[]> {
  try {
    await loadGoogleMaps();

    if (!autocompleteService) {
      autocompleteService = new google.maps.places.AutocompleteService();
    }

    return new Promise((resolve, reject) => {
      if (!input || input.length < 3) {
        resolve([]);
        return;
      }

      autocompleteService!.getPlacePredictions(
        {
          input,
          types: options?.types || ['address'],
          componentRestrictions: options?.componentRestrictions,
        },
        (predictions, status) => {
          if (status === google.maps.places.PlacesServiceStatus.OK && predictions) {
            resolve(predictions);
          } else if (status === google.maps.places.PlacesServiceStatus.ZERO_RESULTS) {
            resolve([]);
          } else {
            console.error('Places autocomplete error:', status);
            resolve([]);
          }
        }
      );
    });
  } catch (error) {
    console.error('Error fetching address predictions:', error);
    return [];
  }
}

/**
 * Get detailed information about a place using its place ID
 * Includes timezone lookup for the location
 */
export async function getPlaceDetails(
  placeId: string
): Promise<{
  address: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude: number;
  longitude: number;
  formattedAddress: string;
  timeZone?: string; // IANA timezone (e.g., "America/Los_Angeles")
} | null> {
  try {
    await loadGoogleMaps();

    // Create a hidden div for PlacesService (it requires a map or div element)
    if (!placesService) {
      const div = document.createElement('div');
      placesService = new google.maps.places.PlacesService(div);
    }

    // First, get place details from Google Places API
    const placeData = await new Promise<{
      address: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
      latitude: number;
      longitude: number;
      formattedAddress: string;
    } | null>((resolve) => {
      placesService!.getDetails(
        {
          placeId,
          fields: ['address_components', 'geometry', 'formatted_address'],
        },
        (place, status) => {
          if (status === google.maps.places.PlacesServiceStatus.OK && place) {
            const addressComponents = place.address_components || [];
            
            // Extract address components
            let streetNumber = '';
            let route = '';
            let city = '';
            let state = '';
            let postalCode = '';
            let country = '';

            addressComponents.forEach((component) => {
              const types = component.types;
              
              if (types.includes('street_number')) {
                streetNumber = component.long_name;
              }
              if (types.includes('route')) {
                route = component.long_name;
              }
              if (types.includes('locality')) {
                city = component.long_name;
              }
              if (types.includes('administrative_area_level_1')) {
                state = component.short_name;
              }
              if (types.includes('postal_code')) {
                postalCode = component.long_name;
              }
              if (types.includes('country')) {
                country = component.long_name;
              }
            });

            // Fallback: Extract country from formatted address if not found in components
            if (!country && place.formatted_address) {
              const parts = place.formatted_address.split(',');
              if (parts.length > 0) {
                const lastPart = parts[parts.length - 1].trim();
                if (lastPart === 'USA' || lastPart.includes('United States')) {
                  country = 'United States';
                } else if (lastPart.length <= 50) {
                  country = lastPart;
                }
              }
            }

            const address = `${streetNumber} ${route}`.trim();
            const latitude = place.geometry?.location?.lat() || 0;
            const longitude = place.geometry?.location?.lng() || 0;

            resolve({
              address,
              city,
              state,
              postalCode,
              country,
              latitude,
              longitude,
              formattedAddress: place.formatted_address || '',
            });
          } else {
            console.error('Place details error:', status);
            resolve(null);
          }
        }
      );
    });

    if (!placeData) {
      return null;
    }

    // Now fetch timezone separately (this is async)
    let timeZone: string | undefined;
    if (placeData.latitude && placeData.longitude) {
      timeZone = await getTimezoneFromCoordinates(placeData.latitude, placeData.longitude) || undefined;
    }

    // Debug logging
    console.log('🗺️ Place Details Extracted:', {
      ...placeData,
      timeZone,
    });

    return {
      ...placeData,
      timeZone,
    };
  } catch (error) {
    console.error('Error fetching place details:', error);
    return null;
  }
}

/**
 * Geocode an address string to get coordinates
 */
export async function geocodeAddress(
  address: string
): Promise<{ latitude: number; longitude: number } | null> {
  try {
    await loadGoogleMaps();

    if (!geocoder) {
      geocoder = new google.maps.Geocoder();
    }

    return new Promise((resolve, reject) => {
      geocoder!.geocode({ address }, (results, status) => {
        if (status === 'OK' && results && results[0]) {
          const location = results[0].geometry.location;
          resolve({
            latitude: location.lat(),
            longitude: location.lng(),
          });
        } else {
          console.error('Geocoding error:', status);
          resolve(null);
        }
      });
    });
  } catch (error) {
    console.error('Error geocoding address:', error);
    return null;
  }
}

/**
 * Get timezone for a location using Google Time Zone API
 * Returns IANA timezone identifier (e.g., "America/Los_Angeles")
 * Falls back gracefully if API is not enabled or fails
 */
export async function getTimezoneFromCoordinates(
  latitude: number,
  longitude: number
): Promise<string | null> {
  // Check cache first
  const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  if (timezoneCache.has(cacheKey)) {
    return timezoneCache.get(cacheKey)!;
  }

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ Google Maps API key not configured for timezone lookup');
    return null;
  }

  try {
    // Use current timestamp for timezone calculation
    const timestamp = Math.floor(Date.now() / 1000);
    const url = `https://maps.googleapis.com/maps/api/timezone/json?location=${latitude},${longitude}&timestamp=${timestamp}&key=${apiKey}`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      console.warn('⚠️ Timezone API request failed:', response.status);
      return null;
    }
    
    const data = await response.json();

    if (data.status === 'OK' && data.timeZoneId) {
      console.log('🕐 Timezone lookup:', { latitude, longitude, timezone: data.timeZoneId });
      timezoneCache.set(cacheKey, data.timeZoneId);
      return data.timeZoneId;
    } else if (data.status === 'REQUEST_DENIED') {
      // API not enabled - log once and continue without timezone
      console.warn('⚠️ Time Zone API not enabled. Enable it at: https://console.cloud.google.com/apis/library/timezone-backend.googleapis.com');
      console.warn('   Stops will be saved without timezone - times will be stored as HH:mm format.');
      return null;
    } else {
      console.warn('⚠️ Timezone API returned:', data.status, data.errorMessage || '');
      return null;
    }
  } catch (error) {
    // Network error or other issue - fail gracefully
    console.warn('⚠️ Timezone lookup failed (will continue without timezone):', error);
    return null;
  }
}

/**
 * Convert a date and time to a full ISO string with timezone offset
 * @param date - Date in YYYY-MM-DD format
 * @param time - Time in HH:mm format (24-hour)
 * @param ianaTimezone - IANA timezone (e.g., "America/Los_Angeles")
 * @returns Full ISO string like "2026-01-08T12:25:00-08:00"
 */
export function createISOStringWithTimezone(
  date: string,
  time: string,
  ianaTimezone: string
): string {
  // Create a date object in the specified timezone
  const dateTimeStr = `${date}T${time}:00`;
  
  // Get the timezone offset for this specific date/time
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaTimezone,
    timeZoneName: 'longOffset',
  });
  
  // Parse to get the offset
  const parts = formatter.formatToParts(new Date(dateTimeStr));
  const offsetPart = parts.find(p => p.type === 'timeZoneName');
  
  if (offsetPart) {
    // Convert "GMT-08:00" to "-08:00"
    const offsetMatch = offsetPart.value.match(/GMT([+-]\d{2}):?(\d{2})?/);
    if (offsetMatch) {
      const hours = offsetMatch[1];
      const minutes = offsetMatch[2] || '00';
      return `${dateTimeStr}${hours}:${minutes}`;
    }
  }
  
  // Fallback: use the date/time without offset
  console.warn('Could not determine timezone offset, using UTC');
  return `${dateTimeStr}Z`;
}
