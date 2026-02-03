import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useLanguage } from '../../lib/LanguageContext';

// ============================================
// DESIGN SYSTEM
// ============================================
const colors = {
  background: '#1a1d21',
  foreground: '#f3f4f6',
  foregroundMuted: '#9ca3af',
  primary: '#ff6b00',
  muted: '#2d323b',
  card: '#22262b',
  border: '#3f4552',
  success: '#10b981',
};

const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
};

const borderRadius = {
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 20,
};

// ============================================
// LANGUAGE SELECTION SCREEN
// ============================================

export default function LanguageScreen() {
  const router = useRouter();
  const { currentLanguage, changeLanguage, t, availableLanguages } = useLanguage();

  const handleSelectLanguage = async (languageCode: string) => {
    await changeLanguage(languageCode);
    router.back();
  };

  const getLanguageLabel = (code: string): string => {
    switch (code) {
      case 'system':
        return t('languages.systemDefault');
      case 'en':
        return t('languages.english');
      case 'es':
        return t('languages.spanish');
      default:
        return code;
    }
  };

  const getNativeLanguageLabel = (code: string): string => {
    switch (code) {
      case 'system':
        return 'System Default';
      case 'en':
        return 'English';
      case 'es':
        return 'Español';
      default:
        return code;
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <Ionicons name="arrow-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('languages.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.sectionTitle}>{t('languages.selectLanguage')}</Text>

        <View style={styles.languageList}>
          {availableLanguages.map((lang, index) => {
            const isSelected = currentLanguage === lang.code;
            const isLast = index === availableLanguages.length - 1;

            return (
              <TouchableOpacity
                key={lang.code}
                style={[
                  styles.languageItem,
                  isLast && styles.languageItemLast,
                ]}
                onPress={() => handleSelectLanguage(lang.code)}
              >
                <View style={styles.languageInfo}>
                  <Text style={styles.languageLabel}>
                    {getNativeLanguageLabel(lang.code)}
                  </Text>
                  {lang.code !== 'system' && (
                    <Text style={styles.languageSublabel}>
                      {getLanguageLabel(lang.code)}
                    </Text>
                  )}
                </View>
                {isSelected && (
                  <Ionicons
                    name="checkmark-circle"
                    size={24}
                    color={colors.primary}
                  />
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.note}>
          {currentLanguage === 'system'
            ? 'Using your device\'s language setting.'
            : `Currently using ${getNativeLanguageLabel(currentLanguage)}.`}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: '700',
    color: colors.foreground,
    textAlign: 'center',
  },
  headerSpacer: {
    width: 40,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.foregroundMuted,
    marginBottom: spacing.md,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  languageList: {
    backgroundColor: colors.card,
    borderRadius: borderRadius['2xl'],
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: `${colors.border}50`,
  },
  languageItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: `${colors.border}30`,
  },
  languageItemLast: {
    borderBottomWidth: 0,
  },
  languageInfo: {
    flex: 1,
  },
  languageLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.foreground,
  },
  languageSublabel: {
    fontSize: 14,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  note: {
    fontSize: 14,
    color: colors.foregroundMuted,
    marginTop: spacing.lg,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
});
