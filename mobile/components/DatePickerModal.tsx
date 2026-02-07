import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { colors, typography, borderRadius, spacing, isIOS, blurIntensity } from '../lib/theme';

const ITEM_HEIGHT = 44;
const VISIBLE_ITEMS = 5;

interface DatePickerModalProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (date: Date) => void;
  value: Date | null;
  title?: string;
  minimumDate?: Date;
  maximumDate?: Date;
}

const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export default function DatePickerModal({
  visible,
  onClose,
  onSelect,
  value,
  title = 'Select Date',
  minimumDate = new Date(1920, 0, 1),
  maximumDate = new Date(),
}: DatePickerModalProps) {
  const currentDate = value || new Date(1990, 0, 1);
  
  const [selectedMonth, setSelectedMonth] = useState(currentDate.getMonth());
  const [selectedDay, setSelectedDay] = useState(currentDate.getDate());
  const [selectedYear, setSelectedYear] = useState(currentDate.getFullYear());

  const monthScrollRef = useRef<ScrollView | null>(null);
  const dayScrollRef = useRef<ScrollView | null>(null);
  const yearScrollRef = useRef<ScrollView | null>(null);

  // Generate years array
  const minYear = minimumDate.getFullYear();
  const maxYear = maximumDate.getFullYear();
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i);

  // Generate days array based on selected month and year
  const daysInMonth = new Date(selectedYear, selectedMonth + 1, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  // Reset when modal opens
  useEffect(() => {
    if (visible) {
      const date = value || new Date(1990, 0, 1);
      setSelectedMonth(date.getMonth());
      setSelectedDay(date.getDate());
      setSelectedYear(date.getFullYear());

      // Scroll to selected values
      setTimeout(() => {
        monthScrollRef.current?.scrollTo({ y: date.getMonth() * ITEM_HEIGHT, animated: false });
        dayScrollRef.current?.scrollTo({ y: (date.getDate() - 1) * ITEM_HEIGHT, animated: false });
        yearScrollRef.current?.scrollTo({ y: (date.getFullYear() - minYear) * ITEM_HEIGHT, animated: false });
      }, 100);
    }
  }, [visible, value]);

  // Adjust day if it exceeds days in month
  useEffect(() => {
    if (selectedDay > daysInMonth) {
      setSelectedDay(daysInMonth);
    }
  }, [selectedMonth, selectedYear, daysInMonth]);

  const handleDone = () => {
    const newDate = new Date(selectedYear, selectedMonth, selectedDay);
    onSelect(newDate);
    onClose();
  };

  const handleScroll = (
    event: any,
    items: number[],
    setter: (value: number) => void
  ) => {
    const y = event.nativeEvent.contentOffset.y;
    const index = Math.round(y / ITEM_HEIGHT);
    if (index >= 0 && index < items.length) {
      setter(items[index]);
    }
  };

  const renderPicker = (
    items: (number | string)[],
    selectedValue: number | string,
    scrollRef: React.RefObject<ScrollView | null>,
    onScroll: (event: any) => void,
    formatItem?: (item: number | string) => string
  ) => (
    <View style={styles.pickerColumn}>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_HEIGHT}
        decelerationRate="fast"
        onMomentumScrollEnd={onScroll}
        contentContainerStyle={styles.pickerContent}
      >
        {/* Spacer for centering */}
        <View style={{ height: ITEM_HEIGHT * 2 }} />
        {items.map((item, index) => (
          <View key={index} style={styles.pickerItem}>
            <Text
              style={[
                styles.pickerItemText,
                item === selectedValue && styles.pickerItemTextSelected,
              ]}
            >
              {formatItem ? formatItem(item) : item}
            </Text>
          </View>
        ))}
        {/* Spacer for centering */}
        <View style={{ height: ITEM_HEIGHT * 2 }} />
      </ScrollView>
    </View>
  );

  const ModalContent = (
    <>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{title}</Text>
        <TouchableOpacity onPress={handleDone}>
          <Text style={styles.doneText}>Done</Text>
        </TouchableOpacity>
      </View>

      {/* Pickers */}
      <View style={styles.pickersContainer}>
        {/* Month Picker */}
        {renderPicker(
          months.map((_, i) => i),
          selectedMonth,
          monthScrollRef,
          (e) => handleScroll(e, months.map((_, i) => i), setSelectedMonth),
          (item) => months[item as number]
        )}

        {/* Day Picker */}
        {renderPicker(
          days,
          selectedDay,
          dayScrollRef,
          (e) => handleScroll(e, days, setSelectedDay)
        )}

        {/* Year Picker */}
        {renderPicker(
          years,
          selectedYear,
          yearScrollRef,
          (e) => handleScroll(e, years, setSelectedYear)
        )}

        {/* Selection Indicator */}
        <View style={styles.selectionIndicator} pointerEvents="none" />
      </View>

      {/* Preview */}
      <View style={styles.preview}>
        <Text style={styles.previewText}>
          {months[selectedMonth]} {selectedDay}, {selectedYear}
        </Text>
      </View>
    </>
  );

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={styles.overlay}>
        {isIOS ? (
          <BlurView
            intensity={blurIntensity.heavy}
            tint="dark"
            style={styles.container}
          >
            {ModalContent}
          </BlurView>
        ) : (
          <View style={styles.container}>
            {ModalContent}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: isIOS ? 'rgba(0, 0, 0, 0.3)' : 'rgba(0, 0, 0, 0.5)',
  },
  container: {
    backgroundColor: isIOS ? 'rgba(34, 38, 43, 0.85)' : colors.card,
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
    paddingBottom: spacing.xl,
    overflow: 'hidden',
    // iOS glass border
    ...(isIOS && {
      borderWidth: 1,
      borderBottomWidth: 0,
      borderColor: 'rgba(255, 255, 255, 0.1)',
    }),
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: isIOS ? 'rgba(255, 255, 255, 0.1)' : colors.border,
  },
  title: {
    fontSize: typography.md,
    fontWeight: '600',
    color: colors.foreground,
  },
  cancelText: {
    fontSize: typography.base,
    color: colors.foregroundMuted,
  },
  doneText: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.primary,
  },
  pickersContainer: {
    flexDirection: 'row',
    height: ITEM_HEIGHT * VISIBLE_ITEMS,
    paddingHorizontal: spacing.md,
  },
  pickerColumn: {
    flex: 1,
    overflow: 'hidden',
  },
  pickerContent: {
    alignItems: 'center',
  },
  pickerItem: {
    height: ITEM_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pickerItemText: {
    fontSize: typography.md,
    color: colors.foregroundMuted,
  },
  pickerItemTextSelected: {
    color: colors.foreground,
    fontWeight: '600',
    fontSize: typography.lg,
  },
  selectionIndicator: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    top: ITEM_HEIGHT * 2,
    height: ITEM_HEIGHT,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: isIOS ? 'rgba(255, 255, 255, 0.15)' : colors.border,
    backgroundColor: isIOS ? 'rgba(255, 255, 255, 0.05)' : colors.muted + '30',
    borderRadius: borderRadius.md,
  },
  preview: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: isIOS ? 'rgba(255, 255, 255, 0.1)' : colors.border,
    marginTop: spacing.sm,
  },
  previewText: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.primary,
  },
});
