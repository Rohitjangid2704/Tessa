import { FlaskConical } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type StubModelMarkerProps = Omit<ComponentProps<"p">, "children"> & {
  compact?: boolean;
};

export function StubModelMarker({ compact = false, className, ...props }: StubModelMarkerProps) {
  return (
    <p
      data-slot="stub-model-marker"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border border-dashed border-severity-medium-fg/60 bg-severity-medium-bg px-2 py-1 text-xs font-medium text-severity-medium-fg",
        className,
      )}
      {...props}
    >
      <FlaskConical aria-hidden="true" className="size-3.5 shrink-0" />
      Stub model
      {compact ? null : (
        <span className="font-normal">
          A test seam made this result. No provider was called, so it is not a real grade.
        </span>
      )}
    </p>
  );
}
