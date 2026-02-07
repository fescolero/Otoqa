'use client';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Phone, Mail, Pencil, Eye, AlertTriangle, CheckCircle2, Clock, Building2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { formatPhoneNumber, getPhoneLink } from '@/lib/format-phone';

type Carrier = {
  _id: string;
  companyName: string;
  dba?: string;
  status: string;
  insuranceExpiration?: string;
  insuranceProvider?: string;
  mcNumber?: string;
  usdotNumber?: string;
  safetyRating?: string;
};

interface CarrierListItemProps {
  carrier: Carrier;
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

const getStatusColor = (status: string) => {
  switch (status) {
    case 'Active':
      return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
    case 'Inactive':
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
    case 'Vetting':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200';
    case 'Suspended':
      return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
  }
};

const getSafetyRatingColor = (rating?: string) => {
  switch (rating) {
    case 'Satisfactory':
      return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
    case 'Conditional':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200';
    case 'Unsatisfactory':
      return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
    case 'Not Rated':
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
  }
};

const getCompanyInitials = (companyName: string) => {
  const words = companyName.split(' ').filter(word => word.length > 0);
  if (words.length === 0) return 'C';
  if (words.length === 1) return words[0].substring(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
};

export function CarrierListItem({ carrier, isSelected, onSelectionChange }: CarrierListItemProps) {
  const router = useRouter();

  const initials = getCompanyInitials(carrier.companyName);
  const insuranceStatus = getDateStatus(carrier.insuranceExpiration);

  return (
    <div
      className={`group relative flex items-center gap-4 p-4 border rounded-lg hover:bg-accent/50 transition-colors cursor-pointer min-w-[800px] ${
        isSelected ? 'bg-blue-50 dark:bg-blue-950/20 border-blue-300 dark:border-blue-800' : ''
      }`}
      onClick={() => router.push(`/operations/carriers/${carrier._id}`)}
    >
      {/* Checkbox Column */}
      <div className="flex items-center w-10 flex-shrink-0">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => {
            e.stopPropagation();
            onSelectionChange(carrier._id, e.target.checked);
          }}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer hover:border-gray-400 transition-colors"
        />
      </div>

      {/* Column 1: Company Profile (Wide) */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Avatar className="h-12 w-12 text-base">
          <AvatarFallback className="bg-primary text-primary-foreground">
            <Building2 className="h-6 w-6" />
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-base truncate">
              {carrier.companyName}
            </h3>
            <Badge className={getStatusColor(carrier.status)}>
              {carrier.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground truncate">
            {carrier.dba ? `DBA: ${carrier.dba}` : 'No DBA'}
            {insuranceStatus && insuranceStatus.status !== 'valid' && (
              <span className="ml-2">
                • <span className={`font-medium ${insuranceStatus.status === 'expired' ? 'text-red-600' : insuranceStatus.status === 'expiring' ? 'text-orange-600' : 'text-yellow-600'}`}>{insuranceStatus.label}</span>
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Column 2: Authority (MC# / DOT#) */}
      <div className="hidden md:flex flex-col gap-1 w-[180px] flex-shrink-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">MC:</span>
          <span className="font-medium">{carrier.mcNumber || '—'}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">DOT:</span>
          <span className="font-medium">{carrier.usdotNumber || '—'}</span>
        </div>
      </div>

      {/* Column 3: Safety Rating */}
      <div className="hidden lg:flex flex-col gap-1 w-[150px] flex-shrink-0">
        {carrier.safetyRating ? (
          <Badge variant="outline" className={getSafetyRatingColor(carrier.safetyRating)}>
            {carrier.safetyRating}
          </Badge>
        ) : (
          <span className="text-sm text-muted-foreground">Not Rated</span>
        )}
      </div>

      {/* Column 4: Insurance */}
      <div className="hidden xl:flex flex-col gap-1 w-[180px] flex-shrink-0">
        {carrier.insuranceExpiration ? (
          <>
            <p className="text-xs text-muted-foreground">{carrier.insuranceProvider || 'Insurance'}</p>
            {insuranceStatus ? (
              <Badge variant="outline" className={`text-xs w-fit ${insuranceStatus.color}`}>
                <insuranceStatus.icon className="h-3 w-3 mr-1" />
                {formatDate(carrier.insuranceExpiration)}
              </Badge>
            ) : (
              <p className="text-sm">{formatDate(carrier.insuranceExpiration)}</p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">No insurance data</p>
        )}
      </div>

      {/* Column 5: Actions (Right Aligned) */}
      <div className="flex items-center gap-1 w-[180px] flex-shrink-0 justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            router.push(`/operations/carriers/${carrier._id}`);
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
            router.push(`/operations/carriers/${carrier._id}/edit`);
          }}
          className="h-8 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Pencil className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
