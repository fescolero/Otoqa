/**
 * FourKites API Client
 * Used by the sync worker to fetch shipment data from FourKites API
 */

const FOURKITES_API_URL = process.env.FOURKITES_API_URL || 'https://api.fourkites.com/shipments';

export interface FourKitesAuthCredentials {
  apiKey?: string;
  username?: string;
  password?: string;
  clientSecret?: string;
  accessToken?: string;
}

interface FourKitesShipment {
  id: string;
  hcr?: string; // Extracted from referenceNumbers
  trip?: string; // Extracted from referenceNumbers
  status: string;
  updated_at: string;
  loadNumber?: string; // Used for orderNumber
  weight?: number;
  quantity?: number;
  commodity?: string;
  shipper_name?: string;
  purchase_order_number?: string;
  stops: Array<{
    fourKitesStopID?: string;
    id?: string;
    sequence?: number;
    stopType?: string;
    stopName?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    latitude?: number;
    longitude?: number;
    timeZone?: string;
    schedule?: {
      appointmentTime?: string;
    };
    pallets?: Array<{
      parts?: Array<{
        quantity?: string;
      }>;
    }>;
  }>;
  identifiers?: {
    referenceNumbers?: string[]; // Array of strings like ["108", "917DK", "CarrierCode:000227710"]
  };
  [key: string]: any; // Allow additional fields
}

function buildBaseHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.fourkites.v1+json',
    'Content-Type': 'application/json',
  };
}

function buildBasicAuthHeader(username: string, password: string): string {
  const encoded = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${encoded}`;
}

function getShipmentsUrl(): string {
  const parsed = new URL(FOURKITES_API_URL);
  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/shipments')) {
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/shipments`;
  }
  return parsed.toString();
}

function getOauthTokenUrl(): string {
  const parsed = new URL(getShipmentsUrl());
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/oauth2/token`;
  return parsed.toString();
}

async function getOauthAccessToken(credentials: FourKitesAuthCredentials): Promise<string> {
  const apiKey = credentials.apiKey?.trim();
  const clientSecret = credentials.clientSecret?.trim();

  if (!apiKey || !clientSecret) {
    throw new Error('OAuth2 requires apiKey and clientSecret');
  }

  const tokenResponse = await fetch(getOauthTokenUrl(), {
    method: 'POST',
    headers: {
      ...buildBaseHeaders(),
      apikey: apiKey,
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: apiKey,
      client_secret: clientSecret,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(
      `FourKites OAuth Error (${tokenResponse.status}): ${tokenResponse.statusText} - ${errorText}`
    );
  }

  const tokenData = await tokenResponse.json();
  const accessToken = tokenData?.access_token;
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('FourKites OAuth token response missing access_token');
  }

  return accessToken;
}

async function buildAuthHeaders(credentials: FourKitesAuthCredentials): Promise<Record<string, string>> {
  const headers = buildBaseHeaders();
  const apiKey = credentials.apiKey?.trim();
  const username = credentials.username?.trim();
  const password = credentials.password?.trim();
  const clientSecret = credentials.clientSecret?.trim();
  const providedAccessToken = credentials.accessToken?.trim();

  if (apiKey) {
    headers.apikey = apiKey;
  }

  if (providedAccessToken) {
    headers.Authorization = `Bearer ${providedAccessToken}`;
    return headers;
  }

  if (apiKey && clientSecret) {
    const oauthAccessToken = await getOauthAccessToken(credentials);
    headers.Authorization = `Bearer ${oauthAccessToken}`;
    return headers;
  }

  if (username && password) {
    headers.Authorization = buildBasicAuthHeader(username, password);
    return headers;
  }

  if (apiKey) {
    return headers;
  }

  throw new Error(
    'Missing FourKites credentials. Provide apiKey, username/password, or apiKey + clientSecret.'
  );
}

/**
 * Maps FourKites shipment fields to our expected format
 * Extracts HCR and Trip from identifiers.referenceNumbers array
 */
function mapShipmentFields(rawShipment: any): FourKitesShipment {
  const mapped = { ...rawShipment };
  
  // Extract HCR and Trip from referenceNumbers
  // referenceNumbers is an array of strings: ["108", "917DK", "CarrierCode:000227710"]
  // HEURISTIC: Based on observed data, Trip typically comes FIRST, HCR comes SECOND
  if (rawShipment.identifiers?.referenceNumbers && Array.isArray(rawShipment.identifiers.referenceNumbers)) {
    const refs = rawShipment.identifiers.referenceNumbers;
    
    // Filter out invalid entries (colons, empty strings)
    const validRefs = refs.filter(
      (ref: any) => typeof ref === 'string' && ref.trim() && !ref.includes(':')
    ).map((ref: string) => ref.trim());
    
    // Strategy: Use array position as primary heuristic
    // Index 0 = Trip, Index 1 = HCR
    if (validRefs.length >= 2) {
      mapped.trip = validRefs[0];
      mapped.hcr = validRefs[1];
    } else if (validRefs.length === 1) {
      // Only one value - try to guess if it's HCR or Trip
      const val = validRefs[0];
      // Short numeric = likely Trip
      if (/^\d{1,4}$/.test(val)) {
        mapped.trip = val;
      } else {
        // Everything else = likely HCR
        mapped.hcr = val;
      }
    }
  }
  
  // Map other common field names
  mapped.id = rawShipment.fourKitesShipmentID || rawShipment.id;
  mapped.updated_at = rawShipment.updatedAt || rawShipment.updated_at;
  mapped.loadNumber = rawShipment.loadNumber; // For orderNumber field
  
  return mapped as FourKitesShipment;
}

/**
 * Fetches shipments from FourKites API with pagination support
 * 
 * IMPORTANT: FourKites does NOT support time-based filtering in the API.
 * This function fetches ALL shipments and then filters client-side by updated_at.
 * 
 * For production with thousands of shipments, consider:
 * 1. Fetching only first N pages
 * 2. Using idempotency check (lastExternalUpdatedAt) to skip unchanged loads
 * 3. Running sync less frequently for large organizations
 * 
 * @param apiKey - FourKites API key
 * @param startTime - ISO 8601 timestamp for client-side filtering
 * @returns Array of shipments updated after startTime
 */
export async function fetchShipments(
  credentials: FourKitesAuthCredentials,
  startTime: string
): Promise<FourKitesShipment[]> {
  const allShipments: FourKitesShipment[] = [];
  let currentPage = 1;
  const perPage = 100; // Max page size for efficiency
  let totalCount = 0;
  let totalPages = 0;

  try {
    const authHeaders = await buildAuthHeaders(credentials);

    // First request to get totalCount
    const firstUrl = new URL(getShipmentsUrl());
    firstUrl.searchParams.append('page', '1');
    firstUrl.searchParams.append('perPage', perPage.toString());

    const firstResponse = await fetch(firstUrl.toString(), {
      method: 'GET',
      headers: authHeaders,
    });

    if (!firstResponse.ok) {
      const errorText = await firstResponse.text();
      throw new Error(
        `FourKites API Error (${firstResponse.status}): ${firstResponse.statusText} - ${errorText}`
      );
    }

    const firstData = await firstResponse.json();
    
    // Debug: Log response structure
    console.log('FourKites API Response Type:', typeof firstData);
    console.log('Is Array?', Array.isArray(firstData));
    if (firstData && typeof firstData === 'object') {
      console.log('Response Keys:', Object.keys(firstData));
      if (firstData.data) {
        console.log('data property type:', typeof firstData.data);
        console.log('data is Array?', Array.isArray(firstData.data));
        console.log('data length:', Array.isArray(firstData.data) ? firstData.data.length : 'N/A');
        if (Array.isArray(firstData.data) && firstData.data.length > 0) {
          console.log('First shipment sample:', JSON.stringify(firstData.data[0]).substring(0, 200));
        }
      }
    }
    
    // Extract shipments and metadata
    // FourKites API returns: { data: { shipments: [...], page, perPage, totalCount }, requestId }
    let shipments: any[];
    if (firstData && firstData.data && Array.isArray(firstData.data.shipments)) {
      // FourKites standard format - data.shipments is the array
      shipments = firstData.data.shipments;
      // Get pagination metadata from data object
      totalCount = firstData.data.totalCount || 0;
    } else if (Array.isArray(firstData)) {
      shipments = firstData;
    } else if (firstData && Array.isArray(firstData.data)) {
      shipments = firstData.data;
    } else if (firstData && Array.isArray(firstData.shipments)) {
      shipments = firstData.shipments;
    } else {
      console.error('Unexpected FourKites API response format. First 500 chars:', JSON.stringify(firstData).substring(0, 500));
      shipments = [];
    }
    
    if (shipments.length > 0) {
      // Map FourKites fields to our expected format
      const mappedShipments = shipments.map(mapShipmentFields);
      allShipments.push(...mappedShipments);
    }

    // Get totalCount from response (may already be set above)
    if (totalCount === 0) {
      totalCount = firstData.totalCount || firstData.total || 0;
    }
    
    // Calculate total pages
    if (totalCount > 0) {
      totalPages = Math.ceil(totalCount / perPage);
    } else {
      // If no totalCount in response, assume we got all data if less than perPage
      totalPages = shipments.length < perPage ? 1 : 10; // Default to 10 pages max
    }

    console.log(`FourKites: Page 1/${totalPages}, Total: ${totalCount}, Fetched: ${shipments.length}`);

    // Fetch remaining pages
    for (currentPage = 2; currentPage <= totalPages; currentPage++) {
      const url = new URL(getShipmentsUrl());
      url.searchParams.append('page', currentPage.toString());
      url.searchParams.append('perPage', perPage.toString());

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: authHeaders,
      });

      if (!response.ok) {
        console.error(`Failed to fetch page ${currentPage}: ${response.status}`);
        break; // Continue with what we have
      }

      const data = await response.json();
      // FourKites API returns: { data: { shipments: [...] }, requestId }
      let pageShipments: any[];
      if (data && data.data && Array.isArray(data.data.shipments)) {
        pageShipments = data.data.shipments;
      } else if (Array.isArray(data)) {
        pageShipments = data;
      } else if (data && Array.isArray(data.data)) {
        pageShipments = data.data;
      } else if (data && Array.isArray(data.shipments)) {
        pageShipments = data.shipments;
      } else {
        pageShipments = [];
      }
      
      if (pageShipments.length === 0) {
        break; // No more data
      }

      // Map FourKites fields to our expected format
      const mappedPageShipments = pageShipments.map(mapShipmentFields);
      allShipments.push(...mappedPageShipments);
      console.log(`FourKites: Page ${currentPage}/${totalPages}, Fetched: ${pageShipments.length}`);
      
      // Debug: Log first shipment HCR/Trip extraction on page 2
      if (currentPage === 2 && mappedPageShipments.length > 0) {
        const sample = mappedPageShipments[0];
        console.log(`Sample mapping - HCR: ${sample.hcr}, Trip: ${sample.trip}, ID: ${sample.id}`);
      }

      // Safety: Prevent infinite loops
      if (currentPage > 100) {
        console.warn('FourKites pagination exceeded 100 pages. Stopping.');
        break;
      }
    }

    console.log(`Fetched ${allShipments.length} total shipments from FourKites (${totalPages} pages)`);

    // Client-side filtering by time (since FourKites API doesn't support it)
    const startTimeMs = new Date(startTime).getTime();
    const filteredShipments = allShipments.filter((shipment) => {
      if (!shipment.updated_at) return true; // Include if no timestamp
      const updatedAtMs = new Date(shipment.updated_at).getTime();
      return updatedAtMs >= startTimeMs;
    });

    console.log(`After time filtering: ${filteredShipments.length} shipments (${allShipments.length - filteredShipments.length} filtered out)`);
    return filteredShipments;

  } catch (error) {
    console.error('Error fetching FourKites shipments:', error);
    throw error;
  }
}

/**
 * Test connection to FourKites API
 * Used during initial setup/testing
 */
export async function testConnection(apiKey: string): Promise<boolean> {
  try {
    const headers = await buildAuthHeaders({ apiKey });
    const testUrl = new URL(getShipmentsUrl());
    testUrl.searchParams.append('page', '1');
    testUrl.searchParams.append('perPage', '1');

    const response = await fetch(testUrl.toString(), {
      method: 'GET',
      headers,
    });

    return response.ok || response.status === 404; // 404 with valid auth is OK
  } catch (error) {
    console.error('FourKites connection test failed:', error);
    return false;
  }
}
