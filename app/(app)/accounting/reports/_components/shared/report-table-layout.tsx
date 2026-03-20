import { cn } from '@/lib/utils';

interface ReportTableLayoutProps {
  children: React.ReactNode;
  sidebar: React.ReactNode;
  className?: string;
}

export function ReportTableLayout({ children, sidebar, className }: ReportTableLayoutProps) {
  return (
    <div className={cn('grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-6 items-start', className)}>
      <div className="min-w-0 overflow-hidden">{children}</div>
      <div className="min-w-0 overflow-hidden">{sidebar}</div>
    </div>
  );
}
