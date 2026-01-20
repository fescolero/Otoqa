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
} from 'react-native';
import { useSignIn } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';

// ============================================
// SIGN IN SCREEN
// Phone number input for driver authentication
// ============================================

export default function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const router = useRouter();

  const [phoneNumber, setPhoneNumber] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Format phone number as user types
  const formatPhoneNumber = (text: string) => {
    // Remove all non-numeric characters
    const cleaned = text.replace(/\D/g, '');
    
    // Format as (XXX) XXX-XXXX
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
    if (!isLoaded) return;

    // Get raw phone number
    const rawPhone = phoneNumber.replace(/\D/g, '');
    
    if (rawPhone.length < 10) {
      Alert.alert('Invalid Phone', 'Please enter a valid 10-digit phone number');
      return;
    }

    setIsLoading(true);

    try {
      // Start the sign-in process with phone number
      const result = await signIn.create({
        identifier: `+1${rawPhone}`, // Assuming US numbers
      });

      // Request phone code verification
      await signIn.prepareFirstFactor({
        strategy: 'phone_code',
        phoneNumberId: result.supportedFirstFactors?.find(
          (factor) => factor.strategy === 'phone_code'
        )?.phoneNumberId as string,
      });

      // Navigate to verification screen
      router.push({
        pathname: '/(auth)/verify',
        params: { phoneNumber: `+1${rawPhone}` },
      });
    } catch (error: any) {
      console.error('Sign in error:', error);
      
      // Handle specific errors
      if (error.errors?.[0]?.code === 'form_identifier_not_found') {
        Alert.alert(
          'Not Registered',
          'This phone number is not registered as a driver. Please contact your dispatcher.'
        );
      } else {
        Alert.alert(
          'Error',
          error.errors?.[0]?.message || 'Failed to send verification code'
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <View style={styles.content}>
        {/* Logo/Header */}
        <View style={styles.header}>
          <Text style={styles.logo}>🚛</Text>
          <Text style={styles.title}>Otoqa Driver</Text>
          <Text style={styles.subtitle}>Sign in with your phone number</Text>
        </View>

        {/* Phone Input */}
        <View style={styles.form}>
          <Text style={styles.label}>Phone Number</Text>
          <View style={styles.phoneInputContainer}>
            <Text style={styles.countryCode}>+1</Text>
            <TextInput
              style={styles.phoneInput}
              value={phoneNumber}
              onChangeText={handlePhoneChange}
              placeholder="(555) 555-5555"
              placeholderTextColor="#6b7280"
              keyboardType="phone-pad"
              autoComplete="tel"
              maxLength={14}
            />
          </View>

          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={handleSendCode}
            disabled={isLoading || phoneNumber.replace(/\D/g, '').length < 10}
          >
            <Text style={styles.buttonText}>
              {isLoading ? 'Sending...' : 'Send Verification Code'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Footer */}
        <Text style={styles.footer}>
          Only registered drivers can sign in.{'\n'}
          Contact your dispatcher if you need access.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  content: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 48,
  },
  logo: {
    fontSize: 64,
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#9ca3af',
  },
  form: {
    marginBottom: 32,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#d1d5db',
    marginBottom: 8,
  },
  phoneInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16213e',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#374151',
    marginBottom: 24,
  },
  countryCode: {
    paddingHorizontal: 16,
    fontSize: 18,
    color: '#9ca3af',
    borderRightWidth: 1,
    borderRightColor: '#374151',
  },
  phoneInput: {
    flex: 1,
    padding: 16,
    fontSize: 18,
    color: '#fff',
  },
  button: {
    backgroundColor: '#4f46e5',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#374151',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  footer: {
    textAlign: 'center',
    color: '#6b7280',
    fontSize: 14,
    lineHeight: 20,
  },
});

