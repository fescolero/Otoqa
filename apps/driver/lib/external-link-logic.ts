/**
 * external-link-logic.ts — the "open a web link" decision rule, kept free of
 * React Native and Expo so it can be unit-tested in node.
 *
 * This exists because of a real crash: the sign-in screen's Terms and Privacy
 * links called `Linking.openURL(...)` and dropped the returned promise. On a
 * device where the OS refuses the hand-off — no default browser handler, an
 * MDM web-content filter, a restricted profile — that promise rejects, and an
 * unhandled rejection in React Native is reported as a fatal error. One driver
 * tapping a link they could not open produced 11 crash reports in 90 seconds,
 * because nothing told them the tap had failed and they kept tapping.
 *
 * Two rules come out of that incident:
 *
 *   1. Try the openers in order and treat a rejection as "this route is not
 *      available here", not as a crash. Failing every route is a real outcome
 *      (`unavailable`) that the caller must show the driver — the error is
 *      handled and surfaced, never silently dropped.
 *   2. Serialize opens. A second tap while a browser is still being presented
 *      makes the presenter itself throw, which is how one dead link turned
 *      into a burst of identical reports.
 *
 * No `canOpenURL` pre-check: that needs LSApplicationQueriesSchemes /
 * Android package-visibility entries, which live in native config we cannot
 * change from JS. Attempting the open and handling the rejection is the same
 * approach lib/dispatch-moved-screen.tsx already takes.
 */

/** Which route actually opened the link — for logging and analytics. */
export type ExternalLinkVia = 'in-app-browser' | 'system';

export type ExternalLinkAttempt = {
  via: ExternalLinkVia;
  open: (url: string) => Promise<unknown>;
};

export type ExternalLinkResult =
  /** A route accepted the URL. */
  | { kind: 'opened'; via: ExternalLinkVia }
  /** Every route refused it — the caller has to tell the driver. */
  | { kind: 'unavailable' }
  /** An open is already in progress; this tap is a duplicate. */
  | { kind: 'busy' };

/**
 * Build an opener over `attempts`, tried in order until one resolves.
 *
 * Returns a function rather than taking the attempts per call so the
 * in-flight guard is shared across every caller in the app: two screens
 * racing to present a browser hit the same failure as one screen tapped
 * twice.
 */
export function createExternalLinkOpener(
  attempts: readonly ExternalLinkAttempt[],
): (url: string) => Promise<ExternalLinkResult> {
  let inFlight = false;

  return async function openExternalLink(url: string): Promise<ExternalLinkResult> {
    if (inFlight) return { kind: 'busy' };
    inFlight = true;
    try {
      for (const attempt of attempts) {
        try {
          await attempt.open(url);
          return { kind: 'opened', via: attempt.via };
        } catch {
          // This route has no handler on this device — fall through to the
          // next one. Exhausting the list returns `unavailable` below, so
          // the failure still reaches the driver.
        }
      }
      return { kind: 'unavailable' };
    } finally {
      inFlight = false;
    }
  };
}
