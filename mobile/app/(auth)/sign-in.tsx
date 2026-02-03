import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ScrollView,
  Linking,
} from 'react-native';
import { useSignIn } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, typography, borderRadius, shadows, spacing } from '../../lib/theme';
import { LinearGradient } from 'expo-linear-gradient';

// ============================================
// SIGN IN SCREEN
// Phone number input with invite-only access
// ============================================

export default function SignInScreen() {
  const { signIn, isLoaded } = useSignIn();
  const router = useRouter();

  const [phoneNumber, setPhoneNumber] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [countryCode, setCountryCode] = useState('+1');

  // Format phone number as user types
  const formatPhoneNumber = (text: string) => {
    const cleaned = text.replace(/\D/g, '');
    
    if (cleaned.length <= 3) {
      return cleaned;
    } else if (cleaned.length <= 6) {
      return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3)}`;
    } else {
      return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6, 10)}`;
    }
  };

  const handlePhoneChange = (text: string) => {
    setPhoneNumber(formatPhoneNumber(text));
  };

  const handleSendCode = async () => {
    console.log('🔐 handleSendCode called, isLoaded:', isLoaded, 'signIn:', !!signIn);
    
    if (!isLoaded) {
      console.log('❌ Clerk not loaded yet');
      return;
    }
    
    if (!signIn) {
      console.log('❌ signIn object is null/undefined');
      Alert.alert('Error', 'Authentication not ready. Please restart the app.');
      return;
    }

    const rawPhone = phoneNumber.replace(/\D/g, '');
    
    if (rawPhone.length < 10) {
      Alert.alert('Invalid Phone', 'Please enter a valid 10-digit phone number');
      return;
    }

    setIsLoading(true);
    
    // Ensure E.164 format: +1 followed by 10 digits
    const fullPhoneNumber = `+1${rawPhone}`;
    console.log('🔐 Attempting sign-in with:', fullPhoneNumber);
    console.log('🔐 Current signIn state:', signIn.status);

    try {
      // Clear any existing sign-in attempt first
      if (signIn.status !== null) {
        console.log('🔄 Clearing existing sign-in state...');
      }
      
      const result = await signIn.create({
        identifier: fullPhoneNumber,
      });
      
      console.log('✅ Sign-in created successfully!');
      console.log('✅ Status:', result.status);
      console.log('✅ Supported factors:', JSON.stringify(result.supportedFirstFactors));

      await signIn.prepareFirstFactor({
        strategy: 'phone_code',
        phoneNumberId: result.supportedFirstFactors?.find(
          (factor) => factor.strategy === 'phone_code'
        )?.phoneNumberId as string,
      });

      router.push({
        pathname: '/(auth)/verify',
        params: { phoneNumber: fullPhoneNumber },
      });
    } catch (error: any) {
      console.error('Sign in error:', error);
      console.error('Full error details:', JSON.stringify(error, null, 2));
      
      const errorCode = error.errors?.[0]?.code;
      const errorMessage = error.errors?.[0]?.message || error.errors?.[0]?.longMessage;
      
      if (errorCode === 'form_identifier_not_found') {
        Alert.alert(
          'Not Registered',
          `This phone number (${fullPhoneNumber}) is not registered. This app is invite-only. Please contact your company administrator.`
        );
      } else if (errorCode === 'form_param_format_invalid') {
        Alert.alert(
          'Invalid Format',
          'Please enter a valid phone number in the format (555) 000-0000'
        );
      } else if (errorCode === 'strategy_for_user_invalid') {
        Alert.alert(
          'Phone Sign-In Not Enabled',
          'This account exists but is not set up for phone sign-in. Please contact your administrator.'
        );
      } else {
        Alert.alert(
          'Error',
          errorMessage || `Sign-in failed (${errorCode || 'unknown'})`
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  const isButtonDisabled = isLoading || phoneNumber.replace(/\D/g, '').length < 10;

  return (
    <View style={styles.container}>
      {/* Background gradient effect */}
      <LinearGradient
        colors={['rgba(255, 107, 0, 0.15)', 'transparent']}
        style={styles.gradientTop}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
      />
      
      {/* Dot pattern overlay - decorative */}
      <View style={styles.dotPattern} />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Invite Only Badge */}
          <View style={styles.badge}>
            <View style={styles.badgeDot} />
            <Text style={styles.badgeText}>Invite Only Access</Text>
          </View>

          {/* Header */}
          <Text style={styles.title}>Enter your number to continue</Text>
          <Text style={styles.subtitle}>
            This app is currently invite-only. Enter your mobile number to verify your invitation status and sign in.
          </Text>

          {/* Phone Input */}
          <View style={styles.inputSection}>
            <Text style={styles.label}>Mobile Number</Text>
            <View style={styles.phoneInputContainer}>
              {/* Country Code Selector */}
              <TouchableOpacity style={styles.countrySelector}>
                <Text style={styles.flag}>🇺🇸</Text>
                <Text style={styles.countryCode}>{countryCode}</Text>
                <Ionicons name="chevron-down" size={16} color={colors.foregroundMuted} />
              </TouchableOpacity>
              
              {/* Phone Number Input */}
              <TextInput
                style={styles.phoneInput}
                value={phoneNumber}
                onChangeText={handlePhoneChange}
                placeholder="(555) 000-0000"
                placeholderTextColor={colors.foregroundSubtle}
                keyboardType="phone-pad"
                autoComplete="tel"
                maxLength={14}
              />
            </View>

            {/* Helper text */}
            <View style={styles.helperRow}>
              <Ionicons name="shield-checkmark-outline" size={14} color={colors.foregroundMuted} />
              <Text style={styles.helperText}>We'll send you a verification code</Text>
            </View>
          </View>

          {/* Continue Button */}
          <TouchableOpacity
            style={[
              styles.button,
              isButtonDisabled && styles.buttonDisabled,
            ]}
            onPress={handleSendCode}
            disabled={isButtonDisabled}
            activeOpacity={0.8}
          >
            <Text style={styles.buttonText}>
              {isLoading ? 'Sending...' : 'Continue'}
            </Text>
            {!isLoading && (
              <Ionicons name="arrow-forward" size={20} color={colors.primaryForeground} />
            )}
          </TouchableOpacity>

          {/* Footer - Terms */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>
              By continuing, you acknowledge that you have read and understood, and agree to our{' '}
              <Text style={styles.link} onPress={() => Linking.openURL('https://otoqa.com/terms')}>
                Terms of Service
              </Text>
              {' '}and{' '}
              <Text style={styles.link} onPress={() => Linking.openURL('https://otoqa.com/privacy')}>
                Privacy Policy
              </Text>
              .
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  gradientTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 300,
  },
  dotPattern: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0.03,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: 120,
    paddingBottom: 40,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    marginBottom: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  badgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
    marginRight: spacing.sm,
  },
  badgeText: {
    fontSize: typography.sm,
    color: colors.primary,
    fontWeight: typography.medium,
  },
  title: {
    fontSize: typography['3xl'],
    fontWeight: typography.bold,
    color: colors.foreground,
    marginBottom: spacing.md,
    lineHeight: 38,
  },
  subtitle: {
    fontSize: typography.base,
    color: colors.foregroundMuted,
    lineHeight: 22,
    marginBottom: spacing['2xl'],
  },
  inputSection: {
    marginBottom: spacing.xl,
  },
  label: {
    fontSize: typography.sm,
    fontWeight: typography.medium,
    color: colors.foregroundMuted,
    marginBottom: spacing.sm,
  },
  phoneInputContainer: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  countrySelector: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.muted,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    gap: spacing.xs,
  },
  flag: {
    fontSize: 20,
  },
  countryCode: {
    fontSize: typography.md,
    color: colors.foreground,
    fontWeight: typography.medium,
  },
  phoneInput: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: typography.md,
    color: colors.foreground,
  },
  helperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  helperText: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.lg,
    gap: spacing.sm,
    ...shadows.md,
  },
  buttonDisabled: {
    backgroundColor: colors.muted,
  },
  buttonText: {
    fontSize: typography.md,
    fontWeight: typography.semibold,
    color: colors.primaryForeground,
  },
  footer: {
    marginTop: 'auto',
    paddingTop: spacing['2xl'],
  },
  footerText: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    textAlign: 'center',
    lineHeight: 18,
  },
  link: {
    color: colors.foreground,
    textDecorationLine: 'underline',
  },
});
