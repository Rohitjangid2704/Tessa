import { Skeleton } from "@/components/ui/skeleton";

const SKELETON_ROWS = 8;
const SKELETON_COLUMNS = 6;
const TEMPLATE = `minmax(14rem, 18rem) repeat(${SKELETON_COLUMNS}, minmax(7.5rem, 1fr))`;

export function CoverageSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      data-slot="coverage-skeleton"
      className="flex flex-col gap-4"
    >
      <span className="sr-only">Loading the coverage map. The first read can take a moment.</span>
      <div aria-hidden="true" className="flex flex-wrap gap-2">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-7 w-28 rounded-4xl" />
        ))}
      </div>
      <div aria-hidden="true" className="flex flex-col gap-1 rounded-lg border p-1">
        <div className="grid gap-1" style={{ gridTemplateColumns: TEMPLATE }}>
          {Array.from({ length: SKELETON_COLUMNS + 1 }, (_, index) => (
            <Skeleton key={index} className="h-9" />
          ))}
        </div>
        {Array.from({ length: SKELETON_ROWS }, (_, row) => (
          <div key={row} className="grid gap-1" style={{ gridTemplateColumns: TEMPLATE }}>
            {Array.from({ length: SKELETON_COLUMNS + 1 }, (_, column) => (
              <Skeleton key={column} className="h-12" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
