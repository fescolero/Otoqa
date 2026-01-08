let autocompleteService: google.maps.places.AutocompleteService | null = null;
let placesService: google.maps.places.PlacesService | null = null;
let geocoder: google.maps.Geocoder | null = null;
let isLoaded = false;
let loadPromise: Promise<void> | null = null;

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
} | null> {
  try {
    await loadGoogleMaps();

    // Create a hidden div for PlacesService (it requires a map or div element)
    if (!placesService) {
      const div = document.createElement('div');
      placesService = new google.maps.places.PlacesService(div);
    }

    return new Promise((resolve, reject) => {
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
              // Formatted address typically ends with country (e.g., "..., USA" or "..., United States")
              const parts = place.formatted_address.split(',');
              if (parts.length > 0) {
                const lastPart = parts[parts.length - 1].trim();
                // Common country codes/names
                if (lastPart === 'USA' || lastPart.includes('United States')) {
                  country = 'United States';
                } else if (lastPart.length <= 50) { // Reasonable country name length
                  country = lastPart;
                }
              }
            }

            const address = `${streetNumber} ${route}`.trim();
            const latitude = place.geometry?.location?.lat() || 0;
            const longitude = place.geometry?.location?.lng() || 0;

            // Debug logging
            console.log('🗺️ Place Details Extracted:', {
              address,
              city,
              state,
              postalCode,
              country,
              formattedAddress: place.formatted_address,
            });

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
