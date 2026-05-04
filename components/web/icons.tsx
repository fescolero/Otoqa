/**
 * Shared icon set for the Otoqa Web design system.
 *
 * Re-exports a curated slice of lucide-react under stable names that match
 * the design source. Importers should pull from this module rather than
 * lucide-react directly so we have one place to swap icons later.
 *
 * Default props (size, strokeWidth) are applied at the consumer level via
 * the `WIcon` helper below.
 */

import * as React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Bell,
  Box,
  Briefcase,
  Building2,
  Calculator,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleHelp,
  Columns3,
  Compass,
  Download,
  Droplet,
  Edit2,
  Eye,
  EyeOff,
  Filter,
  FileText,
  FuelIcon,
  Gauge,
  Handshake,
  Home,
  IdCard,
  Inbox,
  ListTree,
  Menu,
  MoreHorizontal,
  Moon,
  Package,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Receipt,
  Route,
  Search,
  Shield,
  SortAsc,
  SortDesc,
  Sun,
  Truck,
  Upload,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';

const ICON_MAP = {
  'sidebar-left': PanelLeft,
  'sidebar-right': PanelRight,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  pin: Pin,
  'pin-off': PinOff,
  plus: Plus,
  filter: Filter,
  'sort-asc': SortAsc,
  'sort-desc': SortDesc,
  columns: Columns3,
  eye: Eye,
  'eye-off': EyeOff,
  export: Upload,
  import: Download,
  menu: Menu,
  search: Search,
  'kebab-h': MoreHorizontal,
  check: Check,
  'check-circle': CheckCircle2,
  'arrow-right': ArrowRight,
  'arrow-up-right': ArrowUpRight,
  'breadcrumb-sep': ChevronRight,
  home: Home,
  truck: Truck,
  users: Users,
  package: Package,
  route: Route,
  building: Building2,
  gauge: Gauge,
  fuel: FuelIcon,
  'doc-dollar': FileText,
  'file-text': FileText,
  compass: Compass,
  shield: Shield,
  calculator: Calculator,
  bell: Bell,
  help: CircleHelp,
  alert: AlertTriangle,
  inbox: Inbox,
  'circle-dot': Circle,
  'circle-alert': CircleAlert,
  pulse: Gauge,
  calendar: Calendar,
  'warn-tri': AlertTriangle,
  sun: Sun,
  moon: Moon,
  'id-card': IdCard,
  'box-trailer': Box,
  receipt: Receipt,
  briefcase: Briefcase,
  handshake: Handshake,
  'badge-check': BadgeCheck,
  droplet: Droplet,
  'list-tree': ListTree,
  edit: Pencil,
  'edit-pen': Edit2,
  close: X,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICON_MAP;

interface WIconProps extends Omit<React.SVGAttributes<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}

export function WIcon({ name, size = 16, strokeWidth = 1.6, ...rest }: WIconProps) {
  const Cmp = ICON_MAP[name];
  if (!Cmp) return null;
  return <Cmp size={size} strokeWidth={strokeWidth} {...rest} />;
}
