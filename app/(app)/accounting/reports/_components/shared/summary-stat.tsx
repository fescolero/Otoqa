import { cn } from '@/lib/utils';

interface SummaryStatProps {
  label: string;
  value: string;
  className?: string;
}

export function SummaryStat({ label, value, className }: SummaryStatProps) {
  return (
    <div className={cn('space-y-0.5 min-w-0', className)}>
      <p className="text-[11px] text-muted-foreground leading-tight truncate">{label}</p>
      <p className="text-sm font-bold tracking-tight truncate">{value}</p>
    </div>
  );
}
