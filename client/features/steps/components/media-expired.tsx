import { ArchiveX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const MEDIA_EXPIRED_TITLE = "Expired by retention policy";

export interface MediaExpiredProps {
  subject: string;
  onRecheck: () => void;
  className?: string;
}

export function MediaExpired({ subject, onRecheck, className }: MediaExpiredProps) {
  return (
    <div
      role="status"
      data-slot="media-expired"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-muted/40 p-4 text-center text-sm text-foreground",
        className,
      )}
    >
      <ArchiveX aria-hidden="true" className="size-5" />
      <p className="font-medium">{MEDIA_EXPIRED_TITLE}</p>
      <p className="text-muted-foreground">
        {`The ${subject} was deleted after the artifact retention window. The step record is kept.`}
      </p>
      <Button type="button" variant="ghost" size="sm" onClick={onRecheck}>
        Check again
      </Button>
    </div>
  );
}
