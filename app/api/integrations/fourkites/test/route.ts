import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';

const FOURKITES_API_URL = process.env.FOURKITES_API_URL || 'https://api.fourkites.com';

function buildBasicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function getOauthTokenUrl(): string {
  const base = new URL(FOURKITES_API_URL);
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/shipments')) {
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/shipments`;
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/oauth2/token`;
  return base.toString();
}

function getShipmentsUrl(): string {
  const base = new URL(FOURKITES_API_URL);
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/shipments')) {
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/shipments`;
  }
  return base.toString();
}

export async function POST(req: NextRequest) {
  try {
    const { user } = await withAuth();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password.trim() : '';
    const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
    const accessToken = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';

    if (!apiKey && !(username && password) && !(apiKey && clientSecret) && !accessToken) {
      return NextResponse.json(
        { error: 'Provide API key, username/password, or OAuth credentials.' },
        { status: 400 },
      );
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.fourkites.v1+json',
      'Content-Type': 'application/json',
    };
    let authMode = 'api_key';

    if (apiKey) {
      headers.apikey = apiKey;
    }

    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
      authMode = 'oauth_bearer';
    } else if (apiKey && clientSecret) {
      authMode = 'oauth_client_credentials';
      const tokenResponse = await fetch(getOauthTokenUrl(), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          apikey: apiKey,
        },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: apiKey,
          client_secret: clientSecret,
        }),
      });

      if (!tokenResponse.ok) {
        const tokenError = await tokenResponse.text();
        return NextResponse.json(
          {
            success: false,
            message: `OAuth token request failed (${tokenResponse.status}).`,
            details: tokenError,
          },
          { status: tokenResponse.status },
        );
      }

      const tokenData = await tokenResponse.json();
      const token = tokenData?.access_token;
      if (!token || typeof token !== 'string') {
        return NextResponse.json(
          {
            success: false,
            message: 'OAuth token response missing access_token.',
          },
          { status: 400 },
        );
      }
      headers.Authorization = `Bearer ${token}`;
    } else if (username && password) {
      headers.Authorization = buildBasicAuthHeader(username, password);
      authMode = 'basic';
    }

    // Test the FourKites API connection using configured auth mode.
    const response = await fetch(getShipmentsUrl(), {
      method: 'GET',
      headers,
    });

    if (response.ok) {
      return NextResponse.json({
        success: true,
        message: `Connection successful (${authMode}).`,
      });
    } else if (response.status === 401 || response.status === 403) {
      return NextResponse.json(
        {
          success: false,
          message:
            'Authentication failed. Verify credentials and ensure endpoint/auth mode are enabled for your account.',
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
            message: `Credentials are valid (${authMode}), but endpoint path may differ.`,
          });
        }
      } catch {
        // Not a JSON response, treat as actual error
      }
      return NextResponse.json(
        {
          success: false,
          message: 'Endpoint not found. Credentials may be valid but endpoint is incorrect.',
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
