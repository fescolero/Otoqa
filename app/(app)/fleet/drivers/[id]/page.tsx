'use client';

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
import { Tabs, TabsContent, TabsListLine, TabsTriggerLine } from '@/components/ui/tabs';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter, useParams } from 'next/navigation';
import { Id } from '@/convex/_generated/dataModel';
import {
  Pencil,
  Trash2,
  Mail,
  Phone,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  RotateCcw,
  DollarSign,
  Shield,
  CreditCard,
  IdCard,
  Briefcase,
  User,
  UserCheck,
  MapPin,
  ArrowLeft,
} from 'lucide-react';
import { formatPhoneNumber, getPhoneLink } from '@/lib/format-phone';
import { DeleteConfirmationDialog } from '@/components/drivers/delete-confirmation-dialog';
import { DriverPaySettingsSection } from '@/components/driver-pay';
import { useOrganizationId } from '@/contexts/organization-context';
import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Calendar, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

const formatDate = (dateString?: string) => {
  if (!dateString) return null;
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const getDateStatus = (dateString?: string) => {
  if (!dateString) return { status: 'none', label: '', color: '' };

  const date = new Date(dateString);
  date.setHours(0, 0, 0, 0); // Normalize to start of day

  const today = new Date();
  today.setHours(0, 0, 0, 0); // Normalize to start of day

  const diffTime = date.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    const daysAgo = Math.abs(diffDays);
    return {
      status: 'expired',
      label: daysAgo === 1 ? 'Expired yesterday' : `Expired ${daysAgo} days ago`,
      color: 'text-red-600',
    };
  } else if (diffDays === 0) {
    return { status: 'expiring', label: 'Expires today', color: 'text-red-600' };
  } else if (diffDays === 1) {
    return { status: 'expiring', label: 'Expires tomorrow', color: 'text-orange-600' };
  } else if (diffDays <= 30) {
    return { status: 'expiring', label: `Expires in ${diffDays} days`, color: 'text-orange-600' };
  } else if (diffDays <= 60) {
    return { status: 'warning', label: `Expires in ${diffDays} days`, color: 'text-yellow-600' };
  }
  return { status: 'valid', label: `Expires in ${diffDays} days`, color: 'text-green-600' };
};

export default function DriverViewPage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const organizationId = useOrganizationId();
  const driverId = params.id as Id<'drivers'>;

  const driver = useQuery(api.drivers.get, { id: driverId, includeSensitive: true });
  const deactivateDriver = useMutation(api.drivers.deactivate);
  const restoreDriver = useMutation(api.drivers.restore);
  const permanentDeleteDriver = useMutation(api.drivers.permanentDelete);

  // Pay Plans
  const payPlans = useQuery(
    api.payPlans.list,
    organizationId ? { workosOrgId: organizationId } : 'skip'
  );
  const assignPayPlan = useMutation(api.payPlans.assignToDriver);

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isAssigningPayPlan, setIsAssigningPayPlan] = useState(false);

  const getUserInitials = (name?: string, email?: string) => {
    if (name) {
      const names = name.split(' ');
      if (names.length >= 2) {
        return `${names[0][0]}${names[1][0]}`.toUpperCase();
      }
      return name.slice(0, 2).toUpperCase();
    }
    if (email) {
      return email.slice(0, 2).toUpperCase();
    }
    return 'U';
  };

  const statusColors = {
    'Active': 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    'Inactive': 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
    'On Leave': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  };

  if (driver === undefined) {
    return (
      <>
          <div className="flex items-center justify-center h-screen">
            <p className="text-muted-foreground">Loading driver information...</p>
          </div>
        </>
    );
  }

  if (driver === null) {
    return (
      <>
          <div className="flex items-center justify-center h-screen">
            <div className="text-center">
              <p className="text-muted-foreground mb-4">Driver not found</p>
              <Button onClick={() => router.push('/fleet/drivers')}>Back to Drivers</Button>
            </div>
          </div>
        </>
    );
  }

  const driverInitials = getUserInitials(`${driver.firstName} ${driver.lastName}`, driver.email);

  const licenseStatus = getDateStatus(driver.licenseExpiration);
  const medicalStatus = getDateStatus(driver.medicalExpiration);
  const badgeStatus = getDateStatus(driver.badgeExpiration);
  const twicStatus = getDateStatus(driver.twicExpiration);

  const handleDeactivate = async () => {
    if (!user) return;
    const userName = user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email;
    try {
      await deactivateDriver({ id: driverId, userId: user.id, userName });
      router.push('/fleet/drivers');
    } catch (error) {
      console.error('Failed to deactivate driver:', error);
      alert('Failed to deactivate driver. Please try again.');
    }
  };

  const handleRestore = async () => {
    if (!user) return;
    const userName = user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email;
    try {
      await restoreDriver({ id: driverId, userId: user.id, userName });
    } catch (error) {
      console.error('Failed to restore driver:', error);
      alert('Failed to restore driver. Please try again.');
    }
  };

  const handlePermanentDelete = async () => {
    if (!user) return;
    const userName = user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email;
    setIsDeleting(true);
    try {
      await permanentDeleteDriver({ id: driverId, userId: user.id, userName });
      router.push('/fleet/drivers');
    } catch (error) {
      console.error('Failed to delete driver:', error);
      alert('Failed to delete driver. Please try again.');
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  // Helper to get status icon and color for insight cards
  const getStatusBadge = (status: ReturnType<typeof getDateStatus>) => {
    if (status.status === 'expired') return { icon: AlertTriangle, color: 'text-red-600 bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800' };
    if (status.status === 'expiring') return { icon: AlertTriangle, color: 'text-orange-600 bg-orange-50 border-orange-200 dark:bg-orange-950 dark:border-orange-800' };
    if (status.status === 'warning') return { icon: Clock, color: 'text-yellow-600 bg-yellow-50 border-yellow-200 dark:bg-yellow-950 dark:border-yellow-800' };
    if (status.status === 'valid') return { icon: CheckCircle2, color: 'text-green-600 bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800' };
    return { icon: Clock, color: 'text-muted-foreground bg-muted border-border' };
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
                <BreadcrumbLink href="#">Fleet Management</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/fleet/drivers">Drivers</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>
                  {driver.firstName} {driver.lastName}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-6">
        {/* Header with metadata row */}
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-4">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={() => router.push('/fleet/drivers')}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">
                {driver.firstName} {driver.middleName ? `${driver.middleName} ` : ''}
                {driver.lastName}
              </h1>
              <Badge
                className={
                  statusColors[driver.employmentStatus as keyof typeof statusColors] || 'bg-gray-100 text-gray-800'
                }
              >
                {driver.employmentStatus}
              </Badge>
              {driver.terminationDate && new Date(driver.terminationDate) > new Date() && (
                <Badge variant="outline" className="border-orange-600 text-orange-600">
                  <Clock className="mr-1 h-3 w-3" />
                  Pending Termination
                </Badge>
              )}
            </div>
            {/* Muted metadata row */}
            <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
              <a
                href={`tel:${getPhoneLink(driver.phone)}`}
                className="flex items-center gap-1.5 hover:text-foreground transition-colors"
              >
                <Phone className="h-3.5 w-3.5" />
                {formatPhoneNumber(driver.phone)}
              </a>
              <span className="text-muted-foreground/50">•</span>
              <a
                href={`mailto:${driver.email}`}
                className="flex items-center gap-1.5 hover:text-foreground transition-colors"
              >
                <Mail className="h-3.5 w-3.5" />
                {driver.email}
              </a>
              <span className="text-muted-foreground/50">•</span>
              <span className="flex items-center gap-1.5">
                <Briefcase className="h-3.5 w-3.5" />
                {driver.employmentType}
              </span>
            </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => router.push(`/fleet/drivers/${driverId}/edit`)}>
              <Pencil className="mr-2 h-4 w-4" />
              Edit
            </Button>
            <Button variant="outline">
              <FileText className="mr-2 h-4 w-4" />
              Export
            </Button>
            {driver.isDeleted ? (
              <>
                <Button variant="outline" onClick={handleRestore}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Restore
                </Button>
                <Button variant="destructive" onClick={() => setShowDeleteDialog(true)}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </Button>
              </>
            ) : (
              <Button variant="destructive" onClick={handleDeactivate}>
                <Trash2 className="mr-2 h-4 w-4" />
                Deactivate
              </Button>
            )}
          </div>
        </div>

        {/* Tabs with full-width line */}
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsListLine className="w-full">
            <TabsTriggerLine value="overview">Overview</TabsTriggerLine>
            <TabsTriggerLine value="payroll">
              <DollarSign className="h-4 w-4 mr-1" />
              Payroll
            </TabsTriggerLine>
          </TabsListLine>

          {/* Master-Detail Layout: 70/30 split */}
          <div className="flex gap-6">
            {/* Main Content Area (70%) */}
            <div className="flex-1 min-w-0">
              {/* Overview Tab */}
              <TabsContent value="overview" className="space-y-4 mt-0">
                {/* Compliance Insight Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {/* License */}
                  <div className={`p-3 rounded-lg border ${getStatusBadge(licenseStatus).color}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <IdCard className="h-4 w-4" />
                      <span className="text-xs font-medium uppercase tracking-wide">CDL</span>
                    </div>
                    <p className="text-sm font-semibold">
                      {licenseStatus.status === 'none' ? 'Not Set' : licenseStatus.status === 'expired' ? 'Expired' : licenseStatus.status === 'expiring' ? 'Expiring Soon' : 'Valid'}
                    </p>
                    {licenseStatus.label && (
                      <p className="text-xs mt-0.5 opacity-80">{licenseStatus.label}</p>
                    )}
                  </div>

                  {/* Medical */}
                  <div className={`p-3 rounded-lg border ${getStatusBadge(medicalStatus).color}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <Shield className="h-4 w-4" />
                      <span className="text-xs font-medium uppercase tracking-wide">Medical</span>
                    </div>
                    <p className="text-sm font-semibold">
                      {medicalStatus.status === 'none' ? 'Not Set' : medicalStatus.status === 'expired' ? 'Expired' : medicalStatus.status === 'expiring' ? 'Expiring Soon' : 'Valid'}
                    </p>
                    {medicalStatus.label && (
                      <p className="text-xs mt-0.5 opacity-80">{medicalStatus.label}</p>
                    )}
                  </div>

                  {/* Badge */}
                  <div className={`p-3 rounded-lg border ${getStatusBadge(badgeStatus).color}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <CreditCard className="h-4 w-4" />
                      <span className="text-xs font-medium uppercase tracking-wide">Badge</span>
                    </div>
                    <p className="text-sm font-semibold">
                      {badgeStatus.status === 'none' ? 'Not Set' : badgeStatus.status === 'expired' ? 'Expired' : badgeStatus.status === 'expiring' ? 'Expiring Soon' : 'Valid'}
                    </p>
                    {badgeStatus.label && (
                      <p className="text-xs mt-0.5 opacity-80">{badgeStatus.label}</p>
                    )}
                  </div>

                  {/* TWIC */}
                  <div className={`p-3 rounded-lg border ${getStatusBadge(twicStatus).color}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <UserCheck className="h-4 w-4" />
                      <span className="text-xs font-medium uppercase tracking-wide">TWIC</span>
                    </div>
                    <p className="text-sm font-semibold">
                      {twicStatus.status === 'none' ? 'Not Set' : twicStatus.status === 'expired' ? 'Expired' : twicStatus.status === 'expiring' ? 'Expiring Soon' : 'Valid'}
                    </p>
                    {twicStatus.label && (
                      <p className="text-xs mt-0.5 opacity-80">{twicStatus.label}</p>
                    )}
                  </div>
                </div>

                {/* License Details Card */}
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold">License Details</h3>
                    <Button variant="ghost" size="sm">
                      <FileText className="mr-2 h-3.5 w-3.5" />
                      View Document
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Number</p>
                      <p className="font-medium">{driver.licenseNumber || '—'}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Class</p>
                      <p className="font-medium">{driver.licenseClass || '—'}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">State</p>
                      <p className="font-medium">{driver.licenseState || '—'}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Expiration</p>
                      <p className={`font-medium ${licenseStatus.color}`}>
                        {formatDate(driver.licenseExpiration) || '—'}
                      </p>
                    </div>
                  </div>
                </Card>
              </TabsContent>

              {/* Payroll Tab */}
              <TabsContent value="payroll" className="mt-0 space-y-4">
                {/* Payroll Insight Cards - matches Overview tab pattern */}
                {(() => {
                  const activePlan = driver?.payPlanId 
                    ? payPlans?.find(p => p._id === driver.payPlanId) 
                    : null;
                  
                  return (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {/* Frequency */}
                      <div className={`p-3 rounded-lg border ${activePlan 
                        ? 'text-indigo-600 bg-indigo-50 border-indigo-200 dark:bg-indigo-950 dark:border-indigo-800' 
                        : 'text-muted-foreground bg-muted border-border'}`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <Calendar className="h-4 w-4" />
                          <span className="text-xs font-medium uppercase tracking-wide">Frequency</span>
                        </div>
                        <p className="text-sm font-semibold">
                          {activePlan?.frequency || 'Not Set'}
                        </p>
                      </div>

                      {/* Start Day */}
                      <div className={`p-3 rounded-lg border ${activePlan 
                        ? 'text-indigo-600 bg-indigo-50 border-indigo-200 dark:bg-indigo-950 dark:border-indigo-800' 
                        : 'text-muted-foreground bg-muted border-border'}`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <Clock className="h-4 w-4" />
                          <span className="text-xs font-medium uppercase tracking-wide">Start Day</span>
                        </div>
                        <p className="text-sm font-semibold">
                          {activePlan?.periodStartDayOfWeek 
                            || (activePlan?.periodStartDayOfMonth ? `Day ${activePlan.periodStartDayOfMonth}` : 'Not Set')}
                        </p>
                      </div>

                      {/* Cutoff Time */}
                      <div className={`p-3 rounded-lg border ${activePlan 
                        ? 'text-indigo-600 bg-indigo-50 border-indigo-200 dark:bg-indigo-950 dark:border-indigo-800' 
                        : 'text-muted-foreground bg-muted border-border'}`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <AlertTriangle className="h-4 w-4" />
                          <span className="text-xs font-medium uppercase tracking-wide">Cutoff</span>
                        </div>
                        <p className="text-sm font-semibold">
                          {activePlan?.cutoffTime || 'Not Set'}
                        </p>
                      </div>

                      {/* Payment Lag */}
                      <div className={`p-3 rounded-lg border ${activePlan 
                        ? 'text-indigo-600 bg-indigo-50 border-indigo-200 dark:bg-indigo-950 dark:border-indigo-800' 
                        : 'text-muted-foreground bg-muted border-border'}`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <DollarSign className="h-4 w-4" />
                          <span className="text-xs font-medium uppercase tracking-wide">Pay Lag</span>
                        </div>
                        <p className="text-sm font-semibold">
                          {activePlan ? `${activePlan.paymentLagDays} days` : 'Not Set'}
                        </p>
                      </div>
                    </div>
                  );
                })()}

                {/* Pay Plan Configuration Bar - high-density style */}
                <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 dark:bg-slate-900 rounded-lg border">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-muted-foreground">Pay Plan</span>
                    <Select
                      value={driver?.payPlanId ?? 'none'}
                      onValueChange={async (value) => {
                        if (!user) return;
                        setIsAssigningPayPlan(true);
                        try {
                          await assignPayPlan({
                            driverId,
                            planId: value === 'none' ? undefined : value as Id<'payPlans'>,
                          });
                          toast.success(value === 'none' ? 'Pay plan removed' : 'Pay plan assigned');
                        } catch (error) {
                          console.error('Failed to assign pay plan:', error);
                          toast.error('Failed to update pay plan');
                        } finally {
                          setIsAssigningPayPlan(false);
                        }
                      }}
                      disabled={isAssigningPayPlan}
                    >
                      <SelectTrigger className="w-[200px] h-8 text-sm">
                        {isAssigningPayPlan ? (
                          <div className="flex items-center gap-2">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            <span>Updating...</span>
                          </div>
                        ) : (
                          <SelectValue placeholder="Select pay plan..." />
                        )}
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">
                          <span className="text-muted-foreground">No Pay Plan</span>
                        </SelectItem>
                        {payPlans?.filter(p => p.isActive).map((plan) => (
                          <SelectItem key={plan._id} value={plan._id}>
                            <span>{plan.name}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => router.push('/org-settings/pay-plans')}
                  >
                    Manage Plans
                  </Button>
                </div>

                {/* Pay Profiles Section */}
                {organizationId && user ? (
                  <DriverPaySettingsSection
                    driverId={driverId}
                    organizationId={organizationId}
                    userId={user.id}
                  />
                ) : (
                  <Card className="p-6">
                    <p className="text-muted-foreground">Loading payroll settings...</p>
                  </Card>
                )}
              </TabsContent>
            </div>

          {/* Sidebar (30%) - Sticky */}
          <div className="w-72 shrink-0 hidden lg:block">
            <div className="sticky top-6 space-y-4">
              {/* Employment Details */}
              <Card className="p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Briefcase className="h-4 w-4 text-muted-foreground" />
                  Employment
                </h3>
                <div className="space-y-2.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Type</span>
                    <span className="font-medium">{driver.employmentType}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Hire Date</span>
                    <span className="font-medium">{formatDate(driver.hireDate) || '—'}</span>
                  </div>
                  {driver.preEmploymentCheckDate && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Pre-Emp Check</span>
                      <span className="font-medium">{formatDate(driver.preEmploymentCheckDate)}</span>
                    </div>
                  )}
                  {driver.terminationDate && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Termination</span>
                      <span className="font-medium text-orange-600">{formatDate(driver.terminationDate)}</span>
                    </div>
                  )}
                </div>
              </Card>

              {/* Personal Details */}
              <Card className="p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <User className="h-4 w-4 text-muted-foreground" />
                  Personal
                </h3>
                <div className="space-y-2.5 text-sm">
                  {driver.dateOfBirth && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">DOB</span>
                      <span className="font-medium">{formatDate(driver.dateOfBirth)}</span>
                    </div>
                  )}
                  {driver.ssn && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">SSN</span>
                      <span className="font-medium">***-**-{driver.ssn.slice(-4)}</span>
                    </div>
                  )}
                  {(driver.city || driver.state) && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Address</span>
                      <div className="text-right font-medium">
                        {driver.address && <p>{driver.address}</p>}
                        {driver.address2 && <p>{driver.address2}</p>}
                        <p>
                          {driver.city && `${driver.city}, `}
                          {driver.state} {driver.zipCode}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </Card>

              {/* Emergency Contact */}
              {(driver.emergencyContactName || driver.emergencyContactPhone) && (
                <Card className="p-4">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    Emergency Contact
                  </h3>
                  <div className="space-y-1.5 text-sm">
                    {driver.emergencyContactName && (
                      <p className="font-medium">{driver.emergencyContactName}</p>
                    )}
                    {driver.emergencyContactPhone && (
                      <a
                        href={`tel:${getPhoneLink(driver.emergencyContactPhone)}`}
                        className="text-primary hover:underline flex items-center gap-1"
                      >
                        <Phone className="h-3 w-3" />
                        {formatPhoneNumber(driver.emergencyContactPhone)}
                      </a>
                    )}
                  </div>
                </Card>
              )}

              {/* Quick Actions */}
              <Card className="p-4">
                <h3 className="text-sm font-semibold mb-3">Quick Actions</h3>
                <div className="space-y-2">
                  <Button variant="outline" size="sm" className="w-full justify-start" onClick={() => router.push(`/fleet/drivers/${driverId}/edit`)}>
                    <Pencil className="mr-2 h-3.5 w-3.5" />
                    Edit Profile
                  </Button>
                  <Button variant="outline" size="sm" className="w-full justify-start">
                    <FileText className="mr-2 h-3.5 w-3.5" />
                    Download PDF
                  </Button>
                </div>
              </Card>
            </div>
          </div>
        </div>
        </Tabs>
      </div>

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        driverName={`${driver.firstName} ${driver.lastName}`}
        onConfirm={handlePermanentDelete}
        isDeleting={isDeleting}
      />
    </>
  );
}
