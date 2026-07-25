/** Drivers — Phase 1 wires the fleet list (dispatchMobile read wrappers). */
import { Text, View } from 'react-native';
import { colors, typography } from '@otoqa/mobile-core';

export default function DriversScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, padding: 24, paddingTop: 70 }}>
      <Text style={{ fontSize: typography['2xl'], fontWeight: typography.bold, color: colors.foreground }}>
        Drivers
      </Text>
      <View style={{ marginTop: 40, alignItems: 'center' }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center', lineHeight: 20 }}>
          No drivers yet.{'\n'}Drivers added to your organization appear here.
        </Text>
      </View>
    </View>
  );
}
