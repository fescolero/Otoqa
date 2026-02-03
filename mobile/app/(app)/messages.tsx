import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, typography, spacing } from '../../lib/theme';
import { useLanguage } from '../../lib/LanguageContext';

// ============================================
// MESSAGES SCREEN
// Coming Soon - Driver Communication
// ============================================

export default function MessagesScreen() {
  const { t } = useLanguage();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('messages.title')}</Text>
      </View>
      <View style={styles.content}>
        <Ionicons name="chatbubbles-outline" size={64} color={colors.foregroundMuted} />
        <Text style={styles.title}>{t('messages.comingSoon')}</Text>
        <Text style={styles.description}>
          {t('messages.comingSoonDesc')}
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
