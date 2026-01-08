'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Doc } from '@/convex/_generated/dataModel';
import { MoreHorizontal, Copy, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

type Trailer = Doc<'trailers'>;

interface TrailerListItemProps {
  trailer: Trailer;
  isSelected: boolean;
  onSelectionChange: (id: string, selected: boolean) => void;
}

const getDateStatus = (dateString?: string, label?: string) => {
  if (!dateString) return null;

  const date = new Date(dateString);
  date.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffTime = date.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  // Format date for display (MMM DD, YYYY)
  const formattedDate = date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  if (diffDays < 0) return { status: 'expired', days: Math.abs(diffDays), icon: AlertTriangle, color: 'text-red-600', label, date: formattedDate };
  if (diffDays <= 30) return { status: 'expiring', days: diffDays, icon: AlertTriangle, color: 'text-orange-600', label, date: formattedDate };
  return { status: 'valid', days: diffDays, icon: CheckCircle2, color: 'text-green-600', label, date: formattedDate };
};

const statusColors = {
  Active: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  'Out of Service': 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  'In Repair': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  Maintenance: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  Sold: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  Lost: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
};

const formatGVWR = (gvwr?: number) => {
  if (!gvwr) return 'N/A';
  // Validate GVWR makes sense for a trailer (should be > 1000 lbs)
  if (gvwr < 1000) return `${gvwr.toLocaleString()} lbs`;
  return `${gvwr.toLocaleString()} lbs`;
};

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text);
};

export function TrailerListItem({ trailer, isSelected, onSelectionChange }: TrailerListItemProps) {
  const router = useRouter();

  // Collect all compliance issues
  const regStatus = getDateStatus(trailer.registrationExpiration, 'Registration');
  const insStatus = getDateStatus(trailer.insuranceExpiration, 'Insurance');

  // Get all statuses
  const allStatuses = [regStatus, insStatus].filter(Boolean);
  
  // Sort by priority: expired > expiring > valid
  const sortedStatuses = [...allStatuses].sort((a, b) => {
    const priority = { expired: 0, expiring: 1, valid: 2 };
    return (priority[a!.status as keyof typeof priority] || 99) - (priority[b!.status as keyof typeof priority] || 99);
  });

  // Check if all are valid (compliant)
  const allValid = sortedStatuses.every(s => s!.status === 'valid');
  
  // Get worst status for overall assessment
  const worstStatus = sortedStatuses[0]?.status || 'valid';

  // Build trailer description with size
  const trailerDescription = [
    trailer.year,
    trailer.make,
    trailer.model,
    trailer.size
  ].filter(Boolean).join(' ');

  return (
    <div
      className={`group relative flex items-center gap-1.5 sm:gap-2 md:gap-3 p-1.5 sm:p-2.5 border rounded-lg hover:bg-accent/50 transition-colors cursor-pointer ${
        isSelected ? 'bg-blue-50 dark:bg-blue-950/20 border-blue-300 dark:border-blue-800' : ''
      }`}
      onClick={() => router.push(`/fleet/trailers/${trailer._id}`)}
    >
      {/* Checkbox Column - Fixed */}
      <div className="flex items-center w-6 sm:w-8 flex-shrink-0">
        <Checkbox
          checked={isSelected}
          onCheckedChange={(checked) => {
            onSelectionChange(trailer._id, checked as boolean);
          }}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4"
        />
      </div>

      {/* Unit ID Column - Flexible */}
      <div className="w-14 sm:w-16 md:w-20 flex-shrink-0">
        <p className="font-semibold text-xs sm:text-sm truncate">{trailer.unitId}</p>
      </div>

      {/* Status Column - Flexible */}
      <div className="w-16 sm:w-20 md:w-24 flex-shrink-0">
        <Badge className={`text-[10px] sm:text-xs ${statusColors[trailer.status as keyof typeof statusColors] || 'bg-gray-100 text-gray-800'}`}>
          {trailer.status}
        </Badge>
      </div>

      {/* Vehicle Column - Flexible (grows to fill space) */}
      <div className="flex-1 min-w-0">
        <p className="font-medium text-xs sm:text-sm truncate">
          {trailerDescription}
        </p>
        {trailer.bodyType && <p className="text-[10px] sm:text-xs text-gray-600 dark:text-gray-400 truncate">{trailer.bodyType}</p>}
      </div>

      {/* Plate/VIN Column - Hidden on smaller screens */}
      <div className="hidden xl:flex w-32 2xl:w-36 flex-shrink-0 flex-col">
        {trailer.plate && <p className="font-medium text-sm truncate">{trailer.plate}</p>}
        <div className="flex items-center gap-1 group/vin">
          <p className="text-xs text-gray-600 dark:text-gray-400 truncate">{trailer.vin}</p>
          <button
            onClick={(e) => {
              e.stopPropagation();
              copyToClipboard(trailer.vin);
            }}
            className="opacity-0 group-hover/vin:opacity-100 transition-opacity flex-shrink-0"
            title="Copy VIN"
          >
            <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
          </button>
        </div>
      </div>

      {/* Compliance Column - Flexible */}
      <div className="w-20 sm:w-24 md:w-28 lg:w-32 flex-shrink-0">
        {sortedStatuses.length > 0 ? (
          <div className="flex flex-wrap gap-1 sm:gap-1.5">
            {allValid ? (
              // All compliant - show single green chip
              <span className="inline-flex items-center px-1.5 sm:px-2 py-0.5 text-[10px] sm:text-xs font-medium rounded bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                Compliant
              </span>
            ) : (
              // Show individual chips for each document status
              sortedStatuses.map((status, idx) => {
                if (!status) return null;
                
                // Determine chip styling based on status
                const chipStyles = {
                  expired: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
                  expiring: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
                  valid: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
                };

                // Skip valid statuses when showing issues
                if (status.status === 'valid') return null;

                // Shorten label on small screens
                const shortLabel = status.label === 'Registration' ? 'Reg' : 'Ins';

                return (
                  <TooltipProvider key={idx}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className={`inline-flex items-center px-1.5 sm:px-2 py-0.5 text-[10px] sm:text-xs font-medium rounded cursor-help ${chipStyles[status.status]}`}>
                          <span className="hidden sm:inline">
                            {status.status === 'expired'
                              ? `${status.label}: Expired`
                              : `${status.label}: ${status.days}d`}
                          </span>
                          <span className="sm:hidden">
                            {status.status === 'expired'
                              ? `${shortLabel}: Exp`
                              : `${shortLabel}: ${status.days}d`}
                          </span>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <div>
                          {status.status === 'expired'
                            ? status.days <= 30
                              ? `Expired ${status.days} ${status.days === 1 ? 'day' : 'days'} ago`
                              : `Expired on ${status.date}`
                            : `Expires in ${status.days} ${status.days === 1 ? 'day' : 'days'}`}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                );
              })
            )}
          </div>
        ) : (
          <p className="text-xs sm:text-sm text-muted-foreground">No data</p>
        )}
      </div>

      {/* GVWR Column - Hidden on smaller screens */}
      <div className="hidden lg:flex w-16 xl:w-20 flex-shrink-0">
        <p className="text-xs sm:text-sm truncate">{formatGVWR(trailer.gvwr)}</p>
      </div>

      {/* Actions Column - Fixed */}
      <div className="w-8 sm:w-10 flex-shrink-0 flex justify-end">
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
                router.push(`/fleet/trailers/${trailer._id}`);
              }}
            >
              View Details
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                router.push(`/fleet/trailers/${trailer._id}/edit`);
              }}
            >
              Edit Trailer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
