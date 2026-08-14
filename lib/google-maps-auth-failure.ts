/**
 * Detection for Google Maps JS API authentication failures.
 *
 * The Maps JS API reports key/project problems (InvalidKeyMapError,
 * BillingNotEnabledMapError, ApiNotActivatedMapError, ...) by invoking a
 * global `window.gm_authFailure` callback and logging to the console — the
 * map surface itself just goes blank. Without a handler, users see a dead
 * map with no explanation.
 *
 * This module installs that callback (chaining any pre-existing one) and
 * exposes the failure as React state via `useGoogleMapsAuthFailure()`, so
 * every map surface can swap in an actionable error message instead.
 *
 * Note the most common cause in practice is BillingNotEnabledMapError:
 * the Google Cloud project that owns GOOGLE_MAPS_API_KEY has no active
 * billing account. That is fixed in the Cloud Console, not in code:
 * https://console.cloud.google.com/project/_/billing/enable
 */

'use client';

import { useSyncExternalStore } from 'react';

let failed = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return failed;
}

// SSR snapshot — auth can only fail in the browser.
function getServerSnapshot(): boolean {
  return false;
}

function markFailed(): void {
  if (failed) return;
  failed = true;
  listeners.forEach((l) => l());
}

declare global {
  interface Window {
    gm_authFailure?: () => void;
  }
}

let installed = false;

/**
 * Install the global `gm_authFailure` callback. Idempotent; chains any
 * handler another script installed first. Called from GoogleMapsProvider
 * on mount, which happens before the Maps script is injected (the script
 * only loads lazily when a map or autocomplete first needs it).
 */
export function installGoogleMapsAuthFailureHandler(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const previous = window.gm_authFailure;
  window.gm_authFailure = () => {
    markFailed();
    console.error(
      'Google Maps authentication failed. The API key was rejected — most ' +
        'commonly because billing is not enabled on its Google Cloud ' +
        'project (BillingNotEnabledMapError). Enable billing at ' +
        'https://console.cloud.google.com/project/_/billing/enable for the ' +
        'project that owns GOOGLE_MAPS_API_KEY, or check the exact error ' +
        'name logged above against ' +
        'https://developers.google.com/maps/documentation/javascript/error-messages'
    );
    previous?.();
  };
}

/**
 * True once the Maps JS API has reported an authentication failure for
 * this page load. Map components use this to render an explanatory
 * fallback instead of a blank map surface.
 */
export function useGoogleMapsAuthFailure(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * User-facing explanation for the auth-failure fallback, shared by all
 * map surfaces so the wording stays consistent.
 */
export const GOOGLE_MAPS_AUTH_FAILURE_MESSAGE =
  'Google Maps rejected the API key — usually billing is not enabled on ' +
  'its Google Cloud project. An admin can fix this in the Google Cloud ' +
  'Console (Billing → link an active billing account).';
