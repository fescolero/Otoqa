import React from 'react';
import { View, Pressable, StyleSheet, Text } from 'react-native';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, shadows } from '../lib/theme';

// ============================================
// GLASS TAB BAR
// Custom floating tab bar for driver mode
// ============================================

const NAV_HORIZONTAL_MARGIN = 24;
const TAB_BAR_HEIGHT = 70;

// Known visible tab routes - routes not in this list are hidden
const VISIBLE_TAB_ROUTES = ['index', 'messages', 'settings', 'more'];

export function GlassTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  
  // Filter to only show known visible tab routes
  const visibleRoutes = state.routes.filter((route) => 
    VISIBLE_TAB_ROUTES.includes(route.name)
  );
  
  return (
    <View style={styles.wrapper}>
      <View style={[styles.container, { marginBottom: Math.max(insets.bottom, 16) }]}>
        {visibleRoutes.map((route) => {
          const { options } = descriptors[route.key];
          // Find the actual index in state.routes for isFocused check
          const actualIndex = state.routes.findIndex(r => r.key === route.key);
          const isFocused = state.index === actualIndex;
          
          const onPress = () => {
            console.log('[GlassTabBar] Tab pressed:', route.name);
            
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });

            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name as never);
            }
          };

          const onLongPress = () => {
            navigation.emit({
              type: 'tabLongPress',
              target: route.key,
            });
          };

          // Get label
          const label = typeof options.tabBarLabel === 'string' 
            ? options.tabBarLabel 
            : options.title !== undefined 
              ? options.title 
              : route.name;

          const tabBarTestID = (options as { tabBarTestID?: string }).tabBarTestID;

          return (
            <Pressable
              key={route.key}
              accessibilityRole="button"
              accessibilityState={isFocused ? { selected: true } : {}}
              accessibilityLabel={options.tabBarAccessibilityLabel}
              testID={tabBarTestID}
              onPress={onPress}
              onLongPress={onLongPress}
              style={styles.tabButton}
            >
              {/* Selected indicator */}
              {isFocused && (
                <View style={styles.selectedIndicator} />
              )}
              
              {/* Icon */}
              <View style={styles.iconContainer}>
                {options.tabBarIcon?.({
                  focused: isFocused,
                  color: isFocused ? colors.foreground : colors.foregroundMuted,
                  size: 22,
                })}
              </View>
              
              {/* Label */}
              <Text
                style={[
                  styles.label,
                  { color: isFocused ? colors.foreground : colors.foregroundMuted },
                  isFocused && styles.labelFocused,
                ]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: NAV_HORIZONTAL_MARGIN,
  },
  container: {
    height: TAB_BAR_HEIGHT,
    borderRadius: 35,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: 'rgba(63, 69, 82, 0.5)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    ...shadows.lg,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: 50,
    borderRadius: 20,
  },
  selectedIndicator: {
    position: 'absolute',
    top: 4,
    left: 4,
    right: 4,
    bottom: 4,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
  iconContainer: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 10,
    fontWeight: '500',
    marginTop: 2,
  },
  labelFocused: {
    fontWeight: '600',
  },
});
