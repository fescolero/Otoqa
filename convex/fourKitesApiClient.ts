/**
 * FourKites API Client
 * Used by the sync worker to fetch shipment data from FourKites API
 */

import { parseShipmentsResponse } from './fourKitesUtils';

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
  hcr?: string; // Extracted from referenceNumbers via pattern classifier
  trip?: string; // Extracted from referenceNumbers via pattern classifier
  /**
   * The full referenceNumbers array as received, preserved so downstream
   * code (custom per-org facets, future filters) can inspect tokens that
   * weren't classified as HCR or Trip without re-fetching from FourKites.
   */
  referenceNumbers?: string[];
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
    referenceNumbers?: string[];
  };
  [key: string]: any; // Allow additional fields
}

/**
 * Classify a single referenceNumbers token as HCR, TRIP, or junk.
 *
 * Exported for unit tests and reused by the cleanup migration so that
 * "what counts as junk" stays defined in exactly one place.
 *
 * Patterns derived from real production data (~19K loads, 9 distinct HCRs):
 *
 *   HCR shapes:
 *     - 3+ digits + letters + optional digits  (917DK, 952L5, 925L0, 945L4)
 *     - 5+ pure digits                          (95236, 95632, 96036)
 *
 *   TRIP shapes:
 *     - 1-4 pure digits                         (108, 1, 205, 8)
 *     - 1-4 letters + 1-3 digits                (FOR2, T01)
 *     - 4-8 pure letters                        (FMTXT)
 *
 *   Junk markers:
 *     - contains `_`                            (BTF_DIESEL)
 *     - contains `.`                            (88.5)
 *     - contains `:`                            (CarrierCode:000227710)
 *     - 1-3 letter pure-letter abbreviation     (MPG, AB, FG)
 *     - known junk words                        (DIESEL, FUEL, GAS)
 *
 * The 4+ letter pure-letter TRIP branch is real: FMTXT is a valid Trip
 * code in production. We reject short (1-3 letter) pure-letter tokens
 * because those are overwhelmingly unit abbreviations (MPG, PSI, RPM),
 * plus maintain a small denylist for longer known junk words.
 */
export type RefTokenKind = 'HCR' | 'TRIP' | null;

// Tokens longer than 3 letters that are definitively junk despite
// matching the pure-letter TRIP pattern. Extend as more are discovered.
const KNOWN_JUNK_WORDS = new Set(['DIESEL', 'FUEL', 'GAS', 'GASOLINE']);

export function classifyRefToken(rawToken: unknown): RefTokenKind {
  if (typeof rawToken !== 'string') return null;
  const t = rawToken.trim().toUpperCase();
  if (!t || t === '*') return null;
  if (t.includes(':')) return null; // CarrierCode:..., etc.
  if (/[_.]/.test(t)) return null; // BTF_DIESEL, 88.5
  if (/^[A-Z]{1,3}$/.test(t)) return null; // MPG, AB — short abbreviations
  if (KNOWN_JUNK_WORDS.has(t)) return null; // DIESEL, FUEL

  // HCR — order matters: more specific patterns first
  if (/^\d{3,}[A-Z]+\d*$/.test(t)) return 'HCR'; // 917DK, 952L5, 925L0
  if (/^\d{5,}$/.test(t)) return 'HCR';           // 95236, 96036

  // TRIP
  if (/^\d{1,4}$/.test(t)) return 'TRIP';         // 108, 8, 205
  if (/^[A-Z]{1,4}\d{1,3}$/.test(t)) return 'TRIP'; // FOR2, T01
  if (/^[A-Z]{4,8}$/.test(t)) return 'TRIP';      // FMTXT

  return null;
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
 * Maps FourKites shipment fields to our expected format.
 *
 * Pattern-based classifier: every referenceNumbers token is independently
 * classified by shape (see classifyRefToken). The first HCR-shaped token
 * wins; the first TRIP-shaped token wins. Position is no longer relied on
 * — the previous `validRefs[0] = trip, validRefs[1] = hcr` heuristic
 * mis-classified loads whose payloads led with extra metadata tokens
 * (e.g. `["BTF_DIESEL", "MPG", "FOR2", "88.5", "95236", "CarrierCode:..."]`
 * for "Unplanned Volume" loads, where the real HCR is "95236" and Trip
 * is "FOR2", not "BTF_DIESEL"/"MPG").
 *
 * Also preserves the raw referenceNumbers array on the mapped shipment
 * so downstream sync code can persist it for future custom-facet
 * extraction without re-fetching from FourKites.
 */
function mapShipmentFields(rawShipment: any): FourKitesShipment {
  const mapped = { ...rawShipment };

  if (
    rawShipment.identifiers?.referenceNumbers &&
    Array.isArray(rawShipment.identifiers.referenceNumbers)
  ) {
    const refs: unknown[] = rawShipment.identifiers.referenceNumbers;
    let hcr: string | undefined;
    let trip: string | undefined;
    for (const ref of refs) {
      const kind = classifyRefToken(ref);
      if (kind === 'HCR' && hcr === undefined) {
        hcr = (ref as string).trim();
      } else if (kind === 'TRIP' && trip === undefined) {
        trip = (ref as string).trim();
      }
      if (hcr && trip) break;
    }
    if (hcr) mapped.hcr = hcr;
    if (trip) mapped.trip = trip;

    // Preserve the full raw array (filtered to strings) so the sync
    // helper can persist it onto loadInformation. Future per-org facets
    // can mine this without changing the FourKites integration.
    mapped.referenceNumbers = refs.filter(
      (r): r is string => typeof r === 'string',
    );
  }

  mapped.id = rawShipment.fourKitesShipmentID || rawShipment.id;
  mapped.updated_at = rawShipment.updatedAt || rawShipment.updated_at;
  mapped.loadNumber = rawShipment.loadNumber;

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
    
    // Extract shipments and metadata via shared parser (handles all FK
    // response shapes: { data: { shipments } }, { data: [] }, { shipments },
    // raw array). Single source of truth lives in fourKitesUtils.
    const parsed = parseShipmentsResponse(firstData);
    const shipments = parsed.shipments;
    totalCount = parsed.totalCount;

    if (shipments.length === 0) {
      console.error(
        'Unexpected FourKites API response format. First 500 chars:',
        JSON.stringify(firstData).substring(0, 500),
      );
    } else {
      const mappedShipments = shipments.map(mapShipmentFields);
      allShipments.push(...mappedShipments);
    }

    if (totalCount === 0) {
      totalCount = firstData?.totalCount || firstData?.total || 0;
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
      const pageShipments = parseShipmentsResponse(data).shipments;

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
