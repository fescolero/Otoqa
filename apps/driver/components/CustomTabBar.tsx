import { View, Pressable, Text, StyleSheet } from 'react-native';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Ionicons, Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../lib/theme';

// ============================================
// CUSTOM TAB BAR for iOS
// Used via React Navigation's tabBar prop
// Floating pill design with proper touch handling
// ============================================

// Icon mapping for routes
const iconMap: Record<string, { icon: string; iconFocused: string; family: 'ionicons' | 'feather' }> = {
  index: { icon: 'home-outline', iconFocused: 'home', family: 'ionicons' },
  drivers: { icon: 'people-outline', iconFocused: 'people', family: 'ionicons' },
  profile: { icon: 'person-outline', iconFocused: 'person', family: 'ionicons' },
  more: { icon: 'more-horizontal', iconFocused: 'more-horizontal', family: 'feather' },
  messages: { icon: 'chatbubble-outline', iconFocused: 'chatbubble', family: 'ionicons' },
  settings: { icon: 'person-outline', iconFocused: 'person', family: 'ionicons' },
};

export function CustomTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  // Filter to only show visible routes (not href: null)
  const visibleRoutes = state.routes.filter((route) => {
    const { options } = descriptors[route.key];
    // Check if route should be hidden
    const href = (options as { href?: string | null }).href;
    if (href === null) return false;
    if (options.tabBarButton && typeof options.tabBarButton === 'function') {
      try {
        const result = options.tabBarButton({ children: null } as any);
        if (result === null) return false;
      } catch {}
    }
    return true;
  });

  const renderIcon = (routeName: string, isFocused: boolean) => {
    const iconConfig = iconMap[routeName] || { icon: 'help-outline', iconFocused: 'help', family: 'ionicons' };
    const iconName = isFocused ? iconConfig.iconFocused : iconConfig.icon;
    const color = isFocused ? colors.primary : colors.foregroundMuted;
    const size = 24;

    if (iconConfig.family === 'feather') {
      return <Feather name={iconName as any} size={size} color={color} />;
    }
    return <Ionicons name={iconName as any} size={size} color={color} />;
  };

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom > 0 ? insets.bottom : 20 }]}>
      <View style={styles.tabBar}>
        {visibleRoutes.map((route) => {
          const { options } = descriptors[route.key];
          const label = options.tabBarLabel ?? options.title ?? route.name;
          const isFocused = state.index === state.routes.indexOf(route);

          const onPress = () => {
            console.log('CustomTabBar pressed:', route.name);
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });

            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          return (
            <Pressable
              key={route.key}
              accessibilityRole="button"
              accessibilityState={isFocused ? { selected: true } : {}}
              accessibilityLabel={options.tabBarAccessibilityLabel}
              onPress={onPress}
              style={({ pressed }) => [
                styles.tabItem,
                pressed && { opacity: 0.7 }
              ]}
            >
              <View style={styles.iconContainer}>
                {renderIcon(route.name, isFocused)}
              </View>
              <Text style={[styles.label, isFocused && styles.labelActive]}>
                {typeof label === 'string' ? label : route.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    backgroundColor: colors.background,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 32,
    paddingVertical: 12,
    paddingHorizontal: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  iconContainer: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 10,
    fontWeight: '500',
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  labelActive: {
    color: colors.primary,
  },
});
