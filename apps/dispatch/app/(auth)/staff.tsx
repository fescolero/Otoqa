/**
 * Company staff sign-in — Otoqa_Mobile8 design: Workspace branding lives
 * here (one level deep), with the waiting-for-browser state and the
 * "not part of the company workspace" error. Domain copy is dynamic per
 * tenant (D14) — WorkOS decides which accounts are valid, we never
 * hardcode a domain.
 */
import * as React from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { borderRadius, colors, typography } from '../../lib/theme';
import { useActiveAuth } from '../../lib/convex';

export default function StaffSignInScreen() {
  const router = useRouter();
  const { workos, selectProvider } = useActiveAuth();
  const [state, setState] = React.useState<'idle' | 'waiting' | 'error'>('idle');

  const start = async () => {
    setState('waiting');
    try {
      const ok = await workos.signIn();
      if (ok) {
        await selectProvider('workos');
        router.replace('/(app)');
      } else {
        setState('error');
      }
    } catch (e) {
      // Config errors (missing client id in the build) get their own
      // message — the "not part of the workspace" card would mislead.
      if (e instanceof Error && e.message.includes('not configured')) {
        Alert.alert('Sign-in unavailable', e.message);
        setState('idle');
      } else {
        setState('error');
      }
    }
  };

  return (
    <View style={s.screen}>
      <View style={s.body}>
        <Text style={s.brand}>Company staff</Text>
        <Text style={s.sub}>Sign in with your company Google Workspace account</Text>

        {state === 'waiting' ? (
          <View style={s.waitCard}>
            <ActivityIndicator color={colors.primary} />
            <Text style={s.waitTitle}>Waiting for your browser</Text>
            <Text style={s.waitSub}>
              Finish signing in to Google Workspace in the browser, then come back here.
            </Text>
            <Pressable style={s.secondary} onPress={() => setState('idle')}>
              <Text style={s.secondaryText}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {state === 'error' && (
              <View style={s.errorCard}>
                <Text style={s.errorTitle}>Not part of the company workspace</Text>
                <Text style={s.errorSub}>
                  Staff sign-in only works with your company Google Workspace login. Try another
                  account, or use phone sign-in if you drive.
                </Text>
              </View>
            )}
            <Pressable style={s.cta} onPress={start}>
              <Text style={s.ctaText}>Continue with Google Workspace</Text>
            </Pressable>
            <Text style={s.hint}>Opens your browser · restricted to your company workspace</Text>
          </>
        )}

        <Pressable style={s.back} onPress={() => router.back()}>
          <Text style={s.backText}>Sign in with a phone number instead</Text>
        </Pressable>
      </View>
    </View>
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
    marginBottom: 30,
  },
  cta: {
    minHeight: 52,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  ctaText: { color: colors.foreground, fontSize: typography.base, fontWeight: typography.semibold },
  hint: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    textAlign: 'center' as const,
    marginTop: 10,
  },
  waitCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.card,
    padding: 22,
    alignItems: 'center' as const,
    gap: 10,
  },
  waitTitle: { color: colors.foreground, fontSize: typography.base, fontWeight: typography.semibold },
  waitSub: { color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center' as const },
  secondary: { marginTop: 8, paddingVertical: 8, paddingHorizontal: 16 },
  secondaryText: { color: colors.foregroundMuted, fontSize: typography.sm },
  errorCard: {
    borderWidth: 1,
    borderColor: colors.destructive,
    borderRadius: borderRadius.md,
    padding: 14,
    marginBottom: 14,
  },
  errorTitle: { color: colors.destructive, fontSize: typography.sm, fontWeight: typography.bold },
  errorSub: { color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 4 },
  back: { marginTop: 26, alignItems: 'center' as const },
  backText: { color: colors.foregroundMuted, fontSize: typography.sm },
};
