/**
 * Column-visibility model for the loads table.
 *
 * Lives in its own module so the live `loads-table.tsx` can import the type
 * and default without pulling in a table component.
 */

export interface ColumnVisibility {
  orderNumber: boolean;
  customer: boolean;
  route: boolean;
  stops: boolean;
  status: boolean;
  tracking: boolean;
  hcr: boolean;
  tripNumber: boolean;
  loadDate: boolean;
}

export const DEFAULT_COLUMN_VISIBILITY: ColumnVisibility = {
  orderNumber: true,
  customer: true,
  route: true,
  stops: true,
  status: true,
  tracking: true,
  hcr: true,
  tripNumber: true,
  loadDate: true,
};
