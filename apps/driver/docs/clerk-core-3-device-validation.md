# Clerk Core 3 — device validation checklist

**Status: NOT VALIDATED. Do not publish this branch to any EAS channel until
every box below is ticked on a physical device.**

This branch migrates `@clerk/clerk-expo@2.19.22` (Core 2) to
`@clerk/expo@4.3.0` (Core 3, clerk-js 6.29.1) across the driver and dispatch
apps, and rewrites the custom phone-OTP sign-in flow onto Core 3's signal /
future API.

Static checks pass — both Expo typechecks are clean apart from the
pre-existing `convex/lib/auth.ts` TS7006 that also fails on `main`, lint is at
zero errors with warning counts unchanged, and all 931 tests pass. **None of
that exercises the sign-in flow.** `apps/driver/lib` and `apps/driver/app` are
not in `vitest.config.ts`, so there is no automated coverage of any line
changed here. The compiler agreeing that `signIn.phoneCode.sendCode()` exists
says nothing about whether a code arrives on a real phone.

If this flow is broken, drivers cannot sign in at all — there is no degraded
mode and no way to recover from the app. That is the reason for this file.

## What changed in the flow

| Core 2 | Core 3 |
| --- | --- |
| `useSignIn()` → `{ signIn, setActive, isLoaded }` | `useSignIn()` → `{ signIn, errors, fetchStatus }` |
| `isLoaded` from `useSignIn()` | `loaded` from `useClerk()` |
| `signIn.create({ identifier })` + `supportedFirstFactors` lookup + `prepareFirstFactor()` | `signIn.phoneCode.sendCode({ phoneNumber })` |
| `signIn.attemptFirstFactor({ strategy, code })` | `signIn.phoneCode.verifyCode({ code })` |
| `result.status` | `signIn.status` (read off the resource) |
| `setActive({ session: createdSessionId })` | `signIn.finalize()` |
| throws on failure; `error.errors[0].code` | returns `{ error }`; flat `error.code` |

The shape of the last row is why `lib/clerk-error.ts` exists — it reads both
shapes, because the methods return errors but can still throw on transport
failure.

## Checklist

### Driver app — the critical path
- [ ] Cold start, signed out. Sign-in screen renders (readiness guard resolves).
- [ ] Enter a registered number → code arrives by SMS.
- [ ] Enter the code → session activates and the app reaches the tab shell.
- [ ] Kill and relaunch → still signed in (token cache rehydrates from the
      keychain under `AFTER_FIRST_UNLOCK`).
- [ ] Resend code on the verify screen sends a second SMS. This one is the
      likeliest to regress: it now calls `sendCode()` with **no arguments**,
      relying on Clerk reusing the identifier already on the attempt.
- [ ] Wrong code → "Wrong code" alert, not a crash or a stuck spinner.
- [ ] Unregistered number → the invite-only alert, i.e.
      `form_identifier_not_found` still maps through `clerkErrorCode()`.
- [ ] Sign out, then sign in again in the same app session.

### Dispatch app
- [ ] Same phone → code → verify path.
- [ ] Readiness guard: this app has **no** `<ClerkLoaded>` wrapper, so
      `useClerk().loaded` is genuinely gating. Verify the screen doesn't act
      before Clerk is ready on a cold start.
- [ ] `selectProvider('clerk')` still runs after `finalize()` and the app
      routes to `/(app)`.

### Convex auth, on both
- [ ] Signing in produces a working Convex session — queries resolve rather
      than throwing `Unauthenticated`.
- [ ] `convex_auth_setup_complete` fires with `is_authenticated: true`.

### The reason for the migration
- [ ] With the device on a deliberately bad connection, confirm Core 3 raises
      `ClerkOfflineError` instead of returning a null token. This is the whole
      point of the upgrade: on Core 2, `getToken()` returned `null` for both
      "signed out" and "offline", and the app read that as an auth failure.
- [ ] `convex_auth_token_fetch_failed` should now be rare and, where it does
      occur, distinguishable from a genuine sign-out.

## Not done on this branch

- `apps/driver/**` still has no test harness. Worth building alongside this,
  since the migration is exactly the kind of change tests should have caught.
- The four optional Core 3 peer deps (`expo-apple-authentication`,
  `expo-local-authentication`, `@clerk/expo-passkeys`,
  `@clerk/expo-google-signin`) are intentionally not installed — nothing here
  uses passkeys, biometrics, or Google/Apple sign-in.
