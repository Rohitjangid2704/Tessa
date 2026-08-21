import { TriangleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ErrorStateProps = Omit<ComponentProps<"section">, "title"> & {
  title: string;
  description?: string;
  requestId?: string | null;
  digest?: string;
  onRetry?: () => void;
  retryLabel?: string;
  action?: ReactNode;
};

export function ErrorState({
  title,
  description,
  requestId,
  digest,
  onRetry,
  retryLabel = "Try again",
  action,
  className,
  ...props
}: ErrorStateProps) {
  return (
    <section
      role="alert"
      data-slot="error-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-destructive/30 px-6 py-16 text-center",
        className,
      )}
      {...props}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlert aria-hidden="true" className="size-6" />
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {requestId ? (
        <p className="font-mono text-xs text-muted-foreground">Request ID: {requestId}</p>
      ) : null}
      {!requestId && digest ? (
        <p className="font-mono text-xs text-muted-foreground">Reference: {digest}</p>
      ) : null}
      {onRetry ? (
        <Button variant="outline" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
      {action}
    </section>
  );
}
