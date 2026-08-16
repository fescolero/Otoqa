/**
 * Sign-in — Otoqa_Mobile8 design: phone + OTP primary, "Company staff?
 * Sign in" secondary (never a bare Google button on this screen — the
 * Workspace branding lives one level deep on /staff, keeping the
 * Guideline 4.8 enterprise-SSO framing clean).
 */
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSignIn, useClerk } from '@clerk/expo';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';
import { useActiveAuth } from '../../lib/convex';

const fmtPhone = (raw: string) => {
  const d = raw.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
};

/** Clerk nests its error code under `errors[0]`; read it without an `any`. */
function clerkError(error: unknown) {
  return (
    (error as {
      errors?: Array<{ code?: string; message?: string; longMessage?: string }>;
    } | null)?.errors?.[0] ?? {}
  );
}

export default function SignInScreen() {
  const router = useRouter();
  // Core 3: `useSignIn()` returns a signal with neither `setActive` nor
  // `isLoaded`. Completing a flow is `signIn.finalize()`, and readiness comes
  // off the Clerk instance. This app has no <ClerkLoaded> wrapper (unlike the
  // driver app), so the readiness guard here is doing real work and has to be
  // preserved rather than dropped.
  const { signIn } = useSignIn();
  const { loaded: isLoaded } = useClerk();
  const { selectProvider, signOut } = useActiveAuth();
  const [step, setStep] = React.useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = React.useState('');
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const digits = phone.replace(/\D/g, '');
  const valid = digits.length === 10;

  const sendCode = async () => {
    if (!isLoaded || !signIn || !valid || busy) return;
    setBusy(true);
    const full = `+1${digits}`;
    // Core 3 folds create + factor lookup + prepareFirstFactor into one call.
    // It returns `{ error }` instead of throwing, so rethrow to give the
    // recovery below and the catch a single failure channel.
    const startPhoneCodeFlow = async () => {
      const { error } = await signIn.phoneCode.sendCode({ phoneNumber: full });
      if (error) throw error;
    };

    try {
      try {
        await startPhoneCodeFlow();
      } catch (createError) {
        // Same deadlock as the driver app: Clerk can still hold a session
        // while the app considers the user signed out, and the sign-in then
        // refuses with `session_exists`. Worse here — this screen has no auth
        // guard, and the catch below used to report EVERY failure as "Not
        // registered", so a stranded user was told their number was invalid.
        // Clear the leftover session and retry once.
        const staleCode = clerkError(createError).code;
        if (
          staleCode !== 'session_exists' &&
          staleCode !== 'identifier_already_signed_in'
        ) {
          throw createError;
        }
        await signOut();
        await startPhoneCodeFlow();
      }
      setStep('otp');
    } catch (error) {
      // Keep the invite-only message for the case it was written for, but
      // stop applying it to unrelated failures.
      const { code, message, longMessage } = clerkError(error);
      if (code === 'form_identifier_not_found') {
        Alert.alert(
          'Not registered',
          'This phone number is not registered. Otoqa Dispatch is invite-only — contact your administrator.',
        );
      } else {
        Alert.alert(
          "Couldn't send code",
          longMessage || message || 'Something went wrong. Please try again.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (full: string) => {
    if (!isLoaded || !signIn || busy) return;
    setBusy(true);
    try {
      const { error } = await signIn.phoneCode.verifyCode({ code: full });
      if (error) throw error;
      // Status is read off the resource now, not a returned attempt object.
      if (signIn.status === 'complete') {
        await signIn.finalize();
        await selectProvider('clerk');
        router.replace('/(app)');
      } else {
        Alert.alert('Sign-in incomplete', 'Please try again.');
      }
    } catch {
      Alert.alert('Wrong code', "That code didn't match. Try again.");
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={s.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={s.body}>
        <Text style={s.brand}>Otoqa Dispatch</Text>
        <Text style={s.sub}>
          {step === 'phone' ? 'Sign in to your board' : `Code sent to ${phone}`}
        </Text>

        {step === 'phone' ? (
          <>
            <Text style={s.label}>PHONE NUMBER</Text>
            <View style={s.inputRow}>
              <Text style={s.prefix}>🇺🇸 +1</Text>
              <TextInput
                style={s.input}
                value={phone}
                onChangeText={(t) => setPhone(fmtPhone(t))}
                placeholder="(555) 000-0000"
                placeholderTextColor={colors.foregroundMuted}
                keyboardType="phone-pad"
                autoFocus
              />
            </View>
            <Pressable
              style={[s.cta, !valid && s.ctaDisabled]}
              disabled={!valid || busy}
              onPress={sendCode}
            >
              {busy ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={s.ctaText}>Send me a code</Text>
              )}
            </Pressable>
          </>
        ) : (
          <>
            <TextInput
              style={s.otp}
              value={code}
              onChangeText={(t) => {
                const next = t.replace(/\D/g, '').slice(0, 6);
                setCode(next);
                if (next.length === 6) void submitCode(next);
              }}
              keyboardType="number-pad"
              autoFocus
              placeholder="••••••"
              placeholderTextColor={colors.foregroundMuted}
            />
            {busy && <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />}
            <Pressable onPress={() => { setStep('phone'); setCode(''); }} style={s.linkBtn}>
              <Text style={s.linkText}>Use a different number</Text>
            </Pressable>
          </>
        )}
      </View>

      {step === 'phone' && (
        <Pressable style={s.staff} onPress={() => router.push('/(auth)/staff')}>
          <Text style={s.staffText}>
            Company staff? <Text style={s.staffLink}>Sign in</Text>
          </Text>
        </Pressable>
      )}
    </KeyboardAvoidingView>
  );
}

const s = {
  screen: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 120 },
  brand: {
    fontSize: typography['2xl'],
    fontWeight: typography.bold,
    color: colors.foreground,
    textAlign: 'center' as const,
  },
  sub: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    textAlign: 'center' as const,
    marginTop: 6,
    marginBottom: 32,
  },
  label: {
    fontSize: typography.xs,
    fontWeight: typography.bold,
    letterSpacing: 1,
    color: colors.foregroundMuted,
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    backgroundColor: colors.card,
    paddingHorizontal: 14,
    minHeight: 54,
    gap: 10,
  },
  prefix: { fontSize: typography.base, color: colors.foregroundMuted },
  input: { flex: 1, fontSize: typography.md, color: colors.foreground },
  cta: {
    marginTop: 14,
    minHeight: 52,
    borderRadius: borderRadius.md,
    backgroundColor: colors.primary,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  ctaDisabled: { opacity: 0.4 },
  ctaText: {
    color: colors.primaryForeground,
    fontSize: typography.base,
    fontWeight: typography.semibold,
  },
  otp: {
    fontSize: 28,
    letterSpacing: 12,
    textAlign: 'center' as const,
    color: colors.foreground,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    backgroundColor: colors.card,
    paddingVertical: 14,
  },
  linkBtn: { marginTop: 18, alignItems: 'center' as const },
  linkText: { color: colors.foregroundMuted, fontSize: typography.sm },
  staff: { paddingBottom: 40, alignItems: 'center' as const },
  staffText: { color: colors.foregroundMuted, fontSize: typography.sm },
  staffLink: { color: colors.primary, fontWeight: typography.bold },
};
