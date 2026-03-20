import { cn } from '@/lib/utils';

interface ReportTableLayoutProps {
  children: React.ReactNode;
  sidebar: React.ReactNode;
  className?: string;
}

export function ReportTableLayout({ children, sidebar, className }: ReportTableLayoutProps) {
  return (
    <div className={cn('grid min-h-full grid-cols-1 items-start gap-6 xl:grid-cols-[1fr_380px]', className)}>
      <div className="min-w-0 overflow-hidden">{children}</div>
      <div className="min-w-0 overflow-hidden">{sidebar}</div>
    </div>
  );
}
