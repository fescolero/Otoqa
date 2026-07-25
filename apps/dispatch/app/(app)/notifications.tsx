/** Notifications — Phase 2 wires the dispatchAlerts feed (split-plan §5.2). */
import { Text, View } from 'react-native';
import { colors, typography } from '@otoqa/mobile-core';

export default function NotificationsScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, padding: 24, paddingTop: 70 }}>
      <Text style={{ fontSize: typography['2xl'], fontWeight: typography.bold, color: colors.foreground }}>
        Notifications
      </Text>
      <View style={{ marginTop: 40, alignItems: 'center' }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center', lineHeight: 20 }}>
          Nothing slipping.{'\n'}Operational alerts appear here as they happen.
        </Text>
      </View>
    </View>
  );
}
