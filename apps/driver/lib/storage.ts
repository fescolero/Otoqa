import AsyncStorage from '@react-native-async-storage/async-storage';

// ============================================
// ASYNC STORAGE WRAPPER
// ============================================
// Using AsyncStorage for Expo Go compatibility
// Can switch to MMKV for production builds

// Storage keys
const STORAGE_PREFIX = 'otoqa-driver:';
const QUEUE_PREFIX = 'otoqa-queue:';

// Main storage functions
export const storage = {
  set: async (key: string, value: string) => {
    await AsyncStorage.setItem(STORAGE_PREFIX + key, value);
  },
  getString: async (key: string): Promise<string | null> => {
    return await AsyncStorage.getItem(STORAGE_PREFIX + key);
  },
  delete: async (key: string) => {
    await AsyncStorage.removeItem(STORAGE_PREFIX + key);
  },
  getAllKeys: async (): Promise<string[]> => {
    const allKeys = await AsyncStorage.getAllKeys();
    return allKeys
      .filter(k => k.startsWith(STORAGE_PREFIX))
      .map(k => k.replace(STORAGE_PREFIX, ''));
  },
};

// Queue storage functions
export const queueStorage = {
  set: async (key: string, value: string) => {
    await AsyncStorage.setItem(QUEUE_PREFIX + key, value);
  },
  getString: async (key: string): Promise<string | null> => {
    return await AsyncStorage.getItem(QUEUE_PREFIX + key);
  },
  delete: async (key: string) => {
    await AsyncStorage.removeItem(QUEUE_PREFIX + key);
  },
  getAllKeys: async (): Promise<string[]> => {
    const allKeys = await AsyncStorage.getAllKeys();
    return allKeys
      .filter(k => k.startsWith(QUEUE_PREFIX))
      .map(k => k.replace(QUEUE_PREFIX, ''));
  },
};

// Storage adapter for TanStack Query persistence (async version)
export const asyncStorageAdapter = {
  setItem: async (key: string, value: string) => {
    await storage.set(key, value);
  },
  getItem: async (key: string): Promise<string | null> => {
    return await storage.getString(key);
  },
  removeItem: async (key: string) => {
    await storage.delete(key);
  },
};