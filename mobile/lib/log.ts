/**
 * Namespaced logger with level-based prod stripping.
 *
 * Design goals:
 *   • Zero runtime cost for debug/info logs in production builds.
 *     Metro's dead-code elimination reduces them to no-op arrow
 *     functions, which JITs inline away.
 *   • Warn and error pass through unconditionally in both dev and
 *     prod — Sentry / PostHog's error capture / native log pipes
 *     (Xcode, logcat) pick them up for crash reports. Silencing
 *     these in prod would be silencing the things you actually
 *     want to know about.
 *   • Namespace prefix on every line so log archaeology still works
 *     — `[LocationTracking] Syncing 50 points` beats bare
 *     `Syncing 50 points` when 12 subsystems log concurrently.
 *
 * Usage:
 *   import { log } from './log';
 *   const lg = log('LocationTracking');
 *   lg.debug('Syncing', count, 'points');   // stripped in prod
 *   lg.warn('Retry triggered');             // kept in prod
 *   lg.error('Fatal sync error', err);      // kept in prod
 *
 * When to use each level:
 *   • debug: happy-path chatter ("heartbeat", "starting sync",
 *     "N points synced"). Fires on every cycle. Useful in dev, noise
 *     in prod.
 *   • info:  rare informational events worth seeing but not
 *     actionable (e.g. "migrated schema v2 → v3"). Treated same as
 *     debug today — stripped in prod. Reserved as a separate level
 *     in case we want to route info differently in the future.
 *   • warn:  degraded behavior that the app is handling ("retrying
 *     after auth failure", "falling back to HTTP client"). Worth
 *     surfacing in prod telemetry.
 *   • error: something genuinely broke. Prod pipes to crash reports.
 *
 * Migration from console.log/warn/error:
 *   console.log(...)   → lg.debug(...)
 *   console.warn(...)  → lg.warn(...)        // keep
 *   console.error(...) → lg.error(...)       // keep
 *
 * Audit pass later: some existing console.warn calls are actually
 * debug-level (fire every cycle, not truly degraded paths). Those
 * should drop to lg.debug in a follow-up. Don't do that bulk
 * reclassification in the initial migration — it changes behavior,
 * not just wiring.
 */

// `__DEV__` is a Metro-injected global: `true` in dev builds,
// constant `false` in production. Metro's minifier removes any
// `if (false) { ... }` block and the same logic strips the body
// of `const foo = false ? (...) => {...} : () => {};`.
declare const __DEV__: boolean;
const DEV: boolean = typeof __DEV__ !== 'undefined' ? __DEV__ : false;

export type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const NOOP = () => {};

/**
 * Create a namespaced logger. The returned object is safe to hold at
 * module scope — the DEV flag is resolved at module load, so there's
 * no per-call branch cost.
 */
export function log(namespace: string): Logger {
  const prefix = `[${namespace}]`;
  return {
    debug: DEV
      ? (...args: unknown[]) => console.log(prefix, ...args)
      : NOOP,
    info: DEV ? (...args: unknown[]) => console.log(prefix, ...args) : NOOP,
    // Warn and error are unconditional — they're the signals, not the noise.
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}
