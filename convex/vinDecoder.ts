import { action } from './_generated/server';
import { v } from 'convex/values';

// NHTSA VIN Decoder API integration
// https://vpic.nhtsa.dot.gov/api/

interface VINDecodeResponse {
  year?: number;
  make?: string;
  model?: string;
  engineManufacturer?: string;
  engineModel?: string;
  gvwr?: number;
  fuelType?: string;
}

export const decodeVIN = action({
  args: {
    vin: v.string(),
  },
  handler: async (_, args): Promise<VINDecodeResponse> => {
    const { vin } = args;

    // Validate VIN length (should be 17 characters)
    if (vin.length !== 17) {
      throw new Error('VIN must be exactly 17 characters');
    }

    try {
      const response = await fetch(
        `https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${vin}?format=json`
      );

      if (!response.ok) {
        throw new Error('Failed to decode VIN');
      }

      const data = await response.json();

      if (!data.Results || data.Results.length === 0) {
        throw new Error('No results found for this VIN');
      }

      // Parse the NHTSA response
      const results = data.Results;
      const getValue = (variableId: number): string | null => {
        const result = results.find((r: any) => r.VariableId === variableId);
        return result?.Value || null;
      };

      // Extract relevant fields
      // VariableIds from NHTSA documentation:
      // 29 = Model Year
      // 26 = Make
      // 28 = Model
      // 123 = Engine Manufacturer
      // 133 = Engine Model
      // 25 = GVWR (string, needs parsing)
      // 24 = Fuel Type - Primary

      const modelYearStr = getValue(29);
      const gvwrStr = getValue(25);

      const decodedData: VINDecodeResponse = {
        year: modelYearStr ? parseInt(modelYearStr, 10) : undefined,
        make: getValue(26) || undefined,
        model: getValue(28) || undefined,
        engineManufacturer: getValue(123) || undefined,
        engineModel: getValue(133) || undefined,
        gvwr: gvwrStr ? parseGVWR(gvwrStr) : undefined,
        fuelType: getValue(24) || undefined,
      };

      return decodedData;
    } catch (error) {
      console.error('VIN decode error:', error);
      throw new Error('Failed to decode VIN. Please check the VIN and try again.');
    }
  },
});

// Helper function to parse GVWR string (e.g., "Class 2E: 6,001 - 7,000 lb (2,722 - 3,175 kg)")
function parseGVWR(gvwrStr: string): number | undefined {
  // Try to extract the first number in pounds
  const match = gvwrStr.match(/(\d{1,3}(?:,\d{3})*)/);
  if (match) {
    const pounds = parseInt(match[1].replace(/,/g, ''), 10);
    return pounds;
  }
  return undefined;
}
