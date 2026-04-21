/**
 * Icon wrapper — Otoqa Driver design system.
 *
 * Centralizes HugeIcons usage behind a string-name API so screens can write
 * `<Icon name="chevron-right" />` rather than importing individual icon
 * components. Matches the `<Icon>` component used in the HTML design files
 * (lib/shared.jsx) so design-to-code porting is 1:1.
 *
 * When you need a new icon in a screen: add an entry to ICON_MAP below,
 * naming it with the same string the design uses.
 */

import React from 'react';
import { HugeiconsIcon } from '@hugeicons/react-native';
import {
  Search01Icon,
  ArrowRight01Icon,
  ArrowLeft01Icon,
  ArrowDown01Icon,
  Tick01Icon,
  PackageIcon,
  Home01Icon,
  Message01Icon,
  UserIcon,
  MoreHorizontalIcon,
  TruckIcon,
  PlayIcon,
  ClipboardIcon,
  DashboardSpeed01Icon,
  SecurityLockIcon,
  Notification01Icon,
  Clock01Icon,
  Settings01Icon,
  Logout01Icon,
  Location01Icon,
  Calendar03Icon,
  CloudIcon,
  Sun01Icon,
  MoonIcon,
  MapPinIcon,
  StopCircleIcon,
  PlusSignIcon,
  Cancel01Icon,
  Alert01Icon,
  InformationCircleIcon,
  CheckmarkCircle01Icon,
  CallIcon,
  MenuIcon,
  WhatsappIcon,
  FileDownloadIcon,
  DollarSquareIcon,
  RefreshIcon,
  Camera01Icon,
  RunningShoesIcon,
} from '@hugeicons/core-free-icons';

// Design uses dashed kebab-case names; map to HugeIcons exports. The
// solid variants here point to filled equivalents where HugeIcons offers
// one; where it doesn't, we reuse the outlined icon with strokeWidth=0
// (HugeIcons supports both stroked and filled rendering depending on
// strokeWidth).
const ICON_MAP = {
  search: Search01Icon,
  'chevron-right': ArrowRight01Icon,
  'chevron-down': ArrowDown01Icon,
  'arrow-right': ArrowRight01Icon,
  'arrow-left': ArrowLeft01Icon,
  check: Tick01Icon,
  package: PackageIcon,
  home: Home01Icon,
  // Free HugeIcons has no filled home glyph (HomeSmileIcon is a novelty
  // face variant, not a filled home). Active nav state uses a tinted pill
  // + thicker stroke instead, so `-solid` aliases here just reuse the
  // outlined icon.
  'home-solid': Home01Icon,
  message: Message01Icon,
  'message-solid': Message01Icon,
  user: UserIcon,
  'user-solid': UserIcon,
  'more-h': MoreHorizontalIcon,
  'more-h-solid': MoreHorizontalIcon,
  truck: TruckIcon,
  play: PlayIcon,
  clipboard: ClipboardIcon,
  gauge: DashboardSpeed01Icon,
  // HugeIcons free set has no seat-belt glyph; using SecurityLockIcon as
  // the closest visual equivalent for the "buckle up / secure yourself"
  // row in the pre-trip checklist.
  'seat-belt': SecurityLockIcon,
  bell: Notification01Icon,
  clock: Clock01Icon,
  settings: Settings01Icon,
  logout: Logout01Icon,
  location: Location01Icon,
  calendar: Calendar03Icon,
  cloud: CloudIcon,
  sun: Sun01Icon,
  moon: MoonIcon,
  'map-pin': MapPinIcon,
  stop: StopCircleIcon,
  plus: PlusSignIcon,
  x: Cancel01Icon,
  warning: Alert01Icon,
  info: InformationCircleIcon,
  'check-circle': CheckmarkCircle01Icon,
  phone: CallIcon,
  menu: MenuIcon,
  whatsapp: WhatsappIcon,
  download: FileDownloadIcon,
  dollar: DollarSquareIcon,
  refresh: RefreshIcon,
  camera: Camera01Icon,
  motion: RunningShoesIcon,
} as const;

export type IconName = keyof typeof ICON_MAP;

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

/**
 * Render a design-system icon by name. Defaults mirror the HTML design's
 * `Icon` component: size 22, stroke 1.5.
 */
export function Icon({ name, size = 22, color, strokeWidth = 1.5 }: IconProps) {
  const Glyph = ICON_MAP[name];
  if (!Glyph) {
    if (__DEV__) {
      console.warn(`[design-icons] Unknown icon name: ${name}`);
    }
    return null;
  }
  return (
    <HugeiconsIcon
      icon={Glyph}
      size={size}
      color={color}
      strokeWidth={strokeWidth}
    />
  );
}
