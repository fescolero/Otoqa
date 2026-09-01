/**
 * external-link.ts — opening a public web page from inside the driver app.
 *
 * Wires the rule in external-link-logic.ts to the real presenters. Use this
 * anywhere the app sends a driver to a web page (Terms, Privacy, help docs);
 * a bare `Linking.openURL` for an https URL is the bug this module replaces.
 *
 * The in-app browser goes first on purpose. `WebBrowser.openBrowserAsync`
 * presents SFSafariViewController / a Chrome Custom Tab inside our own
 * process, so it works on devices that have no external default-browser
 * handler — which is exactly the configuration that was rejecting
 * `Linking.openURL`. It also keeps the driver in the app mid-sign-in instead
 * of task-switching them out of a half-entered phone number. Handing off to
 * the system browser stays as the fallback.
 *
 * `tel:` / `mailto:` / `app-settings:` links are NOT this module's job —
 * those want `Linking.openURL` directly, since there is no in-app browser
 * route for them.
 */
import { Alert, Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { createExternalLinkOpener } from './external-link-logic';
import { log } from './log';

const lg = log('ExternalLink');

const openLink = createExternalLinkOpener([
  { via: 'in-app-browser', open: (url) => WebBrowser.openBrowserAsync(url) },
  { via: 'system', open: (url) => Linking.openURL(url) },
]);

/**
 * Open `url` for the driver, falling back to an alert that names the address
 * when the device will not open it at all.
 *
 * Never rejects: callers are `onPress` handlers, and an unhandled rejection
 * out of one of those is the crash this replaces. A device that cannot open
 * the link is reported to the driver and logged at warn — not swallowed.
 */
export async function openExternalUrl(url: string, label: string): Promise<void> {
  const result = await openLink(url);

  if (result.kind === 'opened') {
    lg.debug(`Opened ${label} via ${result.via}`);
    return;
  }
  // A duplicate tap while the browser is still coming up. The first open is
  // still on its way, so an alert here would be a lie.
  if (result.kind === 'busy') return;

  lg.warn(`No handler would open ${url} — showing the address instead`);
  Alert.alert(
    `Can't open ${label}`,
    `This device wouldn't open the link. You can read it at ${url} in any browser.`,
  );
}
