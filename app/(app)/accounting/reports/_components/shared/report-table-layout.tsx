import { cn } from '@/lib/utils';

interface ReportTableLayoutProps {
  children: React.ReactNode;
  sidebar: React.ReactNode;
  className?: string;
}

export function ReportTableLayout({ children, sidebar, className }: ReportTableLayoutProps) {
  return (
    <div
      className={cn(
        'grid h-full min-h-0 w-full grid-cols-1 items-stretch gap-4 xl:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_360px]',
        className,
      )}
    >
      <div className="min-w-0 min-h-0 w-full overflow-hidden">{children}</div>
      <div className="min-w-0 min-h-0 w-full overflow-hidden">{sidebar}</div>
    </div>
  );
}
