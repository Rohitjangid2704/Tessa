import { Skeleton } from "@/components/ui/skeleton";

export default function TargetLoading() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">Loading the target</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-9 w-72 max-w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
