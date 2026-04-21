/**
 * App Settings — Otoqa Driver design system.
 *
 * Ports lib/app-settings-screen.jsx. The drill-in from the More tab's
 * "App settings" row. Grouped list:
 *   - Language (chip + opens a bottom-sheet picker)
 *   - Notifications (push toggle stub — wiring is out of scope here)
 *   - Region & units (distance + time format; local state for now)
 *   - Appearance (theme)
 *   - Privacy → /permissions
 *   - Download my data (placeholder)
 *
 * Language + Appearance are backed by real app state (LanguageContext
 * + ThemeContext). Notifications / units / download are visual stubs
 * until the corresponding backends land.
 */
import React, { useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Icon, type IconName } from '../../lib/design-icons';
import { useLanguage } from '../../lib/LanguageContext';
import {
  useTheme,
  type Density,
  type ThemePreference,
} from '../../lib/ThemeContext';
import { useDensityTokens } from '../../lib/density';
import {
  densitySpacing,
  radii,
  typeScale,
  type Palette,
} from '../../lib/design-tokens';

type Sp = (typeof densitySpacing)['dense'];

type UnitSystem = 'imperial' | 'metric';
type TimeFormat = '12h' | '24h';

const LANGUAGES: Array<{ code: string; label: string; region: string; flag: string }> = [
  { code: 'system', label: 'System', region: 'Follow device', flag: '⚙︎' },
  { code: 'en', label: 'English', region: 'United States', flag: 'US' },
  { code: 'es', label: 'Español', region: 'Estados Unidos', flag: 'MX' },
];

export default function AppSettingsScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  const { sp } = useDensityTokens();
  const styles = useMemo(() => makeStyles(palette, sp), [palette, sp]);

  const { currentLanguage, changeLanguage } = useLanguage();
  const {
    preference: theme,
    setPreference: setTheme,
    density,
    setDensity,
  } = useTheme();

  const [langOpen, setLangOpen] = useState(false);
  const [notifOn, setNotifOn] = useState(true);
  const [units, setUnits] = useState<UnitSystem>('imperial');
  const [timeFmt, setTimeFmt] = useState<TimeFormat>('12h');

  const activeLang =
    LANGUAGES.find((l) => l.code === currentLanguage) ?? LANGUAGES[0];

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={() => router.back()}
          accessibilityLabel="Back"
          style={({ pressed }) => [styles.topBarBtn, pressed && { opacity: 0.7 }]}
        >
          <Icon name="arrow-left" size={22} color={palette.textPrimary} />
        </Pressable>
        <Text style={styles.topBarTitle}>App settings</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Language */}
        <Group palette={palette} title="Language">
          <RowButton
            palette={palette}
            onPress={() => setLangOpen(true)}
            leading={<FlagTile palette={palette} label={activeLang.flag} />}
            title="App language"
            meta={`${activeLang.label} · ${activeLang.region}`}
          />
        </Group>

        {/* Notifications */}
        <Group palette={palette} title="Notifications">
          <ToggleRow
            palette={palette}
            icon="bell"
            title="Push notifications"
            sub="Loads, detours, messages, payroll"
            value={notifOn}
            onChange={setNotifOn}
          />
        </Group>

        {/* Region & units */}
        <Group palette={palette} title="Region & units">
          <SegRow
            palette={palette}
            icon="gauge"
            label="Units"
            value={units}
            options={[
              { v: 'imperial', l: 'Imperial' },
              { v: 'metric', l: 'Metric' },
            ]}
            onChange={(v) => setUnits(v as UnitSystem)}
          />
          <SegRow
            palette={palette}
            icon="clock"
            label="Time format"
            value={timeFmt}
            options={[
              { v: '12h', l: '12-hour' },
              { v: '24h', l: '24-hour' },
            ]}
            onChange={(v) => setTimeFmt(v as TimeFormat)}
          />
        </Group>

        {/* Appearance */}
        <Group palette={palette} title="Appearance">
          <SegRow
            palette={palette}
            icon="sun"
            label="Theme"
            value={theme}
            options={[
              { v: 'system', l: 'System' },
              { v: 'light', l: 'Light' },
              { v: 'dark', l: 'Dark' },
            ]}
            onChange={(v) => void setTheme(v as ThemePreference)}
          />
          <SegRow
            palette={palette}
            icon="menu"
            label="Density"
            value={density}
            options={[
              { v: 'comfortable', l: 'Comfortable' },
              { v: 'dense', l: 'Dense' },
            ]}
            onChange={(v) => void setDensity(v as Density)}
          />
        </Group>

        {/* Privacy */}
        <Group palette={palette} title="Privacy">
          <RowButton
            palette={palette}
            onPress={() => router.push('/permissions')}
            leading={
              <View style={styles.leadingIcon}>
                <Icon name="check-circle" size={16} color={palette.textSecondary} />
              </View>
            }
            title="Permissions"
            meta="Location, camera, notifications"
          />
          <RowButton
            palette={palette}
            onPress={() =>
              Alert.alert('Download my data', 'Data export is coming soon.')
            }
            leading={
              <View style={styles.leadingIcon}>
                <Icon name="download" size={16} color={palette.textSecondary} />
              </View>
            }
            title="Download my data"
            meta="Trips, hours, and documents · ZIP"
          />
        </Group>

        <Text style={styles.footer}>Changes sync automatically</Text>
      </ScrollView>

      <LanguageSheet
        palette={palette}
        visible={langOpen}
        active={currentLanguage}
        onClose={() => setLangOpen(false)}
        onPick={(code) => {
          void changeLanguage(code);
          setLangOpen(false);
        }}
      />
    </SafeAreaView>
  );
}

// ============================================================================
// ROW PRIMITIVES
// ============================================================================

const Group: React.FC<{
  palette: Palette;
  title: string;
  children: React.ReactNode;
}> = ({ palette, title, children }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <View style={styles.groupWrap}>
      <Text style={styles.groupLabel}>{title.toUpperCase()}</Text>
      <View style={styles.groupCard}>{children}</View>
    </View>
  );
};

const FlagTile: React.FC<{ palette: Palette; label: string }> = ({ palette, label }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <View style={styles.flagTile}>
      <Text style={styles.flagText}>{label}</Text>
    </View>
  );
};

const RowButton: React.FC<{
  palette: Palette;
  onPress: () => void;
  leading: React.ReactNode;
  title: string;
  meta?: string;
}> = ({ palette, onPress, leading, title, meta }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}
    >
      {leading}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        {meta ? (
          <Text style={styles.rowMeta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron-right" size={14} color={palette.textTertiary} />
    </Pressable>
  );
};

const ToggleRow: React.FC<{
  palette: Palette;
  icon: IconName;
  title: string;
  sub?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}> = ({ palette, icon, title, sub, value, onChange }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <View style={styles.row}>
      <View style={styles.leadingIcon}>
        <Icon name={icon} size={16} color={palette.textSecondary} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        {sub ? (
          <Text style={styles.rowMeta} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: palette.accent, false: palette.bgMuted }}
        thumbColor="#fff"
      />
    </View>
  );
};

const SegRow: React.FC<{
  palette: Palette;
  icon: IconName;
  label: string;
  value: string;
  options: Array<{ v: string; l: string }>;
  onChange: (v: string) => void;
}> = ({ palette, icon, label, value, options, onChange }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <View style={styles.row}>
      <View style={styles.leadingIcon}>
        <Icon name={icon} size={16} color={palette.textSecondary} />
      </View>
      {/* flexShrink lets long labels ellipsize; the chip group keeps its
          natural width on the right so Imperial/Metric always fit on one
          line even for the "Distance & weight" row. */}
      <Text
        numberOfLines={1}
        style={[styles.rowTitle, { flexShrink: 1, marginRight: 8 }]}
      >
        {label}
      </Text>
      <View style={[styles.segRow, { marginLeft: 'auto' }]}>
        {options.map((o) => {
          const active = o.v === value;
          return (
            <Pressable
              key={o.v}
              onPress={() => onChange(o.v)}
              style={({ pressed }) => [
                styles.seg,
                active && styles.segActive,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={[styles.segText, active && styles.segTextActive]}>
                {o.l}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};

// ============================================================================
// LANGUAGE SHEET
// ============================================================================

const LanguageSheet: React.FC<{
  palette: Palette;
  visible: boolean;
  active: string;
  onClose: () => void;
  onPick: (code: string) => void;
}> = ({ palette, visible, active, onClose, onPick }) => {
  const { sp } = useDensityTokens();
  const styles = makeStyles(palette, sp);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.sheetOverlay}>
          <TouchableWithoutFeedback>
            <View style={styles.sheetBody}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>App language</Text>
              <Text style={styles.sheetSubtitle}>
                Applies to every screen. Changes take effect immediately.
              </Text>
              <View style={{ marginTop: 6 }}>
                {LANGUAGES.map((l) => {
                  const picked = l.code === active;
                  return (
                    <Pressable
                      key={l.code}
                      onPress={() => onPick(l.code)}
                      style={({ pressed }) => [
                        styles.langRow,
                        pressed && { opacity: 0.85 },
                      ]}
                    >
                      <FlagTile palette={palette} label={l.flag} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.rowTitle}>{l.label}</Text>
                        <Text style={styles.rowMeta}>{l.region}</Text>
                      </View>
                      {picked && (
                        <Icon name="check" size={16} color={palette.accent} strokeWidth={2.5} />
                      )}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

// ============================================================================
// STYLES
// ============================================================================

const makeStyles = (palette: Palette, sp: Sp) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: palette.bgCanvas,
    },
    topBar: {
      height: 52,
      paddingHorizontal: 4,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    topBarBtn: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radii.full,
    },
    topBarTitle: {
      fontSize: 15,
      fontWeight: '600',
      letterSpacing: -0.15,
      color: palette.textPrimary,
    },

    groupWrap: {
      paddingHorizontal: sp.screenPx,
      paddingTop: sp.sectionGap,
    },
    groupLabel: {
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.8,
      color: palette.textTertiary,
      paddingHorizontal: 4,
      paddingBottom: 8,
    },
    groupCard: {
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      borderRadius: radii.lg,
      overflow: 'hidden',
    },

    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: sp.listPx,
      paddingVertical: sp.listPy,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.borderSubtle,
    },
    leadingIcon: {
      width: 28,
      height: 28,
      borderRadius: radii.md,
      backgroundColor: palette.bgMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    flagTile: {
      width: 28,
      height: 28,
      borderRadius: radii.md,
      backgroundColor: palette.bgMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    flagText: {
      fontSize: 11,
      fontWeight: '700',
      color: palette.textSecondary,
    },
    rowTitle: {
      fontSize: 14,
      fontWeight: '500',
      color: palette.textPrimary,
    },
    rowMeta: {
      fontSize: 12,
      color: palette.textTertiary,
      marginTop: 2,
    },

    segRow: {
      flexDirection: 'row',
      gap: 4,
      flexWrap: 'nowrap',
    },
    seg: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: radii.full,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      backgroundColor: palette.bgMuted,
    },
    segActive: {
      borderColor: palette.accent,
      backgroundColor: palette.accentTint,
    },
    segText: {
      fontSize: 12,
      fontWeight: '600',
      color: palette.textSecondary,
    },
    segTextActive: {
      color: palette.accent,
    },

    footer: {
      paddingHorizontal: 16,
      paddingTop: 24,
      textAlign: 'center',
      fontSize: 11,
      color: palette.textTertiary,
    },

    // Sheet
    sheetOverlay: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    sheetBody: {
      backgroundColor: palette.bgSurface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      padding: 20,
      paddingBottom: 32,
      gap: 12,
    },
    sheetHandle: {
      alignSelf: 'center',
      width: 38,
      height: 4,
      borderRadius: 2,
      backgroundColor: palette.borderDefault,
      marginBottom: 6,
    },
    sheetTitle: {
      ...typeScale.headingMd,
      color: palette.textPrimary,
    },
    sheetSubtitle: {
      fontSize: 13,
      lineHeight: 18,
      color: palette.textSecondary,
    },
    langRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
    },
  });
