# Dispatch push credentials (Android FCM + iOS APNs)

**What this is.** The Otoqa Dispatch push pipeline is built and tested
end-to-end in code — `dispatchAlerts` raises a high-severity alert →
`push.fanoutHighAlert` → `push.sendBatch` → Expo → `push.checkReceipts` →
`push.pruneToken`. What is missing is the per-app *credential* layer, which
only exists in the Firebase and Expo consoles. Until these steps are done,
**Android push is inert**: `getExpoPushTokenAsync` throws, the
`usePushRegistration` hook swallows it, and no token is ever written to
`dispatchPushTokens`. No error surfaces anywhere in the product.

`apps/dispatch/app.config.js` prints a loud warning on every Expo command
while the file is absent. That warning is the signal this runbook is unfinished.

---

## What to check first

```bash
ls apps/dispatch/google-services.json
```

Present → the config wires `android.googleServicesFile` automatically; move to
step 2. Absent → start at step 1.

To confirm what a build will actually use:

```bash
cd apps/dispatch && npx expo config --type public | grep -E "googleServicesFile|POST_NOTIFICATIONS"
```

---

## 1. Firebase Android app (produces `google-services.json`)

Dispatch is a **second Android app inside the existing Firebase project** — do
not create a new project, or the driver app's FCM wake path
(`FCM_SERVICE_ACCOUNT_JSON`, see `convex/fcmWake.ts`) ends up on different
credentials than dispatch.

- Project: **`otoqa-95106`** (project number `172050880411`) — the one
  `apps/driver/google-services.json` already points at.
- Firebase console → Project settings → *Your apps* → **Add app → Android**
- Android package name: **`com.otoqa.dispatch`** (must match `app.json`
  exactly; a mismatch produces tokens that silently never deliver)
- SHA-1: not required for FCM
- Download `google-services.json` → save to **`apps/dispatch/google-services.json`**

Commit it. It is client config, not a secret — the driver app's equivalent is
tracked for the same reason: `eas build`/`eas update` must work from any
machine. (CI that prefers not to commit it can instead set the
`GOOGLE_SERVICES_JSON` file-based env var in EAS; `app.config.js` prefers that
when present.)

## 2. FCM V1 service account → Expo

Expo needs server credentials to talk to FCM on behalf of this app.

- Firebase console → Project settings → **Service accounts** → *Generate new
  private key* → downloads a JSON key
- Upload it to the **dispatch** Expo project (`ba5a70b6-1b02-4618-a217-6d1942af4245`):

```bash
cd apps/dispatch && npx eas credentials --platform android
```

  → *Push Notifications: Manage your FCM V1 service account key* → upload the JSON.

Treat that key as a secret — it is not the same class of file as
`google-services.json`. Do not commit it.

## 3. iOS APNs

No manual step in the normal case: EAS generates and manages the APNs key at
first build for a device/store profile. Verify with
`npx eas credentials --platform ios` once a build profile that produces a real
device build exists (today `eas.json` has only `development` and `preview`).

## 4. Rebuild — an OTA update cannot fix this

Every step above changes **native** config. `eas update` ships JS only, so
publishing an OTA onto an existing APK leaves Android push exactly as broken.
A new build is mandatory:

```bash
cd apps/dispatch && npx eas build --profile preview --platform android
```

---

## What "resolved" looks like

1. `npx expo config --type public` prints no warning and shows
   `googleServicesFile`.
2. Install the new build on a **physical** Android device (simulators have no
   push tokens — the hook returns early on `!Device.isDevice`), sign in, accept
   the notification prompt.
3. A row appears in `dispatchPushTokens` with `platform: "android"` for that
   org and user.
4. End-to-end: raise a high-severity alert for the org and confirm the device
   receives it. Watch the Convex logs for `[push] Expo push API error` — its
   absence plus a delivered notification is the pass condition.

## Escalate / stop if

- Tokens register but nothing arrives → check `push.checkReceipts` logs for
  `DeviceNotRegistered` (token pruning working as designed) versus
  `MismatchSenderId`, which means the `google-services.json` sender does not
  match the FCM key uploaded in step 2. Redo step 2.
- The driver app's push or FCM wake regresses after this work → the two apps
  now share a Firebase project; confirm step 1 added an app rather than
  modifying `com.otoqa.driver`.
