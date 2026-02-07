import { View, Pressable, Text, StyleSheet } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { Ionicons, Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../lib/theme';

// ============================================
// CUSTOM iOS TAB BAR
// Built from scratch to avoid React Navigation touch bugs
// Floating pill design with proper touch handling
// ============================================

type TabConfig = {
  name: string;
  path: string;
  label: string;
  icon: string;
  iconFocused: string;
  iconFamily: 'ionicons' | 'feather';
};

type IOSTabBarProps = {
  tabs: TabConfig[];
  basePath: string;
};

export function IOSTabBar({ tabs, basePath }: IOSTabBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  // Determine which tab is active based on current path
  const getIsActive = (tab: TabConfig) => {
    const fullPath = `${basePath}/${tab.name}`.replace('/index', '');
    // Handle index route
    if (tab.name === 'index') {
      return pathname === basePath || pathname === `${basePath}/`;
    }
    return pathname.startsWith(fullPath);
  };

  const handlePress = (tab: TabConfig) => {
    const fullPath = tab.name === 'index' ? basePath : `${basePath}/${tab.name}`;
    router.push(fullPath as any);
  };

  const renderIcon = (tab: TabConfig, isActive: boolean) => {
    const iconName = isActive ? tab.iconFocused : tab.icon;
    const color = isActive ? colors.primary : colors.foregroundMuted;
    const size = 24;

    if (tab.iconFamily === 'feather') {
      return <Feather name={iconName as any} size={size} color={color} />;
    }
    return <Ionicons name={iconName as any} size={size} color={color} />;
  };

  return (
    <View 
      style={[styles.container, { paddingBottom: insets.bottom > 0 ? insets.bottom : 20 }]}
      pointerEvents="box-none"
    >
      <View style={styles.tabBar} pointerEvents="auto">
        {tabs.map((tab) => {
          const isActive = getIsActive(tab);
          return (
            <Pressable
              key={tab.name}
              style={({ pressed }) => [
                styles.tabItem,
                pressed && { opacity: 0.7 }
              ]}
              onPress={() => {
                console.log('Tab pressed:', tab.name);
                handlePress(tab);
              }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <View style={styles.iconContainer}>
                {renderIcon(tab, isActive)}
              </View>
              <Text style={[styles.label, isActive && styles.labelActive]}>
                {tab.label}
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
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    backgroundColor: 'transparent',
    zIndex: 9999,
    elevation: 9999,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 32,
    paddingVertical: 12,
    paddingHorizontal: 8,
    // Shadow
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
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
