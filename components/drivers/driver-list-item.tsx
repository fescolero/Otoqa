'use client';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Doc } from '@/convex/_generated/dataModel';
import { Phone, Mail, Pencil, Eye, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { formatPhoneNumber, getPhoneLink } from '@/lib/format-phone';

type Driver = Doc<'drivers'>;

interface DriverListItemProps {
  driver: Driver;
  isSelected: boolean;
  onSelectionChange: (id: string, selected: boolean) => void;
}

const getDateStatus = (dateString?: string) => {
  if (!dateString) return null;

  const date = new Date(dateString);
  date.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffTime = date.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    const daysAgo = Math.abs(diffDays);
    return {
      status: 'expired',
      label: daysAgo === 1 ? 'Expired yesterday' : `Expired ${daysAgo} days ago`,
      color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
      icon: AlertTriangle,
    };
  } else if (diffDays === 0) {
    return {
      status: 'expiring',
      label: 'Expires today',
      color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
      icon: AlertTriangle,
    };
  } else if (diffDays <= 30) {
    return {
      status: 'expiring',
      label: `Expires in ${diffDays} day${diffDays === 1 ? '' : 's'}`,
      color: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
      icon: Clock,
    };
  } else if (diffDays <= 60) {
    return {
      status: 'warning',
      label: `Expires in ${diffDays} days`,
      color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
      icon: Clock,
    };
  }
  return {
    status: 'valid',
    label: `Expires in ${diffDays} days`,
    color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    icon: CheckCircle2,
  };
};

const formatDate = (dateString?: string) => {
  if (!dateString) return null;
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

export function DriverListItem({ driver, isSelected, onSelectionChange }: DriverListItemProps) {
  const router = useRouter();

  const getUserInitials = (firstName: string, lastName: string) => {
    return `${firstName[0]}${lastName[0]}`.toUpperCase();
  };

  const initials = getUserInitials(driver.firstName, driver.lastName);
  const licenseStatus = getDateStatus(driver.licenseExpiration);
  const medicalStatus = getDateStatus(driver.medicalExpiration);

  const statusColors = {
    'Active': 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    'Inactive': 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
    'On Leave': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  };

  // Determine the most critical status to show
  const criticalStatus = [licenseStatus, medicalStatus]
    .filter(Boolean)
    .sort((a, b) => {
      const priority = { expired: 0, expiring: 1, warning: 2, valid: 3 };
      return (priority[a!.status as keyof typeof priority] || 99) - (priority[b!.status as keyof typeof priority] || 99);
    })[0];

  return (
    <div
      className={`group relative flex items-center gap-4 p-4 border rounded-lg hover:bg-accent/50 transition-colors cursor-pointer min-w-[800px] ${
        isSelected ? 'bg-blue-50 dark:bg-blue-950/20 border-blue-300 dark:border-blue-800' : ''
      }`}
      onClick={() => router.push(`/fleet/drivers/${driver._id}`)}
    >
      {/* Checkbox Column - Always visible with ghost state */}
      <div className="flex items-center w-10 flex-shrink-0">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => {
            e.stopPropagation();
            onSelectionChange(driver._id, e.target.checked);
          }}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer hover:border-gray-400 transition-colors"
        />
      </div>
      {/* Column 1: Driver Profile (Wide) */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Avatar className="h-12 w-12 text-base">
          <AvatarFallback className="bg-primary text-primary-foreground">{initials}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-base truncate">
              {driver.firstName} {driver.middleName ? `${driver.middleName} ` : ''}
              {driver.lastName}
            </h3>
            <Badge
              className={`${statusColors[driver.employmentStatus as keyof typeof statusColors] || 'bg-gray-100 text-gray-800'}`}
            >
              {driver.employmentStatus}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground truncate">
            ID: {driver.licenseNumber}
            {criticalStatus && (
              <span className="ml-2">
                • <span className={`font-medium ${criticalStatus.status === 'expired' ? 'text-red-600' : criticalStatus.status === 'expiring' ? 'text-orange-600' : 'text-yellow-600'}`}>{criticalStatus.label}</span>
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Column 2: Contact (Medium) - Fixed Width */}
      <div className="hidden md:flex flex-col gap-1 w-[220px] flex-shrink-0">
        <a
          href={`tel:${getPhoneLink(driver.phone)}`}
          className="flex items-center gap-2 text-sm hover:text-primary transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          <Phone className="h-4 w-4 text-muted-foreground" />
          <span>{formatPhoneNumber(driver.phone)}</span>
        </a>
        <a
          href={`mailto:${driver.email}`}
          className="flex items-center gap-2 text-sm hover:text-primary transition-colors truncate"
          onClick={(e) => e.stopPropagation()}
        >
          <Mail className="h-4 w-4 text-muted-foreground" />
          <span className="truncate">{driver.email}</span>
        </a>
      </div>

      {/* Column 3: Compliance/License (Medium) - Fixed Width */}
      <div className="hidden lg:flex flex-col gap-1 w-[180px] flex-shrink-0">
        <p className="text-sm font-medium">
          {driver.licenseClass} ({driver.licenseState})
        </p>
        {licenseStatus ? (
          <div className="flex items-center gap-1">
            <Badge variant="outline" className={`text-xs ${licenseStatus.color}`}>
              <licenseStatus.icon className="h-3 w-3 mr-1" />
              {formatDate(driver.licenseExpiration)}
            </Badge>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{formatDate(driver.licenseExpiration)}</p>
        )}
      </div>

      {/* Column 4: Medical Card - Fixed Width (Always present, even if empty) */}
      <div className="hidden xl:flex flex-col gap-1 w-[150px] flex-shrink-0">
        {driver.medicalExpiration ? (
          <>
            <p className="text-xs text-muted-foreground">Medical Card</p>
            {medicalStatus ? (
              <Badge variant="outline" className={`text-xs w-fit ${medicalStatus.color}`}>
                <medicalStatus.icon className="h-3 w-3 mr-1" />
                {formatDate(driver.medicalExpiration)}
              </Badge>
            ) : (
              <p className="text-sm">{formatDate(driver.medicalExpiration)}</p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">—</p>
        )}
      </div>

      {/* Column 5: Actions (Right Aligned) - Fixed Width */}
      <div className="flex items-center gap-1 w-[180px] flex-shrink-0 justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            router.push(`/fleet/drivers/${driver._id}`);
          }}
          className="h-8 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Eye className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            router.push(`/fleet/drivers/${driver._id}/edit`);
          }}
          className="h-8 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Pencil className="h-4 w-4" />
        </Button>
      </div>

    </div>
  );
}
