import { Stack } from 'expo-router';
import { colors } from '../../../lib/theme';

export default function OwnerLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="assign-driver" />
      <Stack.Screen name="loads" />
      <Stack.Screen name="tracking" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="settlements" />
      <Stack.Screen name="feature-unavailable" />
      <Stack.Screen name="complete-driver-profile" />
    </Stack>
  );
}
