'use client';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Doc } from '@/convex/_generated/dataModel';
import { Pencil, Eye, Building2, Mail, Phone } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { formatPhoneNumber, getPhoneLink } from '@/lib/format-phone';

type Customer = Doc<'customers'>;

interface CustomerListItemProps {
  customer: Customer;
  isSelected: boolean;
  onSelectionChange: (id: string, selected: boolean) => void;
}

const getStatusColor = (status: string) => {
  switch (status) {
    case 'Active':
      return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
    case 'Inactive':
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
    case 'Prospect':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200';
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
  }
};

const getCompanyTypeColor = (type: string) => {
  switch (type) {
    case 'Shipper':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
    case 'Broker':
      return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
    case 'Manufacturer':
      return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200';
    case 'Distributor':
      return 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200';
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
  }
};

export function CustomerListItem({ customer, isSelected, onSelectionChange }: CustomerListItemProps) {
  const router = useRouter();

  return (
    <div
      className={`group relative flex items-center gap-4 p-4 border rounded-lg hover:bg-accent/50 transition-colors cursor-pointer min-w-[800px] ${
        isSelected ? 'bg-blue-50 dark:bg-blue-950/20 border-blue-300 dark:border-blue-800' : ''
      }`}
      onClick={() => router.push(`/operations/customers/${customer._id}`)}
    >
      {/* Checkbox Column */}
      <div className="flex items-center w-10 flex-shrink-0">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => {
            e.stopPropagation();
            onSelectionChange(customer._id, e.target.checked);
          }}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer hover:border-gray-400 transition-colors"
        />
      </div>

      {/* Column 1: Customer Name (Wide) */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Avatar className="h-12 w-12 text-base">
          <AvatarFallback className="bg-primary text-primary-foreground">
            <Building2 className="h-6 w-6" />
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-base truncate">
              {customer.name}
            </h3>
            <Badge className={getStatusColor(customer.status)}>
              {customer.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground truncate">
            {customer.office ? `Office: ${customer.office}` : 'No office specified'}
          </p>
        </div>
      </div>

      {/* Column 2: Company Type */}
      <div className="hidden md:flex flex-col gap-1 w-[150px] flex-shrink-0">
        <Badge variant="outline" className={getCompanyTypeColor(customer.companyType)}>
          {customer.companyType}
        </Badge>
      </div>

      {/* Column 3: City, State */}
      <div className="hidden lg:flex flex-col gap-1 w-[200px] flex-shrink-0">
        <p className="text-sm font-medium">
          {customer.city}, {customer.state}
        </p>
        <p className="text-xs text-muted-foreground">{customer.country}</p>
      </div>

      {/* Column 4: Primary Contact */}
      <div className="hidden xl:flex flex-col gap-1 w-[220px] flex-shrink-0">
        {customer.primaryContactName ? (
          <>
            <p className="text-sm font-medium truncate">{customer.primaryContactName}</p>
            <div className="flex flex-col gap-0.5">
              {customer.primaryContactEmail && (
                <a
                  href={`mailto:${customer.primaryContactEmail}`}
                  className="flex items-center gap-1 text-xs hover:text-primary transition-colors truncate"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Mail className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                  <span className="truncate">{customer.primaryContactEmail}</span>
                </a>
              )}
              {customer.primaryContactPhone && (
                <a
                  href={`tel:${getPhoneLink(customer.primaryContactPhone)}`}
                  className="flex items-center gap-1 text-xs hover:text-primary transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Phone className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                  <span>{formatPhoneNumber(customer.primaryContactPhone)}</span>
                </a>
              )}
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">No contact specified</p>
        )}
      </div>

      {/* Column 5: Actions (Right Aligned) */}
      <div className="flex items-center gap-1 w-[180px] flex-shrink-0 justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            router.push(`/operations/customers/${customer._id}`);
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
            router.push(`/operations/customers/${customer._id}/edit`);
          }}
          className="h-8 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Pencil className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
