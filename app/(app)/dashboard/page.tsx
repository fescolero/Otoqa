import { RecentActivityFeed } from '@/components/audit/recent-activity-feed';

export default function Page() {
  return (
    <>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="grid auto-rows-min gap-4 md:grid-cols-3">
          <div className="bg-muted/50 aspect-video rounded-xl flex items-center justify-center">
            <p className="text-muted-foreground">Chart 1</p>
          </div>
          <div className="bg-muted/50 aspect-video rounded-xl flex items-center justify-center">
            <p className="text-muted-foreground">Chart 2</p>
          </div>
          <div className="bg-muted/50 aspect-video rounded-xl flex items-center justify-center">
            <p className="text-muted-foreground">Chart 3</p>
          </div>
        </div>
        <RecentActivityFeed hours={24} />
      </div>
    </>
  );
}
