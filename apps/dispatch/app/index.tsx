/** Entry: route by auth state — signed-in users to the app, others to sign-in. */
import { Redirect } from 'expo-router';
import { useConvexAuth } from 'convex/react';
import { ActivityIndicator, View } from 'react-native';
import { colors } from '../lib/theme';

export default function Index() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  return isAuthenticated ? <Redirect href="/(app)" /> : <Redirect href="/(auth)/sign-in" />;
}
