import React from 'react';
import { View, StyleSheet, Animated } from 'react-native';
import { colors, borderRadius, shadows, spacing } from '../lib/theme';

// ============================================
// SKELETON LOADER
// Dark Theme Loading Placeholders
// ============================================

interface SkeletonProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  style?: object;
}

export function Skeleton({ 
  width = '100%', 
  height = 16, 
  borderRadius: radius = 8,
  style 
}: SkeletonProps) {
  return (
    <View
      style={[
        styles.skeleton,
        { 
          width, 
          height, 
          borderRadius: radius 
        },
        style,
      ]}
    />
  );
}

export function SkeletonCard() {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Skeleton width={100} height={20} />
        <Skeleton width={80} height={24} />
      </View>
      <View style={styles.cardContent}>
        <Skeleton width="70%" height={18} style={{ marginBottom: 12 }} />
        <Skeleton width="50%" height={14} />
      </View>
    </View>
  );
}

export function SkeletonSmallCard() {
  return (
    <View style={styles.smallCard}>
      <View style={styles.row}>
        <Skeleton width={60} height={14} />
        <Skeleton width={80} height={20} />
      </View>
      <Skeleton width="80%" height={16} style={{ marginTop: 12 }} />
      <Skeleton width="60%" height={14} style={{ marginTop: 8 }} />
    </View>
  );
}

export function SkeletonCurrentLoad() {
  return (
    <View style={styles.currentLoadSkeleton}>
      <View style={styles.row}>
        <View style={styles.currentLoadLeft}>
          <Skeleton width={40} height={40} borderRadius={20} />
          <View>
            <Skeleton width={80} height={12} style={{ marginBottom: 6 }} />
            <Skeleton width={100} height={24} />
          </View>
        </View>
        <View>
          <Skeleton width={60} height={12} style={{ marginBottom: 6 }} />
          <Skeleton width={80} height={24} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  skeleton: {
    backgroundColor: colors.muted,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.md,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  cardContent: {
    paddingTop: spacing.sm,
  },
  smallCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.base,
    marginBottom: spacing.base,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  currentLoadSkeleton: {
    backgroundColor: colors.primary + '30',
    borderRadius: borderRadius['2xl'],
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  currentLoadLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
});
