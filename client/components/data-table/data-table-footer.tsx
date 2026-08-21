import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface DataTableFooterProps {
  noun: string;
  nounPlural?: string;
  loadedCount: number;
  total?: number | null;
  hasNextPage: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore: () => void;
  className?: string;
}

function describeCount(props: DataTableFooterProps): string {
  const { noun, nounPlural = `${noun}s`, loadedCount, total, hasNextPage } = props;
  const unit = (count: number) => (count === 1 ? noun : nounPlural);
  if (total !== null && total !== undefined) {
    return `Showing ${loadedCount} of ${total} ${unit(total)}`;
  }
  return hasNextPage
    ? `Showing the first ${loadedCount} ${unit(loadedCount)}`
    : `Showing all ${loadedCount} ${unit(loadedCount)}`;
}

export function DataTableFooter(props: DataTableFooterProps) {
  const { hasNextPage, isFetchingNextPage = false, onLoadMore, loadedCount, className } = props;
  if (loadedCount === 0 && !hasNextPage) {
    return null;
  }
  return (
    <div
      data-slot="data-table-footer"
      className={cn("flex items-center justify-between gap-3 text-sm", className)}
    >
      <p role="status" aria-live="polite" className="text-muted-foreground">
        {describeCount(props)}
      </p>
      {hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          disabled={isFetchingNextPage}
          aria-busy={isFetchingNextPage}
          onClick={onLoadMore}
        >
          {isFetchingNextPage ? "Loading more" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
