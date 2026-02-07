// ============================================
// POLYFILLS FOR REACT NATIVE
// Required for Convex client which uses browser APIs
// ============================================

// Only polyfill if we're in React Native (no window object)
if (typeof window === 'undefined') {
  // Create a minimal window object
  (global as any).window = {
    // Network event listeners (Convex uses these)
    addEventListener: (event: string, callback: () => void) => {
      // No-op in React Native - we use NetInfo instead
      console.log(`[Polyfill] window.addEventListener('${event}') called - ignored`);
      void callback;
    },
    removeEventListener: (event: string, callback: () => void) => {
      // No-op
      void event;
      void callback;
    },
    // Navigator for online status
    navigator: {
      onLine: true,
    },
    // Location (may be needed by some libraries)
    location: {
      href: '',
      protocol: 'https:',
      host: '',
      hostname: '',
      port: '',
      pathname: '/',
      search: '',
      hash: '',
    },
  };
} else {
  // Window exists but might be missing addEventListener
  if (typeof (window as any).addEventListener !== 'function') {
    (window as any).addEventListener = (event: string, callback: () => void) => {
      console.log(`[Polyfill] window.addEventListener('${event}') called - ignored`);
      void callback;
    };
  }
  if (typeof (window as any).removeEventListener !== 'function') {
    (window as any).removeEventListener = (event: string, callback: () => void) => {
      // No-op
      void event;
      void callback;
    };
  }
}

export {};
