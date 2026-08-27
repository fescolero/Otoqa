/**
 * Sign-in — Otoqa_Mobile8 design: phone + OTP primary, "Company staff?
 * Sign in" secondary (never a bare Google button on this screen — the
 * Workspace branding lives one level deep on /staff, keeping the
 * Guideline 4.8 enterprise-SSO framing clean).
 */
import * as React from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSignIn } from '@clerk/clerk-expo';
import { borderRadius, colors, typography } from '../../lib/theme';
import { Brand, Keypad } from '../../lib/ui';
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
  const { signIn, setActive, isLoaded } = useSignIn();
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
    const startPhoneCodeFlow = async () => {
      const attempt = await signIn.create({ identifier: full });
      const factor = attempt.supportedFirstFactors?.find(
        (f): f is Extract<typeof f, { strategy: 'phone_code' }> => f.strategy === 'phone_code',
      );
      await signIn.prepareFirstFactor({
        strategy: 'phone_code',
        phoneNumberId: factor?.phoneNumberId as string,
      });
    };

    try {
      try {
        await startPhoneCodeFlow();
      } catch (createError) {
        // Same deadlock as the driver app: Clerk can still hold a session
        // while the app considers the user signed out, and `signIn.create()`
        // then refuses with `session_exists`. Worse here — this screen has no
        // auth guard and the catch below reports EVERY failure as "Not
        // registered", so a stranded user is told their number is invalid.
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
      const attempt = await signIn.attemptFirstFactor({ strategy: 'phone_code', code: full });
      if (attempt.status === 'complete') {
        await setActive({ session: attempt.createdSessionId });
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

  // Resend cooldown, per the design — without it the only feedback after
  // tapping "Resend" is nothing happening.
  const [secs, setSecs] = React.useState(0);
  React.useEffect(() => {
    if (secs <= 0) return;
    const t = setTimeout(() => setSecs((x) => x - 1), 1000);
    return () => clearTimeout(t);
  }, [secs]);

  const pushKey = (k: string) => {
    if (busy) return;
    const next = (code + k).slice(0, 6);
    setCode(next);
    if (next.length === 6) void submitCode(next);
  };

  const send = async () => {
    await sendCode();
    setSecs(30);
  };

  return (
    <View style={s.screen}>
      <ScrollView
        contentContainerStyle={s.body}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {step === 'phone' ? (
          <>
            <Brand title="Otoqa Dispatch" sub="Sign in to your board" />
            <View style={{ marginTop: 32, gap: 12 }}>
              <View>
                <Text style={s.label}>Phone number</Text>
                {/* The border going accent is the only signal that the number
                    is complete — the CTA below reads as disabled either way
                    until it isn't. */}
                <View style={[s.inputRow, valid && { borderColor: colors.primary }]}>
                  <Text style={s.flag}>🇺🇸</Text>
                  <Text style={s.prefix}>+1</Text>
                  <View style={s.divider} />
                  <TextInput
                    style={s.input}
                    value={phone}
                    onChangeText={(t) => setPhone(fmtPhone(t))}
                    placeholder="(555) 000-0000"
                    placeholderTextColor={colors.foregroundDisabled}
                    keyboardType="phone-pad"
                    autoFocus
                  />
                </View>
              </View>

              <Pressable
                style={[s.cta, !valid && s.ctaDisabled]}
                disabled={!valid || busy}
                onPress={() => void send()}
              >
                {busy ? (
                  <>
                    <ActivityIndicator color={colors.primaryForeground} size="small" />
                    <Text style={s.ctaText}>Sending code…</Text>
                  </>
                ) : (
                  <Text style={[s.ctaText, !valid && s.ctaTextDisabled]}>Send me a code</Text>
                )}
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Brand title="Otoqa Dispatch" sub={`Code sent to ${phone}`} />
            <View style={{ marginTop: 28, gap: 14 }}>
              <View style={s.otpRow}>
                {Array.from({ length: 6 }).map((_, i) => {
                  const filled = i < code.length;
                  const cursor = i === code.length;
                  return (
                    <View
                      key={i}
                      style={[
                        s.otpBox,
                        cursor && { borderColor: colors.primary },
                        filled && { borderColor: colors.border },
                      ]}
                    >
                      <Text style={s.otpDigit}>{filled ? code[i] : ''}</Text>
                    </View>
                  );
                })}
              </View>

              <Text style={s.resend}>
                {busy ? (
                  'Checking your code…'
                ) : secs > 0 ? (
                  `Resend code in ${secs}s`
                ) : (
                  <Text style={s.resendLink} onPress={() => void send()}>
                    Resend code
                  </Text>
                )}
              </Text>

              <Keypad onKey={pushKey} onBack={() => setCode((c) => c.slice(0, -1))} />

              <Pressable
                onPress={() => {
                  setStep('phone');
                  setCode('');
                  setSecs(0);
                }}
                style={s.linkBtn}
              >
                <Ionicons name="arrow-back" size={15} color={colors.foregroundMuted} />
                <Text style={s.linkText}>Use a different number</Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>

      {/* Secondary path — never competes with the phone CTA (D14/§7: no bare
          Google button on this screen). */}
      {step === 'phone' && (
        <Pressable style={s.staff} onPress={() => router.push('/(auth)/staff')}>
          <Text style={s.staffText}>
            Company staff? <Text style={s.staffLink}>Sign in</Text>
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const s = {
  screen: { flex: 1, backgroundColor: colors.background },
  body: { paddingHorizontal: 24, paddingTop: 88, paddingBottom: 24 },
  label: {
    fontSize: typography.xs,
    fontWeight: typography.bold,
    letterSpacing: 0.8,
    textTransform: 'uppercase' as const,
    color: colors.foregroundSubtle,
    marginBottom: 7,
  },
  inputRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    minHeight: 54,
    paddingHorizontal: 14,
    borderRadius: borderRadius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  flag: { fontSize: 16 },
  prefix: { fontSize: 16, fontWeight: typography.semibold, color: colors.foregroundMuted },
  divider: { width: 1, height: 22, backgroundColor: colors.borderSubtle },
  input: {
    flex: 1,
    fontSize: 17,
    fontWeight: typography.semibold,
    color: colors.foreground,
  },
  cta: {
    minHeight: 52,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.primary,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 8,
  },
  // Muted, not a dimmed accent: a disabled button that keeps its brand colour
  // still reads as pressable.
  ctaDisabled: { backgroundColor: colors.subtle },
  ctaText: { color: colors.primaryForeground, fontSize: 15.5, fontWeight: typography.bold },
  ctaTextDisabled: { color: colors.foregroundDisabled },
  otpRow: { flexDirection: 'row' as const, gap: 8, justifyContent: 'center' as const },
  otpBox: {
    width: 46,
    height: 56,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.borderSubtle,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  otpDigit: { fontSize: 23, fontWeight: typography.bold, color: colors.foreground },
  resend: {
    textAlign: 'center' as const,
    fontSize: typography.sm,
    color: colors.foregroundSubtle,
  },
  resendLink: { fontWeight: typography.bold, color: colors.primary },
  linkBtn: {
    minHeight: 44,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 7,
  },
  linkText: { color: colors.foregroundMuted, fontSize: typography.base, fontWeight: typography.semibold },
  staff: { paddingHorizontal: 24, paddingBottom: 32, alignItems: 'center' as const },
  staffText: { color: colors.foregroundMuted, fontSize: typography.base },
  staffLink: { color: colors.primary, fontWeight: typography.bold },
};
