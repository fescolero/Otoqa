import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, typography, borderRadius, spacing, shadows } from '../../../lib/theme';

// ============================================
// FEATURE UNAVAILABLE SCREEN
// Shown when a feature is not yet available
// ============================================

export default function FeatureUnavailableScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { feature } = useLocalSearchParams<{ feature?: string }>();

  const featureName = feature || 'This feature';

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Content */}
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Ionicons name="construct-outline" size={48} color={colors.primary} />
        </View>
        
        <Text style={styles.title}>Coming Soon</Text>
        
        <Text style={styles.subtitle}>
          {featureName} is not available at the moment. We're working hard to bring this feature to you soon.
        </Text>

        <TouchableOpacity style={styles.backButtonLarge} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={20} color={colors.primaryForeground} />
          <Text style={styles.backButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  iconContainer: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
    ...shadows.md,
  },
  title: {
    fontSize: typography['2xl'],
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: typography.base,
    color: colors.foregroundMuted,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: spacing.xl,
  },
  backButtonLarge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.lg,
    gap: spacing.sm,
  },
  backButtonText: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.primaryForeground,
  },
});
