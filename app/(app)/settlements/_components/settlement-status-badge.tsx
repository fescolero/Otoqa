import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type StatusValue = 'DRAFT' | 'PENDING' | 'APPROVED' | 'PAID' | 'VOID';

interface SettlementStatusBadgeProps {
  status: StatusValue;
  className?: string;
}

// Display-friendly labels
const statusLabels: Record<StatusValue, string> = {
  DRAFT: 'Draft',
  PENDING: 'Pending',
  APPROVED: 'Approved',
  PAID: 'Paid',
  VOID: 'Void',
};

export function SettlementStatusBadge({ status, className }: SettlementStatusBadgeProps) {
  const getStyles = () => {
    switch (status) {
      case 'DRAFT':
        return 'bg-slate-100 text-slate-700 border-slate-200';
      case 'PENDING':
        return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'APPROVED':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'PAID':
        return 'bg-green-100 text-green-800 border-green-200';
      case 'VOID':
        return 'bg-red-100 text-red-800 border-red-200';
      default:
        return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  return (
    <Badge 
      variant="outline" 
      className={cn(
        'rounded-md px-2 py-0.5 text-xs font-medium border',
        getStyles(),
        className
      )}
    >
      {statusLabels[status] || status}
    </Badge>
  );
}

