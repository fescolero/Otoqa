# Google Maps API Integration Setup Guide

This guide will help you set up Google Maps API for address autocomplete and distance calculation features.

## Prerequisites

- Google Cloud Platform account
- Billing enabled on your Google Cloud project

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable billing for the project

## Step 2: Enable Required APIs

Enable the following APIs in your Google Cloud project:

1. Go to **APIs & Services** > **Library**
2. Search for and enable each of the following:
   - **Places API** - For address autocomplete
   - **Distance Matrix API** - For route distance calculation
   - **Geocoding API** - For address-to-coordinate conversion

## Step 3: Create API Keys

1. Go to **APIs & Services** > **Credentials**
2. Click **+ CREATE CREDENTIALS** > **API key**
3. Copy the generated API key
4. (Recommended) Click **Edit API key** to add restrictions:
   - **Application restrictions**: HTTP referrers (for client-side key)
   - **API restrictions**: Select the three APIs mentioned above

### Create Two API Keys

You need two API keys:

1. **Client-side key** (`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`)
   - Restricted to your domain (e.g., `localhost:3000`, `yourdomain.com`)
   - Used for Places Autocomplete API in the browser

2. **Server-side key** (`GOOGLE_MAPS_API_KEY`)
   - Restricted to specific APIs (Distance Matrix, Geocoding)
   - Used for backend distance calculations in Convex actions

## Step 4: Add API Keys to Your Project

1. Copy `.env.local.example` to `.env.local` (if you haven't already)
2. Add your API keys to `.env.local`:

```bash
# Google Maps API Configuration
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=your_client_side_api_key_here
GOOGLE_MAPS_API_KEY=your_server_side_api_key_here
```

3. Deploy the environment variable to Convex:

```bash
npx convex env set GOOGLE_MAPS_API_KEY your_server_side_api_key_here
```

## Step 5: Verify Setup

1. Start your development server:
   ```bash
   npm run dev
   ```

2. Navigate to **Loads** > **Create Load**
3. Try typing an address in the address field - you should see autocomplete suggestions
4. Add at least 2 stops with addresses
5. Click **Calculate Miles** - the distance should be calculated automatically

## API Pricing

### Free Tier
Google provides $200 of free usage per month, which includes approximately:
- **70,000** Places Autocomplete requests
- **40,000** Distance Matrix requests

### Pricing (after free tier)
- **Places Autocomplete**: $2.83 per 1,000 requests
- **Distance Matrix**: $5.00 per 1,000 requests
- **Geocoding**: $5.00 per 1,000 requests

## Cost Optimization Tips

1. **Debouncing**: The autocomplete component debounces input by 300ms to reduce API calls
2. **Minimum input length**: Autocomplete only triggers after 3 characters
3. **Graceful degradation**: If API is unavailable, users can still enter addresses manually
4. **Distance calculation on-demand**: Users must click "Calculate Miles" - it doesn't auto-calculate

## Troubleshooting

### "Google Maps API key not configured" error
- Verify that both API keys are set in `.env.local`
- For server-side errors, ensure you've deployed the key to Convex:
  ```bash
  npx convex env set GOOGLE_MAPS_API_KEY your_key
  ```

### Address autocomplete not working
- Check browser console for errors
- Verify the client-side key (`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`) is set correctly
- Ensure Places API is enabled in Google Cloud Console
- Check API key restrictions aren't blocking your domain

### Distance calculation failing
- Verify Convex environment variable is set: `npx convex env list`
- Ensure Distance Matrix API is enabled
- Check that all stops have valid lat/lng coordinates
- Review Convex logs for detailed error messages

## Features

### Address Autocomplete
- **Design**: Uses shadcn/ui Combobox component for consistent UI
- **User-friendly**: Field always displays immediately (no API wait)
- **Graceful fallback**: Works offline - users can enter addresses manually
- **Loading states**: Shows spinner while fetching suggestions
- **Structured data**: Extracts street, city, state, postal code, lat/lng

### Distance Calculation
- **Multi-stop support**: Calculates total distance across all stops in sequence
- **Validation**: Ensures all stops have coordinates before calculating
- **Duration included**: Shows estimated travel time
- **Visual feedback**: Displays calculated miles prominently
- **Error handling**: Clear error messages if calculation fails

### Route Map (Dispatch Planner)
- **Location**: `components/dispatch/planner/route-map.tsx`
- **Purpose**: Visual display of load route in the Intelligence Sidebar
- **Features**:
  - Shows pickup (green) and delivery (red) markers
  - Draws driving route between stops
  - Auto-fits bounds to show all stops
  - Uses Google's official `@vis.gl/react-google-maps` library
  - Graceful fallback when API key not configured or no coordinates
- **APIs Used**:
  - Maps JavaScript API
  - Directions API (for route polyline)
- **Integration**: Used in `DecisionSupportView` when a load is selected

## Support

For issues with the Google Maps integration:
1. Check the [Google Maps Platform documentation](https://developers.google.com/maps/documentation)
2. Review API usage in [Google Cloud Console](https://console.cloud.google.com/)
3. Check application logs for detailed error messages
