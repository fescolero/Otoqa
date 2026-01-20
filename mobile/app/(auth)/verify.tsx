import { useState, useRef, useEffect } from 'react';
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
import { useRouter, useLocalSearchParams } from 'expo-router';

// ============================================
// OTP VERIFICATION SCREEN
// 6-digit code verification
// ============================================

export default function VerifyScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const router = useRouter();
  const { phoneNumber } = useLocalSearchParams<{ phoneNumber: string }>();

  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [isLoading, setIsLoading] = useState(false);
  const [resendTimer, setResendTimer] = useState(30);

  const inputRefs = useRef<(TextInput | null)[]>([]);

  // Countdown timer for resend
  useEffect(() => {
    if (resendTimer > 0) {
      const timer = setTimeout(() => setResendTimer(resendTimer - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [resendTimer]);

  // Handle code input
  const handleCodeChange = (text: string, index: number) => {
    // Only allow numbers
    const digit = text.replace(/\D/g, '').slice(-1);
    
    const newCode = [...code];
    newCode[index] = digit;
    setCode(newCode);

    // Auto-advance to next input
    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when complete
    if (digit && index === 5) {
      handleVerify(newCode.join(''));
    }
  };

  // Handle backspace
  const handleKeyPress = (e: any, index: number) => {
    if (e.nativeEvent.key === 'Backspace' && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  // Verify the code
  const handleVerify = async (fullCode?: string) => {
    if (!isLoaded) return;

    const codeToVerify = fullCode || code.join('');
    
    if (codeToVerify.length !== 6) {
      Alert.alert('Invalid Code', 'Please enter the 6-digit code');
      return;
    }

    setIsLoading(true);

    try {
      const result = await signIn.attemptFirstFactor({
        strategy: 'phone_code',
        code: codeToVerify,
      });

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        router.replace('/(app)');
      } else {
        Alert.alert('Error', 'Verification incomplete. Please try again.');
      }
    } catch (error: any) {
      console.error('Verification error:', error);
      
      if (error.errors?.[0]?.code === 'form_code_incorrect') {
        Alert.alert('Invalid Code', 'The code you entered is incorrect. Please try again.');
        setCode(['', '', '', '', '', '']);
        inputRefs.current[0]?.focus();
      } else {
        Alert.alert(
          'Error',
          error.errors?.[0]?.message || 'Verification failed'
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Resend code
  const handleResend = async () => {
    if (!isLoaded || resendTimer > 0) return;

    try {
      await signIn.prepareFirstFactor({
        strategy: 'phone_code',
        phoneNumberId: signIn.supportedFirstFactors?.find(
          (factor) => factor.strategy === 'phone_code'
        )?.phoneNumberId as string,
      });

      setResendTimer(30);
      Alert.alert('Code Sent', 'A new verification code has been sent.');
    } catch (error: any) {
      Alert.alert('Error', 'Failed to resend code. Please try again.');
    }
  };

  // Format phone for display
  const formattedPhone = phoneNumber
    ? phoneNumber.replace(/(\+1)(\d{3})(\d{3})(\d{4})/, '$1 ($2) $3-$4')
    : '';

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <View style={styles.content}>
        {/* Header */}
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <Text style={styles.backButtonText}>← Back</Text>
        </TouchableOpacity>

        <View style={styles.header}>
          <Text style={styles.title}>Enter Verification Code</Text>
          <Text style={styles.subtitle}>
            We sent a 6-digit code to{'\n'}
            <Text style={styles.phoneText}>{formattedPhone}</Text>
          </Text>
        </View>

        {/* Code Input */}
        <View style={styles.codeContainer}>
          {code.map((digit, index) => (
            <TextInput
              key={index}
              ref={(ref) => (inputRefs.current[index] = ref)}
              style={[
                styles.codeInput,
                digit && styles.codeInputFilled,
              ]}
              value={digit}
              onChangeText={(text) => handleCodeChange(text, index)}
              onKeyPress={(e) => handleKeyPress(e, index)}
              keyboardType="number-pad"
              maxLength={1}
              selectTextOnFocus
              autoFocus={index === 0}
            />
          ))}
        </View>

        {/* Verify Button */}
        <TouchableOpacity
          style={[styles.button, isLoading && styles.buttonDisabled]}
          onPress={() => handleVerify()}
          disabled={isLoading || code.join('').length !== 6}
        >
          <Text style={styles.buttonText}>
            {isLoading ? 'Verifying...' : 'Verify'}
          </Text>
        </TouchableOpacity>

        {/* Resend */}
        <View style={styles.resendContainer}>
          <Text style={styles.resendText}>Didn't receive the code? </Text>
          {resendTimer > 0 ? (
            <Text style={styles.timerText}>Resend in {resendTimer}s</Text>
          ) : (
            <TouchableOpacity onPress={handleResend}>
              <Text style={styles.resendLink}>Resend Code</Text>
            </TouchableOpacity>
          )}
        </View>
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
  },
  backButton: {
    marginTop: 48,
    marginBottom: 24,
  },
  backButtonText: {
    color: '#4f46e5',
    fontSize: 16,
  },
  header: {
    marginBottom: 48,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    color: '#9ca3af',
    lineHeight: 24,
  },
  phoneText: {
    color: '#fff',
    fontWeight: '600',
  },
  codeContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 32,
  },
  codeInput: {
    width: 48,
    height: 56,
    backgroundColor: '#16213e',
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#374151',
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
  },
  codeInputFilled: {
    borderColor: '#4f46e5',
  },
  button: {
    backgroundColor: '#4f46e5',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 24,
  },
  buttonDisabled: {
    backgroundColor: '#374151',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  resendContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  resendText: {
    color: '#6b7280',
    fontSize: 14,
  },
  timerText: {
    color: '#9ca3af',
    fontSize: 14,
  },
  resendLink: {
    color: '#4f46e5',
    fontSize: 14,
    fontWeight: '600',
  },
});

