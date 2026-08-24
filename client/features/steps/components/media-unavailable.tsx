import { ImageOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface MediaUnavailableProps {
  subject: string;
  refreshing: boolean;
  onReload: () => void;
  className?: string;
}

export function MediaUnavailable({
  subject,
  refreshing,
  onReload,
  className,
}: MediaUnavailableProps) {
  return (
    <div
      role="status"
      data-slot="media-unavailable"
      data-refreshing={refreshing}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-muted/40 p-4 text-center text-sm text-foreground",
        className,
      )}
    >
      {refreshing ? (
        <>
          <RefreshCw
            aria-hidden="true"
            className="size-5 animate-spin motion-reduce:animate-none"
          />
          <p>{`Refreshing the link to the ${subject}...`}</p>
        </>
      ) : (
        <>
          <ImageOff aria-hidden="true" className="size-5" />
          <p>{`The ${subject} could not be loaded. Its link may have expired.`}</p>
          <Button type="button" variant="outline" size="sm" onClick={onReload}>
            Try again
          </Button>
        </>
      )}
    </div>
  );
}
