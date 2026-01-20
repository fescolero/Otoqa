import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, typography, spacing } from '../../lib/theme';

// ============================================
// MESSAGES SCREEN
// Coming Soon - Driver Communication
// ============================================

export default function MessagesScreen() {
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Messages</Text>
      </View>
      <View style={styles.content}>
        <Ionicons name="chatbubbles-outline" size={64} color={colors.foregroundMuted} />
        <Text style={styles.title}>Coming Soon</Text>
        <Text style={styles.description}>
          Communicate with dispatch and receive important updates directly in the app.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontSize: typography['2xl'],
    fontWeight: typography.bold,
    color: colors.foreground,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  title: {
    fontSize: typography.xl,
    fontWeight: typography.semibold,
    color: colors.foreground,
    marginTop: 24,
    marginBottom: 12,
  },
  description: {
    fontSize: typography.base,
    color: colors.foregroundMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
});
