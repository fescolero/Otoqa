import { I18n } from 'i18n-js';
import * as Localization from 'expo-localization';
import AsyncStorage from '@react-native-async-storage/async-storage';

// English translations
const en = {
  // Common
  common: {
    loading: 'Loading...',
    error: 'Error',
    retry: 'Retry',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    edit: 'Edit',
    done: 'Done',
    back: 'Back',
    next: 'Next',
    confirm: 'Confirm',
    yes: 'Yes',
    no: 'No',
    ok: 'OK',
    search: 'Search',
    noResults: 'No results found',
    comingSoon: 'Coming Soon',
  },

  // Navigation
  nav: {
    home: 'Home',
    drivers: 'Drivers',
    profile: 'Profile',
    more: 'More',
    messages: 'Messages',
  },

  // Home Screen (Driver)
  driverHome: {
    greeting: 'Hello',
    myLoads: 'My Loads',
    viewAll: 'View All',
    noActiveLoads: 'No Active Loads',
    noActiveLoadsDesc: 'You have no loads assigned. Check back later for new assignments.',
    pickup: 'Pickup',
    delivery: 'Delivery',
    miles: 'Miles',
    weight: 'Weight',
    rate: 'Rate',
  },

  // Home Screen (Dispatcher)
  dispatcherHome: {
    carrierDashboard: 'Carrier Dashboard',
    today: 'Today',
    availableForAssignment: 'AVAILABLE FOR ASSIGNMENT',
    noActiveLoads: 'No Active Loads',
    noActiveLoadsDesc: 'All loads have been delivered. New assignments will appear here.',
    viewAll: 'View All',
  },

  // Loads
  loads: {
    manageLoads: 'Manage Loads',
    unassigned: 'Unassigned',
    assigned: 'Assigned',
    completed: 'Completed',
    canceled: 'Canceled',
    activeRecent: 'ACTIVE & RECENT',
    showingLoads: 'Showing {{count}} loads',
    noLoadsAvailable: 'No loads available',
    noLoadsDesc: 'We couldn\'t find any loads matching your current filters.',
    loadAlerts: 'Load Alerts',
    notifyNewLoads: 'Notify me when new loads are posted',
    enable: 'Enable',
    route: 'Route',
    details: 'Details',
  },

  // Assign Driver
  assignDriver: {
    title: 'Assign Driver',
    loadDetails: 'Load Details',
    estPayout: 'EST. PAYOUT',
    availableDrivers: 'Available Drivers',
    noDriversAvailable: 'No drivers available',
    assignToLoad: 'Assign to Load',
    truckId: 'Truck',
  },

  // Drivers
  drivers: {
    title: 'Drivers',
    activeLoad: 'Active Load',
    noActiveLoad: 'No active load',
    call: 'Call',
    text: 'Text',
    noDrivers: 'No Drivers',
    noDriversDesc: 'No drivers are currently available.',
  },

  // Profile
  profile: {
    title: 'Profile',
    role: 'Role',
    switchToDispatcher: 'Switch to Dispatcher',
    switchToDriver: 'Switch to Driver Mode',
    manageLoadsDriversFleet: 'Manage loads, drivers, and fleet',
    viewAsDriver: 'View as driver interface',
    settings: 'Settings',
    notifications: 'Notifications',
    language: 'Language',
    permissions: 'Permissions',
    appInfo: 'App Info',
    appVersion: 'App Version',
    currentVersion: 'Current version installed',
    backgroundSync: 'Background Sync',
    lastSynced: 'Last synced {{time}}',
    support: 'Support',
    helpCenter: 'Help Center',
    contactDispatch: 'Contact Dispatch',
    available: 'Available',
    signOut: 'Sign Out',
    signOutConfirm: 'Are you sure you want to sign out?',
  },

  // More
  more: {
    title: 'More',
    vehicleDetails: 'Vehicle Details',
    noTruckAssigned: 'No truck assigned',
    scanQrToAssign: 'Scan a QR code to assign a truck',
    switchTruck: 'Switch Truck',
    assignTruck: 'Assign Truck',
    active: 'ACTIVE',
    financialsHistory: 'Financials & History',
    currentPayroll: 'Current Payroll',
    pastPayroll: 'Past Payroll',
    loadHistory: 'Load History',
    complianceDocuments: 'Compliance & Documents',
    complianceStatus: 'Compliance Status',
    requiredCertifications: 'Required Certifications',
    inspectionReports: 'Inspection Reports',
    companyPolicies: 'Company Policies',
    safetySupport: 'Safety & Support',
    reportAccident: 'Report an Accident',
    dispatcherConsole: 'Dispatcher Console',
    manageDrivers: 'Manage Drivers',
    activeDrivers: '{{count}} Active Drivers',
    fleetOverview: 'Fleet Overview',
    realTimeTracking: 'Real-time fleet tracking',
    operationalSettings: 'Operational Settings',
    notificationPreferences: 'Notification Preferences',
    privacySecurity: 'Privacy & Security',
    aboutApp: 'About Dispatch Pro',
  },

  // Notifications
  notifications: {
    title: 'Notifications',
    pushNotifications: 'Push Notifications',
    permissionGranted: 'Permission Granted',
    permissionGrantedDesc: 'You will receive push notifications for important updates.',
    permissionDenied: 'Permission Denied',
    permissionDeniedDesc: 'Enable notifications in your device settings to receive updates.',
    permissionUndetermined: 'Permission Required',
    permissionUndeterminedDesc: 'Allow notifications to stay updated on load assignments and messages.',
    permissionUnavailable: 'Notifications Unavailable',
    permissionUnavailableDesc: 'Push notifications are not available in this environment.',
    enableNotifications: 'Enable Notifications',
    openSettings: 'Open Settings',
    notificationTypes: 'Notification Types',
    loadAssignments: 'Load Assignments',
    loadAssignmentsDesc: 'Get notified when new loads are assigned',
    tripUpdates: 'Trip Updates',
    tripUpdatesDesc: 'Status changes and delivery updates',
    dispatchMessages: 'Dispatch Messages',
    dispatchMessagesDesc: 'Messages from your dispatcher',
    systemAlerts: 'System Alerts',
    systemAlertsDesc: 'Important system notifications',
  },

  // Messages
  messages: {
    title: 'Messages',
    comingSoon: 'Coming Soon',
    comingSoonDesc: 'In-app messaging will be available in a future update.',
  },

  // Languages
  languages: {
    title: 'Language',
    selectLanguage: 'Select Language',
    english: 'English',
    spanish: 'Spanish',
    systemDefault: 'System Default',
  },

  // Weather
  weather: {
    clear: 'Clear',
    sunny: 'Sunny',
    partlyCloudy: 'Partly Cloudy',
    cloudy: 'Cloudy',
    overcast: 'Overcast',
    fog: 'Fog',
    drizzle: 'Drizzle',
    rain: 'Rain',
    heavyRain: 'Heavy Rain',
    snow: 'Snow',
    heavySnow: 'Heavy Snow',
    thunderstorm: 'Thunderstorm',
    unknown: 'Unknown',
  },
};

// Spanish translations
const es = {
  // Common
  common: {
    loading: 'Cargando...',
    error: 'Error',
    retry: 'Reintentar',
    cancel: 'Cancelar',
    save: 'Guardar',
    delete: 'Eliminar',
    edit: 'Editar',
    done: 'Listo',
    back: 'Atrás',
    next: 'Siguiente',
    confirm: 'Confirmar',
    yes: 'Sí',
    no: 'No',
    ok: 'OK',
    search: 'Buscar',
    noResults: 'No se encontraron resultados',
    comingSoon: 'Próximamente',
  },

  // Navigation
  nav: {
    home: 'Inicio',
    drivers: 'Conductores',
    profile: 'Perfil',
    more: 'Más',
    messages: 'Mensajes',
  },

  // Home Screen (Driver)
  driverHome: {
    greeting: 'Hola',
    myLoads: 'Mis Cargas',
    viewAll: 'Ver Todo',
    noActiveLoads: 'Sin Cargas Activas',
    noActiveLoadsDesc: 'No tienes cargas asignadas. Vuelve más tarde para nuevas asignaciones.',
    pickup: 'Recogida',
    delivery: 'Entrega',
    miles: 'Millas',
    weight: 'Peso',
    rate: 'Tarifa',
  },

  // Home Screen (Dispatcher)
  dispatcherHome: {
    carrierDashboard: 'Panel del Transportista',
    today: 'Hoy',
    availableForAssignment: 'DISPONIBLE PARA ASIGNAR',
    noActiveLoads: 'Sin Cargas Activas',
    noActiveLoadsDesc: 'Todas las cargas han sido entregadas. Las nuevas asignaciones aparecerán aquí.',
    viewAll: 'Ver Todo',
  },

  // Loads
  loads: {
    manageLoads: 'Gestionar Cargas',
    unassigned: 'Sin Asignar',
    assigned: 'Asignadas',
    completed: 'Completadas',
    canceled: 'Canceladas',
    activeRecent: 'ACTIVAS Y RECIENTES',
    showingLoads: 'Mostrando {{count}} cargas',
    noLoadsAvailable: 'No hay cargas disponibles',
    noLoadsDesc: 'No encontramos cargas que coincidan con tus filtros.',
    loadAlerts: 'Alertas de Cargas',
    notifyNewLoads: 'Notificarme cuando se publiquen nuevas cargas',
    enable: 'Activar',
    route: 'Ruta',
    details: 'Detalles',
  },

  // Assign Driver
  assignDriver: {
    title: 'Asignar Conductor',
    loadDetails: 'Detalles de la Carga',
    estPayout: 'PAGO EST.',
    availableDrivers: 'Conductores Disponibles',
    noDriversAvailable: 'No hay conductores disponibles',
    assignToLoad: 'Asignar a la Carga',
    truckId: 'Camión',
  },

  // Drivers
  drivers: {
    title: 'Conductores',
    activeLoad: 'Carga Activa',
    noActiveLoad: 'Sin carga activa',
    call: 'Llamar',
    text: 'Mensaje',
    noDrivers: 'Sin Conductores',
    noDriversDesc: 'No hay conductores disponibles actualmente.',
  },

  // Profile
  profile: {
    title: 'Perfil',
    role: 'Rol',
    switchToDispatcher: 'Cambiar a Despachador',
    switchToDriver: 'Cambiar a Modo Conductor',
    manageLoadsDriversFleet: 'Gestionar cargas, conductores y flota',
    viewAsDriver: 'Ver como interfaz de conductor',
    settings: 'Configuración',
    notifications: 'Notificaciones',
    language: 'Idioma',
    permissions: 'Permisos',
    appInfo: 'Info de la App',
    appVersion: 'Versión de la App',
    currentVersion: 'Versión actual instalada',
    backgroundSync: 'Sincronización en Segundo Plano',
    lastSynced: 'Última sincronización {{time}}',
    support: 'Soporte',
    helpCenter: 'Centro de Ayuda',
    contactDispatch: 'Contactar Despacho',
    available: 'Disponible',
    signOut: 'Cerrar Sesión',
    signOutConfirm: '¿Estás seguro de que quieres cerrar sesión?',
  },

  // More
  more: {
    title: 'Más',
    vehicleDetails: 'Detalles del Vehículo',
    noTruckAssigned: 'Sin camión asignado',
    scanQrToAssign: 'Escanea un código QR para asignar un camión',
    switchTruck: 'Cambiar Camión',
    assignTruck: 'Asignar Camión',
    active: 'ACTIVO',
    financialsHistory: 'Finanzas e Historial',
    currentPayroll: 'Nómina Actual',
    pastPayroll: 'Nóminas Anteriores',
    loadHistory: 'Historial de Cargas',
    complianceDocuments: 'Cumplimiento y Documentos',
    complianceStatus: 'Estado de Cumplimiento',
    requiredCertifications: 'Certificaciones Requeridas',
    inspectionReports: 'Reportes de Inspección',
    companyPolicies: 'Políticas de la Empresa',
    safetySupport: 'Seguridad y Soporte',
    reportAccident: 'Reportar un Accidente',
    dispatcherConsole: 'Consola de Despachador',
    manageDrivers: 'Gestionar Conductores',
    activeDrivers: '{{count}} Conductores Activos',
    fleetOverview: 'Vista General de la Flota',
    realTimeTracking: 'Seguimiento en tiempo real de la flota',
    operationalSettings: 'Configuración Operacional',
    notificationPreferences: 'Preferencias de Notificaciones',
    privacySecurity: 'Privacidad y Seguridad',
    aboutApp: 'Acerca de Dispatch Pro',
  },

  // Notifications
  notifications: {
    title: 'Notificaciones',
    pushNotifications: 'Notificaciones Push',
    permissionGranted: 'Permiso Concedido',
    permissionGrantedDesc: 'Recibirás notificaciones push para actualizaciones importantes.',
    permissionDenied: 'Permiso Denegado',
    permissionDeniedDesc: 'Habilita las notificaciones en la configuración de tu dispositivo para recibir actualizaciones.',
    permissionUndetermined: 'Permiso Requerido',
    permissionUndeterminedDesc: 'Permite las notificaciones para mantenerte actualizado sobre asignaciones de cargas y mensajes.',
    permissionUnavailable: 'Notificaciones No Disponibles',
    permissionUnavailableDesc: 'Las notificaciones push no están disponibles en este entorno.',
    enableNotifications: 'Habilitar Notificaciones',
    openSettings: 'Abrir Configuración',
    notificationTypes: 'Tipos de Notificaciones',
    loadAssignments: 'Asignaciones de Cargas',
    loadAssignmentsDesc: 'Recibe notificaciones cuando se asignen nuevas cargas',
    tripUpdates: 'Actualizaciones de Viajes',
    tripUpdatesDesc: 'Cambios de estado y actualizaciones de entrega',
    dispatchMessages: 'Mensajes de Despacho',
    dispatchMessagesDesc: 'Mensajes de tu despachador',
    systemAlerts: 'Alertas del Sistema',
    systemAlertsDesc: 'Notificaciones importantes del sistema',
  },

  // Messages
  messages: {
    title: 'Mensajes',
    comingSoon: 'Próximamente',
    comingSoonDesc: 'La mensajería en la app estará disponible en una futura actualización.',
  },

  // Languages
  languages: {
    title: 'Idioma',
    selectLanguage: 'Seleccionar Idioma',
    english: 'Inglés',
    spanish: 'Español',
    systemDefault: 'Predeterminado del Sistema',
  },

  // Weather
  weather: {
    clear: 'Despejado',
    sunny: 'Soleado',
    partlyCloudy: 'Parcialmente Nublado',
    cloudy: 'Nublado',
    overcast: 'Cubierto',
    fog: 'Niebla',
    drizzle: 'Llovizna',
    rain: 'Lluvia',
    heavyRain: 'Lluvia Fuerte',
    snow: 'Nieve',
    heavySnow: 'Nevada Fuerte',
    thunderstorm: 'Tormenta',
    unknown: 'Desconocido',
  },
};

// Create i18n instance
const i18n = new I18n({
  en,
  es,
});

// Set default locale from device
i18n.defaultLocale = 'en';
i18n.enableFallback = true;

// Storage key for language preference
const LANGUAGE_STORAGE_KEY = '@app_language';

// Available languages
export const AVAILABLE_LANGUAGES = [
  { code: 'system', label: 'languages.systemDefault' },
  { code: 'en', label: 'languages.english' },
  { code: 'es', label: 'languages.spanish' },
];

// Get system locale
export const getSystemLocale = (): string => {
  const locales = Localization.getLocales();
  if (locales && locales.length > 0) {
    const languageCode = locales[0].languageCode;
    // Return only if we support the language, otherwise default to 'en'
    return languageCode === 'es' ? 'es' : 'en';
  }
  return 'en';
};

// Initialize i18n with saved or system language
export const initializeI18n = async (): Promise<string> => {
  try {
    const savedLanguage = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (savedLanguage && savedLanguage !== 'system') {
      i18n.locale = savedLanguage;
      return savedLanguage;
    } else {
      const systemLocale = getSystemLocale();
      i18n.locale = systemLocale;
      return 'system';
    }
  } catch {
    const systemLocale = getSystemLocale();
    i18n.locale = systemLocale;
    return 'system';
  }
};

// Set language
export const setLanguage = async (languageCode: string): Promise<void> => {
  try {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, languageCode);
    if (languageCode === 'system') {
      i18n.locale = getSystemLocale();
    } else {
      i18n.locale = languageCode;
    }
  } catch (error) {
    console.error('Error saving language preference:', error);
  }
};

// Get current language code
export const getCurrentLanguage = (): string => {
  return i18n.locale;
};

// Translation function
export const t = (key: string, options?: Record<string, unknown>): string => {
  return i18n.t(key, options);
};

export default i18n;
