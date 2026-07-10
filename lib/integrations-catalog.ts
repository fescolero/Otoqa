/**
 * Integrations marketplace catalog.
 *
 * Static typed metadata for partner integrations shown in
 * /settings/integrations. The catalog is intentionally a TypeScript constant
 * (not a Convex table) because:
 *
 *   - Partner metadata is app-level, not per-org. Each Otoqa tenant sees the
 *     same marketplace.
 *   - Adding/editing a partner is a code change, not a data migration —
 *     it goes through PR review like any other product surface.
 *   - This is the same pattern used by Stripe Apps, Vercel Marketplace,
 *     Linear Integrations, etc.
 *
 * Per-org connection state (who's actually connected, with what credentials,
 * sync settings) lives in the `orgIntegrations` Convex table. The page joins
 * these by `provider` to mark cards as Connected.
 */
import type { IconName } from '@/components/web';

// ─── Category taxonomy ──────────────────────────────────────────────────

export interface IntegrationCategory {
  id: string;
  label: string;
  icon: IconName;
  /** Total integrations in this category (catalog count, not connected). */
  n: number;
}

export const INTEGRATION_CATEGORIES: IntegrationCategory[] = [
  { id: 'all',         label: 'All integrations',    icon: 'columns',    n: 218 },
  { id: 'eld',         label: 'ELD & telematics',    icon: 'gauge',      n: 28 },
  { id: 'load-boards', label: 'Load boards',         icon: 'package',    n: 18 },
  { id: 'visibility',  label: 'Visibility & ETA',    icon: 'route',      n: 14 },
  { id: 'fuel',        label: 'Fuel cards',          icon: 'fuel',       n: 22 },
  { id: 'factoring',   label: 'Factoring & pay',     icon: 'doc-dollar', n: 19 },
  { id: 'accounting',  label: 'Accounting',          icon: 'calculator', n: 16 },
  { id: 'maps',        label: 'Maps & routing',      icon: 'compass',    n: 12 },
  { id: 'comms',       label: 'Comms & alerts',      icon: 'bell',       n: 25 },
  { id: 'compliance',  label: 'Compliance & safety', icon: 'shield',     n: 17 },
  { id: 'storage',     label: 'Document storage',    icon: 'building',   n: 11 },
  { id: 'edi',         label: 'EDI & brokers',       icon: 'handshake',  n: 36 },
];

// ─── Tint + tier palettes ───────────────────────────────────────────────

export type IntegrationTint = 'blue' | 'green' | 'amber' | 'orange' | 'red' | 'violet' | 'teal' | 'slate';

export const TINT_PALETTE: Record<IntegrationTint, { bg: string; fg: string }> = {
  blue:   { bg: 'rgba(46, 92, 255, 0.10)',  fg: '#1A47E6' },
  green:  { bg: 'rgba(16, 185, 129, 0.10)', fg: '#0F8C5F' },
  amber:  { bg: 'rgba(245, 158, 11, 0.12)', fg: '#A66800' },
  orange: { bg: 'rgba(244, 116, 41, 0.12)', fg: '#B45A14' },
  red:    { bg: 'rgba(220, 38, 38, 0.10)',  fg: '#B43030' },
  violet: { bg: 'rgba(124, 58, 237, 0.10)', fg: '#7C3AED' },
  teal:   { bg: 'rgba(13, 148, 136, 0.10)', fg: '#0F8C7A' },
  slate:  { bg: 'rgba(15, 22, 36, 0.06)',   fg: '#475063' },
};

export type IntegrationTier = 'Included' | 'Premium' | 'Free';

export const TIER_TONES: Record<IntegrationTier, { fg: string; bg: string }> = {
  Included: { fg: '#0F8C5F', bg: 'rgba(16,185,129,0.10)' },
  Premium:  { fg: '#7C3AED', bg: 'rgba(124,58,237,0.10)' },
  Free:     { fg: '#475063', bg: 'var(--bg-surface-2)' },
};

// ─── Catalog entries ────────────────────────────────────────────────────

export interface IntegrationCatalogEntry {
  /** Stable id used in URLs + as the Convex `provider` join key. */
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  description: string;
  tier: IntegrationTier;
  rating: number;
  /** Human-readable install count (e.g. "8.4k"). */
  installs: string;
  /** 2–3 char monogram for the tinted tile. */
  mono: string;
  tint: IntegrationTint;
  /** True if Otoqa built + maintains the integration directly. */
  official?: boolean;
  /** True for featured / "Recommended for fleets" cards. */
  popular?: boolean;
}

export const INTEGRATIONS_CATALOG: IntegrationCatalogEntry[] = [
  // ── ELD & telematics ───────────────────────────────────────────────
  { id: 'samsara',  name: 'Samsara',         category: 'eld',         categoryLabel: 'ELD & telematics',
    description: 'Live GPS, HOS, DVIRs, and safety events from your Samsara fleet. Push dispatch routes to the cab tablet.',
    tier: 'Included', rating: 4.8, installs: '8.4k', mono: 'SM', tint: 'blue',
    official: true, popular: true },
  { id: 'motive',   name: 'Motive',          category: 'eld',         categoryLabel: 'ELD & telematics',
    description: 'Pulls hours-of-service, vehicle diagnostics, and driver coaching events into driver records.',
    tier: 'Included', rating: 4.7, installs: '6.1k', mono: 'MV', tint: 'orange',
    official: true, popular: true },
  { id: 'geotab',   name: 'Geotab',          category: 'eld',         categoryLabel: 'ELD & telematics',
    description: 'Telematics, fault codes, and idling reports. MyGeotab API with OAuth.',
    tier: 'Included', rating: 4.6, installs: '3.9k', mono: 'GT', tint: 'green', official: true },
  { id: 'verizon-connect', name: 'Verizon Connect', category: 'eld', categoryLabel: 'ELD & telematics',
    description: 'Fleet tracking, driver behavior, and fuel reports streamed into Otoqa.',
    tier: 'Premium',  rating: 4.4, installs: '2.2k', mono: 'VC', tint: 'red' },

  // ── Load boards / Visibility ───────────────────────────────────────
  { id: 'dat',      name: 'DAT Load Board',  category: 'load-boards', categoryLabel: 'Load boards',
    description: 'Search and book DAT loads from inside Otoqa. Auto-import to the planner as Open trips.',
    tier: 'Premium',  rating: 4.7, installs: '5.7k', mono: 'DAT', tint: 'blue',
    official: true, popular: true },
  { id: 'truckstop', name: 'Truckstop',      category: 'load-boards', categoryLabel: 'Load boards',
    description: 'Bid and book from the Truckstop board. Rate Insights flow into your load record.',
    tier: 'Premium',  rating: 4.5, installs: '3.4k', mono: 'TS', tint: 'red', popular: true },
  { id: 'project44', name: 'Project44',      category: 'visibility',  categoryLabel: 'Visibility & ETA',
    description: 'Share live ETAs with brokers and shippers. Otoqa pushes tractor pings on a 5-minute cadence.',
    tier: 'Premium',  rating: 4.6, installs: '2.8k', mono: 'P44', tint: 'violet', official: true },
  { id: 'fourkites', name: 'FourKites',      category: 'visibility',  categoryLabel: 'Visibility & ETA',
    description: 'Push shipment status, stop arrivals, and predictive ETA to FourKites carrier network.',
    tier: 'Premium',  rating: 4.5, installs: '1.9k', mono: '4K', tint: 'teal' },

  // ── Fuel & cards ───────────────────────────────────────────────────
  { id: 'wex',      name: 'WEX Fleet',       category: 'fuel',        categoryLabel: 'Fuel cards',
    description: 'Auto-reconcile fuel card swipes against truck + driver. Flag out-of-route purchases.',
    tier: 'Included', rating: 4.6, installs: '4.2k', mono: 'WEX', tint: 'red',
    official: true, popular: true },
  { id: 'comdata',  name: 'Comdata',         category: 'fuel',        categoryLabel: 'Fuel cards',
    description: 'Settlement transfers and fuel card import. Issue Comchecks from a load record.',
    tier: 'Included', rating: 4.4, installs: '2.6k', mono: 'CD',  tint: 'amber', official: true },

  // ── Factoring & pay ────────────────────────────────────────────────
  { id: 'triumphpay', name: 'TriumphPay',    category: 'factoring',   categoryLabel: 'Factoring & pay',
    description: 'Submit invoices, track payment status, and reconcile factored loads automatically.',
    tier: 'Included', rating: 4.7, installs: '3.1k', mono: 'TP',  tint: 'green',
    official: true, popular: true },
  { id: 'rts-financial', name: 'RTS Financial', category: 'factoring', categoryLabel: 'Factoring & pay',
    description: 'Send invoices to RTS for same-day funding. Status syncs to the load and driver record.',
    tier: 'Included', rating: 4.5, installs: '1.8k', mono: 'RTS', tint: 'blue' },

  // ── Accounting ─────────────────────────────────────────────────────
  { id: 'quickbooks-online', name: 'QuickBooks Online', category: 'accounting', categoryLabel: 'Accounting',
    description: 'Push settlements, expenses, and AR invoices to QBO. Map customers + classes once, sync forever.',
    tier: 'Included', rating: 4.6, installs: '7.2k', mono: 'QB', tint: 'green',
    official: true, popular: true },
  { id: 'xero',     name: 'Xero',            category: 'accounting',  categoryLabel: 'Accounting',
    description: 'Two-way sync for bills, invoices, and chart of accounts. Multi-currency supported.',
    tier: 'Included', rating: 4.5, installs: '1.6k', mono: 'XO', tint: 'teal', official: true },

  // ── Maps & routing ─────────────────────────────────────────────────
  { id: 'pcmiler', name: 'PC*Miler',         category: 'maps',        categoryLabel: 'Maps & routing',
    description: 'Truck-legal routing, toll estimates, and accurate mileage on every load.',
    tier: 'Premium',  rating: 4.7, installs: '4.6k', mono: 'PCM', tint: 'blue', popular: true },
  { id: 'trimble-maps', name: 'Trimble Maps', category: 'maps',       categoryLabel: 'Maps & routing',
    description: 'Truck-attribute routing, hazmat overlays, and live traffic for dispatch planning.',
    tier: 'Premium',  rating: 4.6, installs: '2.0k', mono: 'TM', tint: 'violet' },
];

/** Lookup by provider id. */
export function getCatalogEntry(id: string): IntegrationCatalogEntry | undefined {
  return INTEGRATIONS_CATALOG.find((e) => e.id === id);
}
