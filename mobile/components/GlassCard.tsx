import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { BlurView } from 'expo-blur';
import {
  colors,
  borderRadius,
  spacing,
  isIOS,
  blurIntensity,
  glassCard,
  glassCardLight,
} from '../lib/theme';

// ============================================
// GLASS CARD COMPONENT
// Platform-adaptive card with iOS blur effect
// iOS: Translucent glass with vibrancy blur
// Android: Solid Material Design card
// ============================================

export type GlassCardVariant = 'default' | 'light' | 'primary';
export type BlurIntensityLevel = 'light' | 'medium' | 'heavy';

interface GlassCardProps {
  children: React.ReactNode;
  variant?: GlassCardVariant;
  intensity?: BlurIntensityLevel;
  style?: StyleProp<ViewStyle>;
  innerStyle?: StyleProp<ViewStyle>;
  borderRadiusSize?: keyof typeof borderRadius;
  padding?: keyof typeof spacing | number;
  noPadding?: boolean;
}

export function GlassCard({
  children,
  variant = 'default',
  intensity = 'medium',
  style,
  innerStyle,
  borderRadiusSize = 'xl',
  padding = 'base',
  noPadding = false,
}: GlassCardProps) {
  const radiusValue = borderRadius[borderRadiusSize];
  const paddingValue = noPadding
    ? 0
    : typeof padding === 'number'
      ? padding
      : spacing[padding];

  // Get variant-specific styles
  const getVariantStyles = (): ViewStyle => {
    switch (variant) {
      case 'primary':
        return {
          backgroundColor: isIOS ? 'rgba(255, 107, 0, 0.85)' : colors.primary,
          borderColor: isIOS ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
          borderWidth: isIOS ? 1 : 0,
        };
      case 'light':
        return glassCardLight;
      default:
        return glassCard;
    }
  };

  const variantStyles = getVariantStyles();

  // iOS: Use BlurView for glass effect
  if (isIOS) {
    return (
      <View
        style={[
          styles.container,
          { borderRadius: radiusValue },
          variantStyles,
          style,
        ]}
      >
        <BlurView
          intensity={blurIntensity[intensity]}
          tint="dark"
          style={[
            styles.blurView,
            { borderRadius: radiusValue, padding: paddingValue },
            innerStyle,
          ]}
        >
          {children}
        </BlurView>
      </View>
    );
  }

  // Android: Use regular View with solid background
  return (
    <View
      style={[
        styles.container,
        styles.androidCard,
        { borderRadius: radiusValue, padding: paddingValue },
        variantStyles,
        style,
        innerStyle,
      ]}
    >
      {children}
    </View>
  );
}

// ============================================
// GLASS SURFACE - Lightweight blur surface
// For overlays, modals, and floating elements
// ============================================

interface GlassSurfaceProps {
  children: React.ReactNode;
  intensity?: BlurIntensityLevel;
  style?: StyleProp<ViewStyle>;
}

export function GlassSurface({
  children,
  intensity = 'heavy',
  style,
}: GlassSurfaceProps) {
  if (isIOS) {
    return (
      <BlurView
        intensity={blurIntensity[intensity]}
        tint="dark"
        style={[styles.surface, style]}
      >
        {children}
      </BlurView>
    );
  }

  return (
    <View style={[styles.surface, styles.androidSurface, style]}>
      {children}
    </View>
  );
}

// ============================================
// GLASS BADGE - Small glass-effect badge
// For status indicators and labels
// ============================================

interface GlassBadgeProps {
  children: React.ReactNode;
  color?: string;
  style?: StyleProp<ViewStyle>;
}

export function GlassBadge({ children, color, style }: GlassBadgeProps) {
  const badgeColor = color || colors.primary;
  
  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: isIOS
            ? `${badgeColor}40` // 25% opacity for iOS
            : `${badgeColor}30`, // 19% opacity for Android
          borderColor: isIOS ? `${badgeColor}60` : 'transparent',
          borderWidth: isIOS ? 1 : 0,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  blurView: {
    flex: 1,
  },
  androidCard: {
    // Android-specific card styling
  },
  surface: {
    overflow: 'hidden',
  },
  androidSurface: {
    backgroundColor: colors.card,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
});
