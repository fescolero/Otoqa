/** Board — Phase 1 builds the capacity board here; scaffold shows org context. */
import { Text, View } from 'react-native';
import { colors, typography } from '@otoqa/mobile-core';
import { useDispatchSession } from './_layout';

export default function BoardScreen() {
  const session = useDispatchSession();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, padding: 24, paddingTop: 70 }}>
      <Text style={{ fontSize: typography['2xl'], fontWeight: typography.bold, color: colors.foreground }}>
        Board
      </Text>
      <Text style={{ fontSize: typography.sm, color: colors.foregroundMuted, marginTop: 6 }}>
        {session?.orgName ?? 'Your organization'}
      </Text>
      <View style={{ marginTop: 40, alignItems: 'center' }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center', lineHeight: 20 }}>
          No loads on the board yet.{'\n'}Loads assigned to your organization appear here.
        </Text>
      </View>
    </View>
  );
}
