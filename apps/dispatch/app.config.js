/**
 * Dynamic config over app.json — exists for exactly one reason: Android FCM.
 *
 * `android.googleServicesFile` must point at a file that EXISTS, or the
 * Google Services config plugin throws during prebuild and takes the whole
 * build with it. `google-services.json` is per-Firebase-app and can only be
 * produced from the Firebase console (see docs/runbooks/dispatch-push-credentials.md),
 * so it cannot be checked in ahead of that step.
 *
 * Rather than leave a broken reference in app.json, wire it conditionally:
 * builds keep working today, and Android push activates the moment the file
 * lands at apps/dispatch/google-services.json — no further config edits.
 * EAS's file-based env var (GOOGLE_SERVICES_JSON) takes precedence when set,
 * which is how a CI build supplies it without committing the file.
 *
 * Silence would be the dangerous failure here (Android tokens just never
 * register — `getExpoPushTokenAsync` throws and the hook swallows it), so
 * the absent case logs loudly instead.
 */
const fs = require('node:fs');
const path = require('node:path');

const LOCAL_GOOGLE_SERVICES = path.join(__dirname, 'google-services.json');

module.exports = ({ config }) => {
  const fromEnv = process.env.GOOGLE_SERVICES_JSON;
  const googleServicesFile = fromEnv ?? (fs.existsSync(LOCAL_GOOGLE_SERVICES) ? './google-services.json' : null);

  if (!googleServicesFile) {
    console.warn(
      '\n⚠ apps/dispatch: google-services.json not found — Android push is INERT in this build.\n' +
        '  Expo push tokens will fail to mint on Android and registration silently no-ops.\n' +
        '  Fix: docs/runbooks/dispatch-push-credentials.md (iOS is unaffected).\n',
    );
    return config;
  }

  return { ...config, android: { ...config.android, googleServicesFile } };
};
