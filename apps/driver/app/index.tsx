import { Redirect } from 'expo-router';
import { useAuth } from '@clerk/clerk-expo';

// ============================================
// ROOT INDEX
// Redirects to appropriate screen based on auth state
// ============================================

export default function Index() {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) {
    return null;
  }

  if (isSignedIn) {
    return <Redirect href="/(app)" />;
  }

  return <Redirect href="/(auth)/sign-in" />;
}

