import type { Id } from '@/convex/_generated/dataModel';

/**
 * Shared row types for the route-assignments page, which lists two
 * different things side by side: auto-assignment rules that react to
 * imported loads ("external"), and recurring templates that generate loads
 * on a schedule ("internal").
 *
 * These lived in route-assignments-table.tsx until that component and the
 * two standalone create/edit modals were deleted as dead code — the page
 * renders AutoAssignModal for both create and edit, and only ever imported
 * the type from the table.
 */

/** An auto-assignment rule, as returned by `routeAssignments.list`. */
export interface RouteAssignment {
  _id: Id<'routeAssignments'>;
  _creationTime: number;
  workosOrgId: string;
  hcr: string;
  tripNumber?: string;
  driverId?: Id<'drivers'>;
  carrierPartnershipId?: Id<'carrierPartnerships'>;
  priority: number;
  isActive: boolean;
  // Service calendar. Absent activeDays means the rule runs every day.
  // Matched against the load's pickup date, not the clock — see
  // convex/lib/routeMatch.ts.
  activeDays?: number[];
  excludeFederalHolidays?: boolean;
  customExclusions?: string[];
  name?: string;
  notes?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  // Enriched by the query, not stored.
  driverName?: string;
  carrierName?: string;
}

/** A recurring load template, as returned by `recurringLoads.list`. */
export interface RecurringTemplate {
  _id: Id<'recurringLoadTemplates'>;
  _creationTime: number;
  workosOrgId: string;
  name: string;
  hcr?: string;
  tripNumber?: string;
  customerId: Id<'customers'>;
  customerName?: string;
  activeDays: number[];
  isActive: boolean;
  lastGeneratedAt?: number;
  endDate?: string;
  routeAssignmentId?: Id<'routeAssignments'>;
  driverName?: string;
  carrierName?: string;
}

/** One row of the unified list, from either source. */
export interface CombinedAssignment {
  id: Id<'routeAssignments'> | Id<'recurringLoadTemplates'>;
  type: 'external' | 'internal';
  name: string;
  hcr?: string;
  tripNumber?: string;
  driverName?: string;
  carrierName?: string;
  isActive: boolean;
  createdAt: number;
  // Type-specific data
  routeAssignmentData?: RouteAssignment;
  recurringTemplateData?: RecurringTemplate;
  /** Days the row runs: service days for a rule, generation days for a
   *  template. Absent on a rule means "any day". */
  schedule?: number[];
  lastGenerated?: number;
}
