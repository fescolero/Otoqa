'use client';

import * as React from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { MoreHorizontal, Pencil, Trash2, Power, User, Building2, RefreshCw, ExternalLink } from 'lucide-react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { EditRouteAssignmentModal } from './edit-route-assignment-modal';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// Original route assignment interface
interface RouteAssignment {
  _id: Id<'routeAssignments'>;
  _creationTime: number;
  workosOrgId: string;
  hcr: string;
  tripNumber?: string;
  driverId?: Id<'drivers'>;
  carrierPartnershipId?: Id<'carrierPartnerships'>;
  isActive: boolean;
  name?: string;
  notes?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  driverName?: string;
  carrierName?: string;
}

// Recurring template interface
interface RecurringTemplate {
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

// Combined assignment type for unified display
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
  schedule?: number[];
  lastGenerated?: number;
}

interface RouteAssignmentsTableProps {
  data: CombinedAssignment[];
  organizationId: string;
}

const DAYS_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function formatSchedule(days: number[]): string {
  if (!days || days.length === 0) return '-';
  return days.sort().map((d) => DAYS_SHORT[d]).join(', ');
}

function formatLastGenerated(timestamp?: number): string {
  if (!timestamp) return 'Never';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString();
}

export function RouteAssignmentsTable({ data, organizationId }: RouteAssignmentsTableProps) {
  const { user } = useAuth();
  const [editingAssignment, setEditingAssignment] = React.useState<RouteAssignment | null>(null);
  const [deletingItem, setDeletingItem] = React.useState<CombinedAssignment | null>(null);

  // Mutations for route assignments
  const toggleRouteActive = useMutation(api.routeAssignments.toggleActive);
  const deleteRouteAssignment = useMutation(api.routeAssignments.remove);

  // Mutations for recurring templates
  const toggleTemplateActive = useMutation(api.recurringLoads.toggleActive);
  const deleteTemplate = useMutation(api.recurringLoads.remove);

  const handleToggleActive = async (item: CombinedAssignment) => {
    try {
      if (item.type === 'external') {
        await toggleRouteActive({ id: item.id as Id<'routeAssignments'> });
      } else {
        await toggleTemplateActive({ id: item.id as Id<'recurringLoadTemplates'> });
      }
    } catch (error) {
      console.error('Failed to toggle active status:', error);
    }
  };

  const handleDelete = async () => {
    if (!deletingItem) return;
    try {
      if (deletingItem.type === 'external') {
        await deleteRouteAssignment({ id: deletingItem.id as Id<'routeAssignments'> });
      } else {
        await deleteTemplate({ id: deletingItem.id as Id<'recurringLoadTemplates'> });
      }
      setDeletingItem(null);
    } catch (error) {
      console.error('Failed to delete:', error);
    }
  };

  const handleEdit = (item: CombinedAssignment) => {
    if (item.type === 'external' && item.routeAssignmentData) {
      setEditingAssignment(item.routeAssignmentData);
    }
    // TODO: Add edit modal for recurring templates
  };

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium">No Assignments Found</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Create route assignments for auto-assignment or recurring loads in the Load Creation form.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">Type</TableHead>
              <TableHead>Route / Name</TableHead>
              <TableHead>Assigned To</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[70px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((item) => (
              <TableRow key={`${item.type}-${item.id}`}>
                <TableCell>
                  <Badge 
                    variant="outline" 
                    className={item.type === 'external' 
                      ? 'border-blue-500 text-blue-600 bg-blue-50' 
                      : 'border-purple-500 text-purple-600 bg-purple-50'
                    }
                  >
                    {item.type === 'external' ? (
                      <><ExternalLink className="mr-1 h-3 w-3" /> External</>
                    ) : (
                      <><RefreshCw className="mr-1 h-3 w-3" /> Internal</>
                    )}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{item.name}</div>
                  {(item.hcr || item.tripNumber) && (
                    <div className="text-sm text-muted-foreground">
                      {item.hcr && <span>HCR: {item.hcr}</span>}
                      {item.hcr && item.tripNumber && <span> • </span>}
                      {item.tripNumber && <span>Trip: {item.tripNumber}</span>}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {item.driverName ? (
                      <>
                        <User className="h-4 w-4 text-muted-foreground" />
                        <span>{item.driverName}</span>
                      </>
                    ) : item.carrierName ? (
                      <>
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span>{item.carrierName}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Unassigned</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  {item.type === 'internal' && item.schedule ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="text-sm">
                            <div>{formatSchedule(item.schedule)}</div>
                            <div className="text-xs text-muted-foreground">
                              Last: {formatLastGenerated(item.lastGenerated)}
                            </div>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Generates loads on: {formatSchedule(item.schedule)}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <span className="text-sm text-muted-foreground">On Import</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={item.isActive ? 'default' : 'secondary'}>
                    {item.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {item.type === 'external' && (
                        <DropdownMenuItem onClick={() => handleEdit(item)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => handleToggleActive(item)}>
                        <Power className="mr-2 h-4 w-4" />
                        {item.isActive ? 'Deactivate' : 'Activate'}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => setDeletingItem(item)}
                        className="text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Edit Modal (External only for now) */}
      {editingAssignment && user && (
        <EditRouteAssignmentModal
          open={!!editingAssignment}
          onOpenChange={(open) => !open && setEditingAssignment(null)}
          assignment={editingAssignment}
          organizationId={organizationId}
          userId={user.id}
        />
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingItem} onOpenChange={(open) => !open && setDeletingItem(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deletingItem?.type === 'external' ? 'Route Assignment' : 'Recurring Template'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deletingItem?.type === 'external' ? (
                <>
                  This will permanently delete this route assignment. Imported loads with this
                  HCR/Trip will no longer be auto-assigned. This action cannot be undone.
                </>
              ) : (
                <>
                  This will permanently delete this recurring template. No more loads will be
                  automatically generated from this schedule. This action cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
