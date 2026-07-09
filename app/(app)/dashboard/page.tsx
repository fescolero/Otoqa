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
        <div className="bg-muted/50 min-h-[100vh] flex-1 rounded-xl md:min-h-min flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-2xl font-bold mb-2">Welcome!</h2>
            <p className="text-muted-foreground">Your dashboard is ready to be customized.</p>
          </div>
        </div>
      </div>
    </>
  );
}
