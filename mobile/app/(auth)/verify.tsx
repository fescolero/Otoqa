/**
 * OTP verification screen — Otoqa Driver design system.
 *
 * Port of lib/otp-screen.jsx from the design bundle: 6-box code display,
 * masked phone helper, Resend countdown. Hidden TextInput captures the
 * native keyboard input and drives the visible boxes; we keep the native
 * keyboard (for SMS autofill on iOS) instead of the design's custom keypad.
 *
 * Clerk verify flow, analytics, and navigation are preserved verbatim.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSignIn, useAuth } from '@clerk/clerk-expo';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Icon } from '../../lib/design-icons';
import { useTheme } from '../../lib/ThemeContext';
import { radii, typeScale, type Palette } from '../../lib/design-tokens';
import {
  trackResendCode,
  trackScreen,
  trackVerificationFailed,
  trackVerificationStarted,
  trackVerificationSuccess,
} from '../../lib/analytics';

export default function VerifyScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const { phoneNumber } = useLocalSearchParams<{ phoneNumber: string }>();
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [code, setCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [resendTimer, setResendTimer] = useState(30);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [verificationComplete, setVerificationComplete] = useState(false);

  const hiddenInputRef = useRef<TextInput | null>(null);

  useEffect(() => {
    trackScreen('Verify');
  }, []);

  // Post-auth gating: once the driver is signed in, look at their profile
  // and decide where to send them.
  //   - No truck paired  → QR scanner (switch-truck) so they can pair
  //     before they hit the dashboard. The scanner routes to /start-shift
  //     on success, which in turn routes to /(driver-tabs).
  //   - Truck already paired → straight to the dashboard. Returning
  //     drivers don't get re-pinged through the scanner every sign-in.
  // profile is 'skip'-guarded until isSignedIn so the JWT is ready before
  // we fetch.
  const profile = useQuery(
    api.driverMobile.getMyProfile,
    isSignedIn ? {} : 'skip',
  );

  useEffect(() => {
    if (!isSignedIn || !isLoaded) return;
    // Wait for the profile to resolve. `undefined` = still loading.
    if (profile === undefined) return;
    const dest =
      profile && profile.currentTruckId ? '/(app)' : '/switch-truck';
    router.replace(dest);
  }, [isSignedIn, isLoaded, profile, verificationComplete]);

  useEffect(() => {
    if (resendTimer > 0) {
      const timer = setTimeout(() => setResendTimer(resendTimer - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [resendTimer]);

  const codeDigits = code.split('').concat(Array(6).fill('')).slice(0, 6);

  const handleCodeChange = (text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    setFocusedIndex(Math.min(digits.length, 5));

    if (digits.length === 6) {
      handleVerify(digits);
    }
  };

  const focusHiddenInput = () => {
    hiddenInputRef.current?.focus();
  };

  const handleVerify = async (fullCode?: string) => {
    hiddenInputRef.current?.blur();

    if (!isLoaded) return;

    const codeToVerify = fullCode || code;

    if (codeToVerify.length !== 6) {
      Alert.alert('Invalid Code', 'Please enter the 6-digit code');
      return;
    }

    setIsLoading(true);
    trackVerificationStarted();

    try {
      const result = await signIn.attemptFirstFactor({
        strategy: 'phone_code',
        code: codeToVerify,
      });

      if (result.status === 'complete') {
        trackVerificationSuccess();
        try {
          await setActive({ session: result.createdSessionId });
        } catch (activateError: any) {
          console.error('[Verify] setActive failed:', activateError);
          Alert.alert(
            'Session Error',
            "Verification succeeded but we couldn't activate your session. Please close and reopen the app.",
          );
          return;
        }
        setVerificationComplete(true);
      } else {
        trackVerificationFailed('incomplete', 'Verification incomplete');
        Alert.alert('Error', 'Verification incomplete. Please try again.');
      }
    } catch (error: any) {
      console.error('Verification error:', error);
      const errorCode = error.errors?.[0]?.code;
      const errorMessage = error.errors?.[0]?.message;
      trackVerificationFailed(errorCode, errorMessage);

      if (errorCode === 'form_code_incorrect') {
        Alert.alert('Invalid Code', 'The code you entered is incorrect. Please try again.');
        setCode('');
        setFocusedIndex(0);
        hiddenInputRef.current?.focus();
      } else {
        Alert.alert('Error', errorMessage || 'Verification failed');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleResend = async () => {
    if (!isLoaded || resendTimer > 0) return;

    try {
      await signIn.prepareFirstFactor({
        strategy: 'phone_code',
        phoneNumberId: signIn.supportedFirstFactors?.find(
          (factor) => factor.strategy === 'phone_code',
        )?.phoneNumberId as string,
      });

      trackResendCode(true);
      setResendTimer(30);
      Alert.alert('Code Sent', 'A new verification code has been sent.');
    } catch {
      trackResendCode(false);
      Alert.alert('Error', 'Failed to resend code. Please try again.');
    }
  };

  // Mask the middle digits of the displayed phone: +1 (415) ••• 2847
  const maskedPhone = (() => {
    if (!phoneNumber) return '';
    const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phoneNumber);
    if (!m) return phoneNumber;
    const [, a, , d] = m;
    return `+1 (${a}) ••• ${d}`;
  })();

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={() => router.back()}
          accessibilityLabel="Back"
          style={({ pressed }) => [
            styles.iconBtn,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Icon name="arrow-left" size={22} color={palette.textPrimary} />
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.title}>Enter verification code</Text>
          <Text style={styles.subtitle}>
            Sent to <Text style={styles.subtitleStrong}>{maskedPhone}</Text>
          </Text>

          <Pressable onPress={focusHiddenInput} style={styles.boxRow}>
            {codeDigits.map((digit, index) => {
              const isFilled = !!digit;
              const isActive = index === focusedIndex && !isFilled;
              return (
                <View
                  key={index}
                  style={[
                    styles.box,
                    isFilled && styles.boxFilled,
                    isActive && styles.boxActive,
                  ]}
                >
                  <Text style={styles.boxDigit}>{digit}</Text>
                </View>
              );
            })}
          </Pressable>
          <TextInput
            ref={hiddenInputRef}
            value={code}
            onChangeText={handleCodeChange}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="sms-otp"
            maxLength={6}
            autoFocus
            caretHidden
            style={styles.hiddenInput}
          />

          <View style={styles.resendRow}>
            <Text style={styles.resendLabel}>Didn&apos;t get it?</Text>
            {resendTimer > 0 ? (
              <Text style={styles.resendTimer}>
                Resend in 0:{resendTimer.toString().padStart(2, '0')}
              </Text>
            ) : (
              <Pressable onPress={handleResend}>
                <Text style={styles.resendLink}>Resend code</Text>
              </Pressable>
            )}
          </View>

          <View style={{ flex: 1, minHeight: 24 }} />

          <Pressable
            onPress={() => handleVerify()}
            disabled={code.length !== 6 || isLoading}
            style={({ pressed }) => [
              styles.cta,
              (code.length !== 6 || isLoading) && styles.ctaDisabled,
              pressed && code.length === 6 && !isLoading && { opacity: 0.9 },
            ]}
          >
            <Text style={styles.ctaText}>
              {isLoading ? 'Verifying…' : 'Continue'}
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: palette.bgCanvas,
    },
    topBar: {
      height: 52,
      paddingHorizontal: 8,
      flexDirection: 'row',
      alignItems: 'center',
    },
    iconBtn: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radii.full,
    },
    scroll: {
      flexGrow: 1,
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 24,
    },
    title: {
      ...typeScale.headingLg,
      color: palette.textPrimary,
      marginBottom: 8,
    },
    subtitle: {
      fontSize: 15,
      lineHeight: 22,
      color: palette.textSecondary,
      marginBottom: 24,
    },
    subtitleStrong: {
      fontWeight: '600',
      color: palette.textPrimary,
    },
    boxRow: {
      flexDirection: 'row',
      gap: 10,
      justifyContent: 'space-between',
      marginBottom: 24,
    },
    box: {
      flex: 1,
      aspectRatio: 1 / 1.15,
      maxWidth: 52,
      borderRadius: radii.lg,
      borderWidth: 1,
      borderColor: palette.borderDefault,
      backgroundColor: palette.bgSurface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    boxActive: {
      borderWidth: 2,
      borderColor: palette.accent,
    },
    boxFilled: {
      borderColor: palette.borderStrong,
    },
    boxDigit: {
      fontSize: 28,
      fontWeight: '600',
      color: palette.textPrimary,
      fontVariant: ['tabular-nums'],
    },
    hiddenInput: {
      position: 'absolute',
      opacity: 0,
      height: 1,
      width: 1,
    },
    resendRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    resendLabel: {
      fontSize: 13,
      color: palette.textTertiary,
    },
    resendTimer: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textTertiary,
    },
    resendLink: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.accent,
    },
    cta: {
      height: 56,
      borderRadius: radii.md,
      backgroundColor: palette.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ctaDisabled: {
      backgroundColor: palette.bgSubtle,
    },
    ctaText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
    },
  });
