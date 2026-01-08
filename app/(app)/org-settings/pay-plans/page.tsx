'use client';

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useOrganizationId } from '@/contexts/organization-context';
import {
  Plus,
  Calendar,
  Clock,
  MoreHorizontal,
  Pencil,
  Archive,
  RotateCcw,
  Users,
  CalendarDays,
  Timer,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PayPlanEditor } from '@/components/pay-plans/PayPlanEditor';

export default function PayPlansPage() {
  const { user } = useAuth();
  const organizationId = useOrganizationId();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<Id<'payPlans'> | undefined>(undefined);
  const [showInactive, setShowInactive] = useState(false);

  // Fetch pay plans
  const plans = useQuery(
    api.payPlans.list,
    organizationId ? { workosOrgId: organizationId, includeInactive: showInactive } : 'skip'
  );

  // Mutations
  const archivePlan = useMutation(api.payPlans.archive);
  const restorePlan = useMutation(api.payPlans.restore);

  const handleArchive = async (planId: Id<'payPlans'>) => {
    try {
      await archivePlan({ planId });
    } catch (error) {
      console.error('Failed to archive plan:', error);
    }
  };

  const handleRestore = async (planId: Id<'payPlans'>) => {
    try {
      await restorePlan({ planId });
    } catch (error) {
      console.error('Failed to restore plan:', error);
    }
  };

  const getFrequencyIcon = (frequency: string) => {
    switch (frequency) {
      case 'WEEKLY':
        return <Calendar className="h-4 w-4" />;
      case 'BIWEEKLY':
        return <CalendarDays className="h-4 w-4" />;
      case 'SEMIMONTHLY':
      case 'MONTHLY':
        return <Timer className="h-4 w-4" />;
      default:
        return <Calendar className="h-4 w-4" />;
    }
  };

  const getFrequencyLabel = (frequency: string) => {
    switch (frequency) {
      case 'WEEKLY':
        return 'Weekly';
      case 'BIWEEKLY':
        return 'Bi-Weekly';
      case 'SEMIMONTHLY':
        return 'Semi-Monthly';
      case 'MONTHLY':
        return 'Monthly';
      default:
        return frequency;
    }
  };

  const getTriggerLabel = (trigger: string) => {
    switch (trigger) {
      case 'DELIVERY_DATE':
        return 'Delivery Date';
      case 'COMPLETION_DATE':
        return 'Completion Date';
      case 'APPROVAL_DATE':
        return 'Approval Date';
      default:
        return trigger;
    }
  };

  const formatPeriodStart = (plan: NonNullable<typeof plans>[number]) => {
    if (plan.frequency === 'WEEKLY' || plan.frequency === 'BIWEEKLY') {
      if (plan.periodStartDayOfWeek) {
        return plan.periodStartDayOfWeek.charAt(0) + plan.periodStartDayOfWeek.slice(1).toLowerCase();
      }
    } else if (plan.frequency === 'SEMIMONTHLY') {
      return '1st & 16th';
    } else if (plan.frequency === 'MONTHLY') {
      return plan.periodStartDayOfMonth ? `Day ${plan.periodStartDayOfMonth}` : 'Day 1';
    }
    return '-';
  };

  return (
    <>
      <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 border-b">
        <div className="flex items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/org-settings">Organization Settings</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>Pay Plans</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-6">
        {/* Page Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Pay Plans</h1>
            <p className="text-muted-foreground">
              Configure payroll timing and schedules for driver settlements
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() => setShowInactive(!showInactive)}
            >
              {showInactive ? 'Hide Inactive' : 'Show Inactive'}
            </Button>
            <Button onClick={() => { setEditingPlanId(undefined); setEditorOpen(true); }}>
              <Plus className="h-4 w-4 mr-2" />
              New Plan
            </Button>
          </div>
        </div>

        {/* Plans Table */}
        {plans === undefined ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-muted-foreground">Loading pay plans...</p>
          </div>
        ) : plans.length === 0 ? (
          <Card className="p-12">
            <div className="text-center">
              <Calendar className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No pay plans yet</h3>
              <p className="text-muted-foreground mb-6">
                Create your first pay plan to define payroll timing and schedules for drivers.
              </p>
              <Button onClick={() => { setEditingPlanId(undefined); setEditorOpen(true); }}>
                <Plus className="h-4 w-4 mr-2" />
                Create Pay Plan
              </Button>
            </div>
          </Card>
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[280px]">Plan Name</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Period Start</TableHead>
                  <TableHead>Cutoff</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead className="text-center">Drivers</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plans.map((plan) => (
                  <TableRow
                    key={plan._id}
                    className={`cursor-pointer ${!plan.isActive ? 'opacity-60' : ''}`}
                    onClick={() => { setEditingPlanId(plan._id); setEditorOpen(true); }}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-primary/10 rounded-lg">
                          {getFrequencyIcon(plan.frequency)}
                        </div>
                        <div>
                          <div className="font-medium">{plan.name}</div>
                          {plan.description && (
                            <p className="text-sm text-muted-foreground line-clamp-1">
                              {plan.description}
                            </p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-normal">
                        {getFrequencyLabel(plan.frequency)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{formatPeriodStart(plan)}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-sm">
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                        {plan.cutoffTime}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {getTriggerLabel(plan.payableTrigger)}
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <Users className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium tabular-nums">{plan.driverCount}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={plan.isActive ? 'outline' : 'secondary'}>
                        {plan.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingPlanId(plan._id);
                              setEditorOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4 mr-2" />
                            Edit Plan
                          </DropdownMenuItem>
                          {plan.isActive ? (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleArchive(plan._id);
                              }}
                              className="text-orange-600"
                              disabled={plan.driverCount > 0}
                            >
                              <Archive className="h-4 w-4 mr-2" />
                              Archive
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRestore(plan._id);
                              }}
                              className="text-green-600"
                            >
                              <RotateCcw className="h-4 w-4 mr-2" />
                              Restore
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>

      {/* Pay Plan Editor (Slide-Over) */}
      {organizationId && user && (
        <PayPlanEditor
          open={editorOpen}
          onOpenChange={(open) => {
            setEditorOpen(open);
            if (!open) setEditingPlanId(undefined);
          }}
          planId={editingPlanId}
          organizationId={organizationId}
          userId={user.id}
        />
      )}
    </>
  );
}

