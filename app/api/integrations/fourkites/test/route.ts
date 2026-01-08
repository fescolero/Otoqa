import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';

const FOURKITES_API_URL = process.env.FOURKITES_API_URL || 'https://api.fourkites.com';

export async function POST(req: NextRequest) {
  try {
    const { user } = await withAuth();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { apiKey } = body;

    if (!apiKey) {
      return NextResponse.json({ error: 'API key is required' }, { status: 400 });
    }

    // Test the FourKites API connection
    // Using a simple endpoint to validate credentials
    const response = await fetch(`${FOURKITES_API_URL}/shipments`, {
      method: 'GET',
      headers: {
        'apikey': apiKey,
        'Accept': 'application/vnd.fourkites.v1+json',
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      return NextResponse.json({
        success: true,
        message: 'Connection successful! FourKites API credentials are valid.',
      });
    } else if (response.status === 401 || response.status === 403) {
      return NextResponse.json(
        {
          success: false,
          message: 'Invalid API key. Please check your credentials.',
        },
        { status: 401 },
      );
    } else if (response.status === 404) {
      // 404 with proper FourKites error response means API key is valid
      // (invalid keys would return 401/403)
      try {
        const errorData = await response.json();
        if (errorData.errorCode && errorData.requestId) {
          // This is a valid FourKites API response, just endpoint not found
          return NextResponse.json({
            success: true,
            message: 'Connection successful! FourKites API credentials are valid.',
          });
        }
      } catch (e) {
        // Not a JSON response, treat as actual error
      }
      return NextResponse.json(
        {
          success: false,
          message: 'Endpoint not found. API key may be valid but endpoint is incorrect.',
        },
        { status: 404 },
      );
    } else {
      const errorText = await response.text();
      return NextResponse.json(
        {
          success: false,
          message: `Connection failed: ${response.statusText}`,
          details: errorText,
        },
        { status: response.status },
      );
    }
  } catch (error) {
    console.error('Error testing FourKites connection:', error);
    return NextResponse.json(
      {
        success: false,
        message: 'Failed to test connection. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
