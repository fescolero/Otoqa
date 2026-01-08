import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type BadgeType = 'CONTRACT' | 'SPOT' | 'UNMAPPED' | 'status';
type StatusValue = 'PAID' | 'PENDING_PAYMENT' | 'VOID' | 'DRAFT' | 'BILLED' | 'MISSING_DATA';

interface InvoiceStatusBadgeProps {
  type: BadgeType;
  value: string;
  className?: string;
}

export function InvoiceStatusBadge({ type, value, className }: InvoiceStatusBadgeProps) {
  const getStyles = () => {
    // Load type badges
    if (type === 'CONTRACT') {
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300 border-blue-200 dark:border-blue-800';
    }
    if (type === 'SPOT') {
      return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300 border-purple-200 dark:border-purple-800';
    }
    if (type === 'UNMAPPED') {
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700';
    }

    // Status badges
    if (type === 'status') {
      switch (value as StatusValue) {
        case 'PAID':
          return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300 border-green-200 dark:border-green-800';
        case 'PENDING_PAYMENT':
          return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800';
        case 'VOID':
          return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300 border-red-200 dark:border-red-800';
        case 'DRAFT':
          return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700';
        case 'BILLED':
          return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300 border-blue-200 dark:border-blue-800';
        case 'MISSING_DATA':
          return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300 border-orange-200 dark:border-orange-800';
        default:
          return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700';
      }
    }

    return '';
  };

  const formatValue = () => {
    if (type === 'status') {
      // Make status values more readable
      return value.replace(/_/g, ' ');
    }
    return value;
  };

  return (
    <Badge 
      variant="outline" 
      className={cn(
        'rounded-full px-3 py-0.5 text-[10px] font-medium border tracking-wide',
        getStyles(),
        className
      )}
    >
      {formatValue()}
    </Badge>
  );
}
