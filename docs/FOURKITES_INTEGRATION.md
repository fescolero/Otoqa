# FourKites Integration

This document describes the FourKites integration setup and configuration.

## Overview

The FourKites integration allows you to:
- Pull load data from FourKites into your system
- Sync shipment tracking information
- Configure sync intervals and settings

## Setup

### 1. Environment Variables

Add the following environment variables to your `.env.local` file:

```bash
FOURKITES_API_URL=https://api.fourkites.com/api/v1
FOURKITES_API_KEY=your-api-key-here  # Optional: for testing without user input
```

### 2. Database Schema

The integration uses the `orgIntegrations` table in Convex with the following structure:

- **workosOrgId**: Organization identifier from WorkOS
- **provider**: Integration provider name (e.g., 'fourkites')
- **credentials**: JSON string containing API credentials (encrypted in production)
- **syncSettings**: Configuration object for sync behavior
- **lastSyncStats**: Statistics from the last sync operation

### 3. Connecting FourKites

1. Navigate to **Organization Settings** > **Integrations**
2. Find **FourKites** under "Available Integrations"
3. Click **Connect**
4. Enter your FourKites API Key
5. Click **Test Connection** to verify credentials
6. Click **Connect** to save the integration

## Sync Settings

The integration supports the following sync settings:

```typescript
{
  "isEnabled": true,                     // Master switch for the integration
  "pull": {
    "loadsEnabled": true,                // Enable pulling load data
    "intervalMinutes": 300,              // Sync every 5 hours
    "lookbackWindowHours": 24            // Look back 24 hours for data
  },
  "push": {
    "gpsTrackingEnabled": false,         // Push GPS tracking data
    "driverAssignmentsEnabled": false    // Push driver assignments
  }
}
```

### Default Settings

When connecting FourKites for the first time, these defaults are applied:
- Pull loads: **Enabled**
- Sync interval: **300 minutes (5 hours)**
- Lookback window: **24 hours**
- GPS tracking push: **Disabled**
- Driver assignments push: **Disabled**

## API Endpoints

### Test Connection
`POST /api/integrations/fourkites/test`

Tests the FourKites API connection with provided credentials.

**Request Body:**
```json
{
  "apiKey": "your-api-key"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Connection successful! FourKites API credentials are valid."
}
```

**Response (Error):**
```json
{
  "success": false,
  "message": "Invalid API key. Please check your credentials."
}
```

## Convex Functions

### Query Functions

- `getIntegrations`: Get all integrations for an organization
- `getIntegrationByProvider`: Get a specific integration by provider name
- `getCredentials`: Get decrypted credentials (server-side only)

### Mutation Functions

- `upsertIntegration`: Create or update an integration
- `updateSyncSettings`: Update sync settings only
- `deleteIntegration`: Remove an integration
- `updateSyncStats`: Update last sync statistics

## Security Notes

**Important:** 
- Credentials are currently stored as plain text JSON strings
- Encryption will be implemented in a future update
- Never commit actual API keys to version control
- Use environment variables for testing purposes only

## Components

### FourKitesConnectModal
Location: `components/fourkites-connect-modal.tsx`

Modal dialog for connecting FourKites integration with:
- API key input field
- Connection test button
- Visual feedback for test results
- Form validation

### OrgSettingsTabs
Location: `components/org-settings-tabs.tsx`

Updated to include:
- Display of connected FourKites integration
- FourKites in available integrations (when not connected)
- Modal trigger for connection flow

## Future Enhancements

- [ ] Credential encryption at rest
- [ ] Advanced sync settings UI
- [ ] Sync history and logs
- [ ] Manual sync trigger
- [ ] Webhook support for real-time updates
- [ ] Multi-credential support for staging/production environments
- [ ] Integration health monitoring
- [ ] Detailed sync statistics dashboard
