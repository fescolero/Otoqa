import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@clerk/clerk-expo';
import { View, ActivityIndicator, StyleSheet } from 'react-native';

// ============================================
// AUTH LAYOUT
// Redirects to app if already signed in
// ============================================

export default function AuthLayout() {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#4f46e5" />
      </View>
    );
  }

  if (isSignedIn) {
    return <Redirect href="/(app)" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: {
          backgroundColor: '#1a1a2e',
        },
      }}
    >
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="verify" />
    </Stack>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1a1a2e',
  },
});

