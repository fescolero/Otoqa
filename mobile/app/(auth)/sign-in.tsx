/**
 * Phone sign-in screen — Otoqa Driver design system.
 *
 * Visuals follow lib/phone-screen.jsx from the design bundle: centered
 * title + helper, country chip + number field, legal microcopy, and a
 * big CTA. We use the native phone-pad keyboard rather than the design's
 * custom keypad — on RN the native keyboard gives us paste, autofill,
 * and accessibility for free.
 *
 * Clerk sign-in flow, analytics, and error branching are preserved
 * verbatim from the previous version.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSignIn } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { Icon } from '../../lib/design-icons';
import { useTheme } from '../../lib/ThemeContext';
import { radii, typeScale, type Palette } from '../../lib/design-tokens';
import {
  trackLoadingGateTimeout,
  trackScreen,
  trackSignInCodeSent,
  trackSignInFailed,
  trackSignInStarted,
} from '../../lib/analytics';

export default function SignInScreen() {
  const { signIn, isLoaded } = useSignIn();
  const router = useRouter();
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [phoneNumber, setPhoneNumber] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [navigateTo, setNavigateTo] = useState<string | null>(null);
  const phoneInputRef = useRef<TextInput>(null);

  useEffect(() => {
    trackScreen('SignIn');
  }, []);

  const normalizeToDigits = (text: string): string => {
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^\+1[-.\s]?/, '');
    return cleaned.replace(/\D/g, '').slice(0, 10);
  };

  const formatPhoneNumber = (digits: string) => {
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
  };

  const handlePhoneChange = (text: string) => {
    const digits = normalizeToDigits(text);
    setPhoneNumber(formatPhoneNumber(digits));
  };

  useEffect(() => {
    if (navigateTo) {
      router.push({
        pathname: '/(auth)/verify',
        params: { phoneNumber: navigateTo },
      });
      setNavigateTo(null);
    }
  }, [navigateTo]);

  const handleSendCode = async () => {
    phoneInputRef.current?.blur();

    if (!isLoaded || !signIn) {
      Alert.alert('Error', 'Authentication not ready. Please restart the app.');
      return;
    }

    const rawPhone = normalizeToDigits(phoneNumber);

    if (rawPhone.length < 10) {
      Alert.alert('Invalid Phone', 'Please enter a valid 10-digit phone number');
      return;
    }

    setIsLoading(true);

    const fullPhoneNumber = `+1${rawPhone}`;
    const startTime = Date.now();
    trackSignInStarted(fullPhoneNumber);

    const SIGN_IN_TIMEOUT_MS = 15_000;
    const timeoutId = setTimeout(() => {
      trackLoadingGateTimeout('sign_in_request', SIGN_IN_TIMEOUT_MS, {
        phone_masked: fullPhoneNumber.slice(-4),
      });
    }, SIGN_IN_TIMEOUT_MS);

    try {
      const result = await signIn.create({ identifier: fullPhoneNumber });
      await signIn.prepareFirstFactor({
        strategy: 'phone_code',
        phoneNumberId: result.supportedFirstFactors?.find(
          (factor) => factor.strategy === 'phone_code',
        )?.phoneNumberId as string,
      });

      clearTimeout(timeoutId);
      trackSignInCodeSent(fullPhoneNumber);
      setNavigateTo(fullPhoneNumber);
    } catch (error: any) {
      clearTimeout(timeoutId);
      const elapsed = Date.now() - startTime;
      const errorCode = error.errors?.[0]?.code;
      const errorMessage = error.errors?.[0]?.message || error.errors?.[0]?.longMessage;

      trackSignInFailed(fullPhoneNumber, errorCode, errorMessage);

      if (elapsed >= SIGN_IN_TIMEOUT_MS) {
        Alert.alert(
          'Request Timed Out',
          'The sign-in request took too long. Please check your connection and try again.',
        );
      } else if (errorCode === 'form_identifier_not_found') {
        Alert.alert(
          'Not Registered',
          `This phone number (${fullPhoneNumber}) is not registered. This app is invite-only. Please contact your company administrator.`,
        );
      } else if (errorCode === 'form_param_format_invalid') {
        Alert.alert('Invalid Format', 'Please enter a valid phone number.');
      } else if (errorCode === 'strategy_for_user_invalid') {
        Alert.alert(
          'Phone Sign-In Not Enabled',
          'This account exists but is not set up for phone sign-in. Please contact your administrator.',
        );
      } else {
        Alert.alert('Error', errorMessage || `Sign-in failed (${errorCode || 'unknown'})`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const rawDigits = normalizeToDigits(phoneNumber);
  const isValid = rawDigits.length === 10;
  const remaining = 10 - rawDigits.length;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <View style={{ width: 44, height: 44 }} />
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
          <Text style={styles.title}>What&apos;s your number?</Text>
          <Text style={styles.helper}>
            We&apos;ll text a code to confirm it&apos;s you. We don&apos;t share driver data.
          </Text>

          <View style={styles.fieldRow}>
            <View style={styles.countryChip}>
              <FlagUS />
              <Text style={styles.countryChipText}>+1</Text>
              <Icon name="chevron-down" size={14} color={palette.textTertiary} />
            </View>
            <Pressable
              style={[styles.numberField, isValid && styles.numberFieldValid]}
              onPress={() => phoneInputRef.current?.focus()}
            >
              <TextInput
                ref={phoneInputRef}
                value={phoneNumber}
                onChangeText={handlePhoneChange}
                placeholder="Phone number"
                placeholderTextColor={palette.textPlaceholder}
                keyboardType="phone-pad"
                textContentType="telephoneNumber"
                autoComplete="tel"
                maxLength={14}
                autoFocus
                style={styles.numberFieldInput}
              />
            </Pressable>
          </View>

          <View style={{ flex: 1, minHeight: 24 }} />

          <Text style={styles.legal}>
            By continuing you agree to Otoqa&apos;s{' '}
            <Text
              style={styles.legalLink}
              onPress={() => Linking.openURL('https://otoqa.com/terms')}
            >
              Terms
            </Text>{' '}
            and{' '}
            <Text
              style={styles.legalLink}
              onPress={() => Linking.openURL('https://otoqa.com/privacy')}
            >
              Privacy Policy
            </Text>
            .
          </Text>

          <Pressable
            onPress={handleSendCode}
            disabled={!isValid || isLoading}
            style={({ pressed }) => [
              styles.cta,
              (!isValid || isLoading) && styles.ctaDisabled,
              pressed && isValid && !isLoading && { opacity: 0.9 },
            ]}
          >
            <Text style={styles.ctaText}>
              {isLoading
                ? 'Sending code…'
                : isValid
                  ? 'Send code'
                  : `Enter ${remaining} more digit${remaining === 1 ? '' : 's'}`}
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const FlagUS = () => (
  <View style={flagStyles.wrap}>
    <View style={flagStyles.redStripes} />
    <View style={flagStyles.canton} />
  </View>
);

const flagStyles = StyleSheet.create({
  wrap: {
    width: 22,
    height: 16,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  redStripes: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#B22234',
    opacity: 0.85,
  },
  canton: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 10,
    height: 8.66,
    backgroundColor: '#3C3B6E',
  },
});

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
      justifyContent: 'space-between',
    },
    scroll: {
      flexGrow: 1,
      paddingHorizontal: 20,
      paddingTop: 32,
      paddingBottom: 24,
    },
    title: {
      ...typeScale.headingLg,
      color: palette.textPrimary,
      textAlign: 'center',
      marginBottom: 8,
    },
    helper: {
      fontSize: 15,
      lineHeight: 22,
      color: palette.textSecondary,
      textAlign: 'center',
      maxWidth: 300,
      alignSelf: 'center',
    },
    fieldRow: {
      flexDirection: 'row',
      gap: 10,
      marginTop: 28,
    },
    countryChip: {
      height: 56,
      paddingHorizontal: 12,
      borderRadius: radii.lg,
      borderWidth: 1,
      borderColor: palette.borderDefault,
      backgroundColor: palette.bgSurface,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    countryChipText: {
      fontSize: 15,
      fontWeight: '600',
      color: palette.textPrimary,
    },
    numberField: {
      flex: 1,
      height: 56,
      borderRadius: radii.lg,
      borderWidth: 1.5,
      borderColor: palette.borderDefault,
      backgroundColor: palette.bgSurface,
      paddingHorizontal: 16,
      justifyContent: 'center',
    },
    numberFieldValid: {
      borderColor: palette.accent,
    },
    numberFieldInput: {
      fontSize: 17,
      fontWeight: '500',
      color: palette.textPrimary,
      fontVariant: ['tabular-nums'],
      padding: 0,
    },
    legal: {
      fontSize: 12,
      lineHeight: 18,
      color: palette.textTertiary,
      textAlign: 'center',
      marginBottom: 14,
      paddingHorizontal: 12,
    },
    legalLink: {
      color: palette.textSecondary,
      textDecorationLine: 'underline',
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
