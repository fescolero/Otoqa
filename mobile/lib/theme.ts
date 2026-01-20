// ============================================
// DARK LOGISTICS THEME
// Premium dark mode design system
// ============================================

export const colors = {
  // Background Colors
  background: '#1A1D21',
  card: '#22262B',
  muted: '#2D323B',
  
  // Primary (Orange)
  primary: '#FF6B00',
  primaryLight: '#FF8533',
  primaryDark: '#CC5500',
  primaryForeground: '#1A1D21',
  
  // Secondary (Yellow/Gold)
  secondary: '#EAB308',
  secondaryLight: '#FACC15',
  secondaryDark: '#CA8A04',
  secondaryForeground: '#1A1D21',
  
  // Chart Colors
  chart1: '#FF6B00', // Orange
  chart2: '#EAB308', // Yellow
  chart3: '#3B82F6', // Blue
  chart4: '#10B981', // Green/Teal
  chart5: '#6B7280', // Gray
  
  // Text Colors
  foreground: '#F3F4F6',
  foregroundMuted: '#9CA3AF',
  foregroundSubtle: '#6B7280',
  
  // Status Colors
  success: '#10B981',
  successLight: '#34D399',
  warning: '#EAB308',
  error: '#EF4444',
  destructive: '#EF4444',
  
  // Borders
  border: '#3F4552',
  borderSubtle: '#2D323B',
  
  // Accent
  accent: '#2D323B',
  accentForeground: '#F3F4F6',
  
  // Ring/Focus
  ring: '#FF6B00',
};

export const typography = {
  // Font Families (system fonts, can be customized)
  fontSans: 'System',
  fontMono: 'Courier',
  
  // Font Sizes
  xs: 10,
  sm: 12,
  base: 14,
  md: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  
  // Font Weights
  normal: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
};

export const spacing = {
  xs: 4,
  sm: 8,
  base: 12,
  md: 16,
  lg: 20,
  xl: 24,
  '2xl': 32,
};

export const borderRadius = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 20,
  full: 9999,
};

export const layout = {
  screenPadding: 16,
  cardPadding: 12,
  navHeight: 70,
  navBottomOffset: 16,
};

export const shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 8,
  },
};
